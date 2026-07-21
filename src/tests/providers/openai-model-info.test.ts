/**
 * OpenAI-Compatible Provider Model Info Tests
 *
 * getModelInfo must report the endpoint's real context window instead of the
 * conservative 8192 default whenever the /models listing carries metadata:
 * vLLM exposes `max_model_len`; llama.cpp exposes `meta.n_ctx_train`.
 *
 * Capabilities are almost never on `/v1/models` — we infer vision/tools from
 * the model id so multimodal servers (Gemma-4 on vLLM) are not treated as
 * text-only by consumers that gate on `capabilities.includes("vision")`.
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
    });

    test('attaches vision capability for gemma-4 even when /models has no modalities', async () => {
        mockModels([{ id: 'gemma-4-26b-a4b-nvfp4', object: 'model', max_model_len: 131072 }]);
        const client = createClient();
        const info = await client.getModelInfo();
        expect(info.contextLength).toBe(131072);
        expect(info.capabilities).toContain('vision');
        expect(info.capabilities).toContain('tools');
    });

    test('reads llama.cpp meta.n_ctx_train when max_model_len is absent', async () => {
        mockModels([{ id: 'gemma-4-26b-a4b-nvfp4', object: 'model', meta: { n_ctx_train: 131072 } }]);
        const client = createClient();
        const info = await client.getModelInfo();
        expect(info.contextLength).toBe(131072);
        expect(info.capabilities).toContain('vision');
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
        expect(info.capabilities).toContain('vision');
    });

    test('falls back to the conservative default when the probe fails', async () => {
        globalThis.fetch = mock(async () => {
            throw new Error('connection refused');
        }) as unknown as typeof globalThis.fetch;
        const client = createClient();
        const info = await client.getModelInfo();
        expect(info.contextLength).toBe(8192);
        expect(info.capabilities).toContain('vision');
    });
});
