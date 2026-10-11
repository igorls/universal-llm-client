/**
 * `default` — the request name NInfer answers with whichever model it loaded.
 *
 * The name carries no family, so the client learns the served id (from
 * `/models`, then from each response) and keys family rules off that:
 * Qwen sampling and the `enable_thinking` pin, vision capability, output
 * bounds. The wire `model` stays `default`, and the response reports the id
 * the server answered with.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OpenAICompatibleClient, isServedModelAlias } from '../../providers/openai.js';
import { AIModelApiType } from '../../interfaces.js';

interface Recorded {
    method: string;
    path: string;
    body?: Record<string, unknown>;
}

function client(model = 'default'): OpenAICompatibleClient {
    return new OpenAICompatibleClient({
        model,
        url: 'http://ninfer.test:8010',
        apiType: AIModelApiType.OpenAI,
    });
}

/**
 * Fake server: `/models` lists `listed()`, chat answers as `served()`.
 * Both are read per request so a test can swap the model mid-run.
 */
function fakeServer(opts: { listed: () => string[] | null; served: () => string }): Recorded[] {
    const calls: Recorded[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
        calls.push({ method, path: url.pathname, body });
        if (url.pathname.endsWith('/models')) {
            const ids = opts.listed();
            if (!ids) return new Response('down', { status: 500 });
            return Response.json({
                object: 'list',
                data: ids.map(id => ({ id, object: 'model', max_model_len: 131072, owned_by: 'ninfer' })),
            });
        }
        return Response.json({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 1,
            model: opts.served(),
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        });
    }) as unknown as typeof globalThis.fetch;
    return calls;
}

const chatBodies = (calls: Recorded[]) => calls.filter(c => c.method === 'POST').map(c => c.body!);
const modelLookups = (calls: Recorded[]) => calls.filter(c => c.path.endsWith('/models')).length;

describe('isServedModelAlias', () => {
    test('matches only the reserved name', () => {
        expect(isServedModelAlias('default')).toBe(true);
        expect(isServedModelAlias(' Default ')).toBe(true);
        expect(isServedModelAlias('qwen3.8-27b')).toBe(false);
        expect(isServedModelAlias('default-model')).toBe(false);
        expect(isServedModelAlias(undefined)).toBe(false);
    });
});

describe('OpenAICompatibleClient with model "default"', () => {
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('applies the served model family while sending "default" on the wire', async () => {
        const calls = fakeServer({
            listed: () => ['qwen3.8-flash-next', 'jev-latest'],
            served: () => 'qwen3.8-flash-next',
        });

        const response = await client().chat([{ role: 'user', content: 'hi' }]);

        const [body] = chatBodies(calls);
        expect(body!['model']).toBe('default');
        // Qwen non-thinking recipe + the thinking pin, which a bare "default" never got.
        expect(body!['top_k']).toBe(20);
        expect(body!['presence_penalty']).toBe(1.5);
        expect((body!['chat_template_kwargs'] as Record<string, unknown>)['enable_thinking']).toBe(false);
        expect(response.model).toBe('qwen3.8-flash-next');
    });

    test('follows a model swap on the server from the next call', async () => {
        let served = 'qwen3.8-flash-next';
        const calls = fakeServer({ listed: () => [served], served: () => served });
        const c = client();

        await c.chat([{ role: 'user', content: 'one' }]);
        served = 'gemma-4-26b-a4b-nvfp4';
        // This call still goes out under the old family; its response reports the swap.
        const swapped = await c.chat([{ role: 'user', content: 'two' }]);
        await c.chat([{ role: 'user', content: 'three' }]);

        expect(swapped.model).toBe('gemma-4-26b-a4b-nvfp4');
        const bodies = chatBodies(calls);
        expect(bodies[1]!['top_k']).toBe(20); // Qwen
        expect(bodies[2]!['top_k']).toBe(64); // Gemma
        expect(bodies.every(b => b['model'] === 'default')).toBe(true);
    });

    test('getModelInfo describes the served model, vision included', async () => {
        fakeServer({ listed: () => ['qwen3.8-flash-next'], served: () => 'qwen3.8-flash-next' });

        const info = await client().getModelInfo();

        expect(info.model).toBe('qwen3.8-flash-next');
        expect(info.capabilities).toContain('vision');
        expect(info.contextLength).toBe(131072);
    });

    test('a failed lookup is not repeated on every call', async () => {
        // A server that neither lists models nor names itself in responses.
        const calls = fakeServer({ listed: () => null, served: () => 'default' });
        const c = client();

        await c.chat([{ role: 'user', content: 'one' }]);
        const afterFirst = modelLookups(calls);
        const response = await c.chat([{ role: 'user', content: 'two' }]);

        expect(modelLookups(calls)).toBe(afterFirst);
        // No family is invented for an unknown model.
        expect(chatBodies(calls)[1]!['top_k']).toBeUndefined();
        expect(response.model).toBe('default');
    });

    test('a response teaches the served model when the lookup failed', async () => {
        const calls = fakeServer({ listed: () => null, served: () => 'qwen3.8-flash-next' });
        const c = client();

        await c.chat([{ role: 'user', content: 'one' }]);
        await c.chat([{ role: 'user', content: 'two' }]);

        expect(chatBodies(calls)[0]!['top_k']).toBeUndefined();
        expect(chatBodies(calls)[1]!['top_k']).toBe(20);
    });

    test('a named model is unaffected and never looked up as an alias', async () => {
        const calls = fakeServer({ listed: () => ['gemma-4-26b-a4b-nvfp4'], served: () => 'gemma-4-26b-a4b-nvfp4' });

        await client('qwen3.8-27b').chat([{ role: 'user', content: 'hi' }]);

        const [body] = chatBodies(calls);
        expect(body!['model']).toBe('qwen3.8-27b');
        expect(body!['top_k']).toBe(20); // family from the configured name, not the server's id
    });
});
