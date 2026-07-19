/**
 * OpenAI-Compatible Provider Model Info Tests
 *
 * getModelInfo must report the endpoint's real context window instead of the
 * conservative 8192 default whenever the /models listing carries metadata:
 * vLLM exposes `max_model_len`; llama.cpp exposes `meta.n_ctx_train`.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OpenAICompatibleClient } from '../../providers/openai.js';
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
    });

    test('reads llama.cpp meta.n_ctx_train when max_model_len is absent', async () => {
        mockModels([{ id: 'gemma-4-26b-a4b-nvfp4', object: 'model', meta: { n_ctx_train: 131072 } }]);
        const client = createClient();
        const info = await client.getModelInfo();
        expect(info.contextLength).toBe(131072);
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
    });

    test('falls back to the conservative default when the probe fails', async () => {
        globalThis.fetch = mock(async () => {
            throw new Error('connection refused');
        }) as unknown as typeof globalThis.fetch;
        const client = createClient();
        const info = await client.getModelInfo();
        expect(info.contextLength).toBe(8192);
    });
});
