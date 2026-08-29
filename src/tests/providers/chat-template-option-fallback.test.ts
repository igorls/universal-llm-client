/**
 * Servers disagree on `chat_template_kwargs`.
 *
 * vLLM consumes `chat_template_kwargs.reasoning_effort`; ninfer rejects it with
 * HTTP 400 `chat_template_option_not_supported` and honours the TOP-LEVEL
 * `reasoning_effort` instead. Both are a bare host:port, so the difference
 * cannot be read off the URL — the client learns it from the 400 and remembers
 * it per endpoint.
 *
 * This shipped as a production incident: a thinking-ON tenant on ninfer 400'd
 * every turn, because the nested key is only added when thinking is ON and the
 * quality gate ran a thinking-OFF tenant.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OpenAICompatibleClient } from '../../providers/openai.js';
import { AIModelApiType } from '../../interfaces.js';

const REJECTION = JSON.stringify({
    error: {
        code: 'chat_template_option_not_supported',
        message: 'chat_template_kwargs.reasoning_effort is not supported',
        param: 'chat_template_kwargs',
        type: 'invalid_request_error',
    },
});

function modelsList(): Response {
    return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-27b-nvfp4' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

function okCompletion(): Response {
    return new Response(
        JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'pronto' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

describe('chat_template_kwargs option rejection', () => {
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function client(url: string): OpenAICompatibleClient {
        return new OpenAICompatibleClient({
            model: 'qwen3.8-27b-nvfp4',
            url,
            apiType: AIModelApiType.OpenAI,
            // Thinking ON is what adds the nested option in the first place —
            // the thinking-OFF path never sends it, which is exactly why the
            // thinking off missed this and thinking on hit it.
            thinking: 'low',
        });
    }

    test('retries without the rejected option and keeps the top-level one', async () => {
        const bodies: Record<string, unknown>[] = [];
        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
            if (!String(input).includes('/chat/completions')) return modelsList();
            bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
            if (bodies.length === 1) {
                return new Response(REJECTION, { status: 400, headers: { 'content-type': 'application/json' } });
            }
            return okCompletion();
        }) as unknown as typeof globalThis.fetch;

        const res = await client('http://ninfer-retry.test:8010/v1').chat([{ role: 'user', content: 'oi' }]);
        expect(res.message.content).toBe('pronto');
        expect(bodies).toHaveLength(2);

        // First attempt carried the nested option; the retry dropped only that
        // key and kept enable_thinking plus the top-level effort ninfer reads.
        const first = bodies[0]!['chat_template_kwargs'] as Record<string, unknown>;
        expect(first['reasoning_effort']).toBeDefined();
        const retry = bodies[1]!['chat_template_kwargs'] as Record<string, unknown> | undefined;
        expect(retry?.['reasoning_effort']).toBeUndefined();
        expect(retry?.['enable_thinking']).toBe(true);
        expect(bodies[1]!['reasoning_effort']).toBeDefined();
    });

    test('remembers the endpoint, so a later call never sends it again', async () => {
        const url = 'http://ninfer-memo.test:8010/v1';
        let calls = 0;
        const bodies: Record<string, unknown>[] = [];
        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
            if (!String(input).includes('/chat/completions')) return modelsList();
            bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
            calls += 1;
            // Only the very first request is rejected; if the client forgot, a
            // later call would send the bad key and this would never be hit.
            if (calls === 1) {
                return new Response(REJECTION, { status: 400, headers: { 'content-type': 'application/json' } });
            }
            return okCompletion();
        }) as unknown as typeof globalThis.fetch;

        await client(url).chat([{ role: 'user', content: 'um' }]);
        const afterFirst = bodies.length;
        await client(url).chat([{ role: 'user', content: 'dois' }]);

        // Second conversation cost exactly one request — no repeated 400.
        expect(bodies.length - afterFirst).toBe(1);
        const later = bodies.at(-1)!['chat_template_kwargs'] as Record<string, unknown> | undefined;
        expect(later?.['reasoning_effort']).toBeUndefined();
    });

    test('a server that identifies itself is never sent the option at all', async () => {
        // The /v1/models probe already runs (context-window resolution) and is
        // awaited before the first body is sent, so a self-identifying server
        // costs ZERO failed turns — no 400 is ever produced here.
        const bodies: Record<string, unknown>[] = [];
        let rejections = 0;
        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
            if (!String(input).includes('/chat/completions')) {
                return new Response(
                    JSON.stringify({ data: [{ id: 'qwen3.8-27b-nvfp4', owned_by: 'ninfer', max_model_len: 262144 }] }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }
            const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
            bodies.push(body);
            const kwargs = body['chat_template_kwargs'] as Record<string, unknown> | undefined;
            if (kwargs?.['reasoning_effort'] !== undefined) {
                rejections += 1;
                return new Response(REJECTION, { status: 400, headers: { 'content-type': 'application/json' } });
            }
            return okCompletion();
        }) as unknown as typeof globalThis.fetch;

        const res = await client('http://ninfer-identified.test:8010/v1').chat([{ role: 'user', content: 'oi' }]);
        expect(res.message.content).toBe('pronto');
        expect(rejections).toBe(0);
        expect(bodies).toHaveLength(1);
        const kwargs = bodies[0]!['chat_template_kwargs'] as Record<string, unknown> | undefined;
        expect(kwargs?.['reasoning_effort']).toBeUndefined();
        // enable_thinking and the top-level effort still go out untouched.
        expect(kwargs?.['enable_thinking']).toBe(true);
        expect(bodies[0]!['reasoning_effort']).toBeDefined();
    });

    test('an endpoint that accepts the option keeps receiving it', async () => {
        const bodies: Record<string, unknown>[] = [];
        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
            if (!String(input).includes('/chat/completions')) return modelsList();
            bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
            return okCompletion();
        }) as unknown as typeof globalThis.fetch;

        await client('http://vllm-happy.test:8015/v1').chat([{ role: 'user', content: 'oi' }]);
        expect(bodies).toHaveLength(1);
        const kwargs = bodies[0]!['chat_template_kwargs'] as Record<string, unknown>;
        expect(kwargs['reasoning_effort']).toBeDefined();
    });
});
