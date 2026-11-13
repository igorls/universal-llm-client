import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { OpenAICompatibleClient } from '../../providers/openai.js';
import { ResponsesClient } from '../../providers/openai-responses.js';
import { AIModelApiType, type ChatOptions, type LLMClientOptions } from '../../interfaces.js';

const MESSAGE = [{ role: 'user' as const, content: 'Return the fixture result.' }];
const SCHEMA = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
};
let originalFetch: typeof fetch;
let requests: Record<string, unknown>[];

beforeEach(() => {
    originalFetch = globalThis.fetch;
    requests = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        if (!init?.body) return Response.json({ data: [] });
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        requests.push(body);
        const unsupported = ['num_predict', 'num_ctx', 'keep_alive', 'format'].find((name) => body[name] !== undefined);
        if (unsupported)
            return Response.json(
                { error: { message: `Unsupported parameter: '${unsupported}'`, type: 'invalid_request_error' } },
                { status: 400 },
            );
        if (body['stream']) {
            const chunk = {
                id: 'fixture',
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content: '{"ok":true}' }, finish_reason: 'stop' }],
            };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
                headers: { 'content-type': 'text/event-stream' },
            });
        }
        return Response.json({
            id: 'fixture',
            model: 'gpt-5.6-sol',
            choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
        });
    }) as typeof fetch;
});
afterEach(() => {
    globalThis.fetch = originalFetch;
});

function client(defaultParameters: Record<string, unknown> = {}, options: Partial<LLMClientOptions> = {}) {
    return new OpenAICompatibleClient({
        model: 'gpt-5.6-sol',
        url: 'https://api.openai.com/v1',
        apiType: AIModelApiType.OpenAI,
        defaultParameters,
        ...options,
    });
}

describe('OpenAI serving parameter normalization', () => {
    test('the memory worker payload is accepted by a strict Chat Completions endpoint', async () => {
        await client().chat(MESSAGE, { parameters: { num_predict: 2048, format: SCHEMA } });
        expect(requests[0]?.['num_predict']).toBeUndefined();
        expect(requests[0]?.['format']).toBeUndefined();
        expect(requests[0]?.['max_completion_tokens']).toBe(2048);
        expect(requests[0]?.['response_format']).toEqual({
            type: 'json_schema',
            json_schema: { name: 'response', schema: SCHEMA },
        });
    });

    test('streaming also translates the legacy output bound and JSON mode', async () => {
        for await (const _event of client().chatStream(MESSAGE, { parameters: { num_predict: 512, format: 'json' } })) {
            /* drain */
        }
        expect(requests[0]?.['max_completion_tokens']).toBe(512);
        expect(requests[0]?.['response_format']).toEqual({ type: 'json_object' });
    });

    test('a per-call maxTokens wins over a legacy provider default', async () => {
        await client({ num_predict: 2048 }).chat(MESSAGE, { maxTokens: 128 });
        expect(requests[0]?.['max_completion_tokens']).toBe(128);
        expect(requests[0]?.['num_predict']).toBeUndefined();
    });

    test('an explicit native output bound wins over the legacy alias', async () => {
        await client().chat(MESSAGE, { parameters: { num_predict: 2048, max_completion_tokens: 256 } });
        expect(requests[0]?.['max_completion_tokens']).toBe(256);
        expect(requests[0]?.['max_tokens']).toBeUndefined();
    });

    test('OpenAI-compatible gateways do not receive local engine residency knobs', async () => {
        await client({ keep_alive: '30m', num_ctx: 8192 }, { url: 'https://fixture-gateway.example/v1' }).chat(
            MESSAGE,
            { parameters: { num_predict: 512 } },
        );
        expect(requests[0]?.['keep_alive']).toBeUndefined();
        expect(requests[0]?.['num_ctx']).toBeUndefined();
        expect(requests[0]?.['max_tokens']).toBe(512);
    });

    test('Ollama unbounded sentinels never become an invalid OpenAI output bound', async () => {
        await client().chat(MESSAGE, { parameters: { num_predict: -1 } });
        expect(requests[0]?.['num_predict']).toBeUndefined();
        expect(requests[0]?.['max_tokens']).toBeUndefined();
        expect(requests[0]?.['max_completion_tokens']).toBeUndefined();
    });

    test('native response format and the prompt-only override retain priority', async () => {
        const options: ChatOptions = {
            parameters: {
                format: 'json',
                response_format: { type: 'json_schema', json_schema: { name: 'native', schema: SCHEMA } },
            },
        };
        await client().chat(MESSAGE, options);
        expect(requests[0]?.['response_format']).toEqual(options.parameters?.['response_format']);
        await client({}, { omitResponseFormat: true }).chat(MESSAGE, { parameters: { format: SCHEMA } });
        expect(requests[1]?.['response_format']).toBeUndefined();
    });

    test('Responses retains its allowlisted dialect instead of leaking Ollama parameters', async () => {
        globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
            requests.push(body);
            const event = {
                type: 'response.completed',
                response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] },
            };
            return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
                headers: { 'content-type': 'text/event-stream' },
            });
        }) as typeof fetch;
        await new ResponsesClient({ model: 'gpt-5.6-sol', apiKey: 'fixture', url: 'https://api.openai.com/v1' }).chat(
            MESSAGE,
            { parameters: { num_predict: 2048, keep_alive: '1m', num_ctx: 8192 } },
        );
        expect(requests[0]?.['num_predict']).toBeUndefined();
        expect(requests[0]?.['keep_alive']).toBeUndefined();
        expect(requests[0]?.['num_ctx']).toBeUndefined();
    });
});
