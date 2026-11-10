/**
 * OpenAI-Compatible Provider Model Info Tests
 *
 * Each value resolves declared, then endpoint, then name inference, then the
 * conservative default, and the `*Source` fields say which one answered.
 *
 * The endpoint's real window beats the 8192 default whenever the /models
 * listing carries metadata: vLLM exposes `max_model_len`; llama.cpp exposes
 * `meta.n_ctx_train`. Capabilities are almost never on `/v1/models`, so name
 * inference is the last resort before the `completion` baseline.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
    OpenAICompatibleClient,
    inferOpenAICompatCapabilities,
} from '../../providers/openai.js';
import type { LLMClientOptions } from '../../interfaces.js';
import { AIModelApiType } from '../../interfaces.js';

function createClient(overrides?: Partial<LLMClientOptions>): OpenAICompatibleClient {
    return new OpenAICompatibleClient({
        model: 'gemma-4-26b-a4b-nvfp4',
        url: 'http://localhost:8010/v1',
        apiType: AIModelApiType.OpenAI,
        ...overrides,
    });
}

describe('inferOpenAICompatCapabilities', () => {
    test('tags gemma-4 (vLLM served id) as vision + tools', () => {
        expect(inferOpenAICompatCapabilities('gemma-4-26b-a4b-nvfp4')).toEqual(
            expect.arrayContaining(['completion', 'vision', 'tools']),
        );
    });

    test('tags gemma4 ollama-style ids as vision', () => {
        expect(inferOpenAICompatCapabilities('gemma4:26b-a4b-it-qat')).toContain('vision');
    });

    test('does not invent vision for plain text chat models', () => {
        expect(inferOpenAICompatCapabilities('minimax-m3')).not.toContain('vision');
        expect(inferOpenAICompatCapabilities('deepseek-v3')).not.toContain('vision');
    });

    test('tags Qwen 3.5+ (natively multimodal) as vision; original Qwen3 stays text-only', () => {
        // qwen3.8 on vLLM answers image_url with no -VL suffix (probed live);
        // without this tag the capability list omits vision and callers strip
        // images before the request ever reaches the server.
        expect(inferOpenAICompatCapabilities('qwen3.8-27b-nvfp4')).toContain('vision');
        expect(inferOpenAICompatCapabilities('Qwen/Qwen3.8-27B-NVFP4')).toContain('vision');
        expect(inferOpenAICompatCapabilities('qwen3.6-32b')).toContain('vision');
        expect(inferOpenAICompatCapabilities('qwen3:4b')).not.toContain('vision');
        expect(inferOpenAICompatCapabilities('Qwen/Qwen3-32B')).not.toContain('vision');
    });
});

describe('OpenAICompatibleClient getModelInfo', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function mockModels(data: unknown, status = 200): { calls: () => number } {
        let calls = 0;
        globalThis.fetch = mock(async () => {
            calls++;
            return new Response(JSON.stringify({ object: 'list', data }), {
                status,
                headers: { 'content-type': 'application/json' },
            });
        }) as unknown as typeof globalThis.fetch;
        return { calls: () => calls };
    }

    test('reads vLLM max_model_len for the served model', async () => {
        mockModels([{ id: 'gemma-4-26b-a4b-nvfp4', object: 'model', max_model_len: 32768 }]);
        const client = createClient();
        const info = await client.getModelInfo();
        expect(info.contextLength).toBe(32768);
        expect(info.contextLengthSource).toBe('endpoint');
    });

    test('attaches vision capability for gemma-4 even when /models has no modalities', async () => {
        mockModels([{ id: 'gemma-4-26b-a4b-nvfp4', object: 'model', max_model_len: 131072 }]);
        const client = createClient();
        const info = await client.getModelInfo();
        expect(info.contextLength).toBe(131072);
        expect(info.capabilities).toContain('vision');
        expect(info.capabilities).toContain('tools');
        expect(info.capabilitiesSource).toBe('inferred');
    });

    test('reads llama.cpp meta.n_ctx_train when max_model_len is absent', async () => {
        mockModels([{ id: 'gemma-4-26b-a4b-nvfp4', object: 'model', meta: { n_ctx_train: 131072 } }]);
        const client = createClient();
        const info = await client.getModelInfo();
        expect(info.contextLength).toBe(131072);
        expect(info.capabilities).toContain('vision');
    });

    test('reads xAI-style context_length when max_model_len is absent', async () => {
        // SuperGrok / api.x.ai advertise context_length (500k–1M). Missing this
        // field left every Grok model at the 8192 fallback in the Canvas meter.
        mockModels([{ id: 'grok-4.5', object: 'model', context_length: 500_000 }]);
        const client = createClient({ model: 'grok-4.5', url: 'https://api.x.ai/v1' });
        const info = await client.getModelInfo();
        expect(info.contextLength).toBe(500_000);
    });

    test('caches the probe per model id', async () => {
        const probe = mockModels([{ id: 'gemma-4-26b-a4b-nvfp4', object: 'model', max_model_len: 32768 }]);
        const client = createClient();
        await client.getModelInfo();
        await client.getModelInfo();
        expect(probe.calls()).toBe(1);
    });

    test('falls back to the conservative default when the endpoint has no metadata', async () => {
        mockModels([{ id: 'gemma-4-26b-a4b-nvfp4', object: 'model' }]);
        const client = createClient();
        const info = await client.getModelInfo();
        expect(info.contextLength).toBe(8192);
        expect(info.contextLengthSource).toBe('assumed');
        expect(info.capabilities).toContain('vision');
        expect(info.capabilitiesSource).toBe('inferred');
    });

    test('falls back to the conservative default when the probe fails', async () => {
        globalThis.fetch = mock(async () => {
            throw new Error('connection refused');
        }) as unknown as typeof globalThis.fetch;
        const client = createClient();
        const info = await client.getModelInfo();
        expect(info.contextLength).toBe(8192);
        expect(info.contextLengthSource).toBe('assumed');
        expect(info.capabilities).toContain('vision');
    });

    test('marks the completion-only baseline as assumed when no name rule matches', async () => {
        mockModels([{ id: 'house-model', object: 'model', max_model_len: 16384 }]);
        const info = await createClient({ model: 'house-model' }).getModelInfo();
        expect(info.capabilities).toEqual(['completion']);
        expect(info.capabilitiesSource).toBe('assumed');
        expect(info.contextLengthSource).toBe('endpoint');
    });

    test('a declared contextLength wins over the endpoint window', async () => {
        mockModels([{ id: 'gemma-4-26b-a4b-nvfp4', object: 'model', max_model_len: 131072 }]);
        const info = await createClient({ contextLength: 32768 }).getModelInfo();
        expect(info.contextLength).toBe(32768);
        expect(info.contextLengthSource).toBe('declared');
        // Capabilities were not declared, so inference still answers them.
        expect(info.capabilitiesSource).toBe('inferred');
    });

    test('declared capabilities replace the name inference', async () => {
        mockModels([{ id: 'gemma-4-26b-a4b-nvfp4', object: 'model', max_model_len: 131072 }]);
        const info = await createClient({ capabilities: ['tools'] }).getModelInfo();
        expect(info.capabilities).toEqual(['tools']);
        expect(info.capabilitiesSource).toBe('declared');
        expect(info.contextLength).toBe(131072);
        expect(info.contextLengthSource).toBe('endpoint');
    });

    test('declared values describe a model no name rule knows', async () => {
        mockModels([{ id: 'house-model', object: 'model' }]);
        const info = await createClient({
            model: 'house-model',
            contextLength: 65536,
            capabilities: ['completion', 'vision', 'tools'],
        }).getModelInfo();
        expect(info).toMatchObject({
            model: 'house-model',
            contextLength: 65536,
            contextLengthSource: 'declared',
            capabilities: ['completion', 'vision', 'tools'],
            capabilitiesSource: 'declared',
        });
    });

    test('does not probe /models when both values are declared', async () => {
        const probe = mockModels([{ id: 'gemma-4-26b-a4b-nvfp4', object: 'model', max_model_len: 131072 }]);
        const info = await createClient({ contextLength: 4096, capabilities: [] }).getModelInfo();
        expect(probe.calls()).toBe(0);
        expect(info.contextLength).toBe(4096);
        expect(info.capabilities).toEqual([]);
        expect(info.capabilitiesSource).toBe('declared');
    });

    test('declared values describe the configured model only', async () => {
        mockModels([
            { id: 'gemma-4-26b-a4b-nvfp4', object: 'model', max_model_len: 131072 },
            { id: 'other-model', object: 'model', max_model_len: 16384 },
        ]);
        const client = createClient({ contextLength: 32768, capabilities: ['tools'] });
        const other = await client.getModelInfo('other-model');
        expect(other.contextLength).toBe(16384);
        expect(other.contextLengthSource).toBe('endpoint');
        expect(other.capabilitiesSource).not.toBe('declared');
        const own = await client.getModelInfo('gemma-4-26b-a4b-nvfp4');
        expect(own.contextLengthSource).toBe('declared');
    });

    test('the endpoint probe is shared with output bounding (one /models call)', async () => {
        let modelsCalls = 0;
        globalThis.fetch = mock(async (input: string | URL | Request) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.endsWith('/models')) {
                modelsCalls++;
                return new Response(
                    JSON.stringify({ object: 'list', data: [{ id: 'gemma-4-26b-a4b-nvfp4', max_model_len: 32768 }] }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }
            return new Response(
                JSON.stringify({
                    id: 'c1',
                    object: 'chat.completion',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }) as unknown as typeof globalThis.fetch;
        const client = createClient({ thinking: false });
        await client.chat([{ role: 'user', content: 'hi' }]);
        const info = await client.getModelInfo();
        expect(info.contextLength).toBe(32768);
        expect(modelsCalls).toBe(1);
    });
});

describe('OpenAICompatibleClient getModels', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('returns the ids the endpoint lists', async () => {
        globalThis.fetch = mock(async () =>
            new Response(JSON.stringify({ object: 'list', data: [{ id: 'served-a' }, { id: 'served-b' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        ) as unknown as typeof globalThis.fetch;
        expect(await createClient().getModels()).toEqual(['served-a', 'served-b']);
    });

    test('an HTTP error rejects instead of reading as an empty list', async () => {
        globalThis.fetch = mock(async () =>
            new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
                status: 401,
                headers: { 'content-type': 'application/json' },
            }),
        ) as unknown as typeof globalThis.fetch;
        await expect(createClient().getModels()).rejects.toThrow();
    });

    test('a network failure rejects', async () => {
        globalThis.fetch = mock(async () => {
            throw new Error('connection refused');
        }) as unknown as typeof globalThis.fetch;
        await expect(createClient().getModels()).rejects.toThrow('connection refused');
    });
});
