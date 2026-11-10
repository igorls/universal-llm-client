/**
 * Model info sources: declared, then endpoint, then name inference, then an
 * assumed default — and the `contextLengthSource` / `capabilitiesSource`
 * fields that say which one answered.
 *
 * Per-client cases for the OpenAI-compatible, Anthropic and Responses clients
 * live next to their other tests. This file covers Ollama, Google (which
 * inherits the base client's answer), the `AIModel` config plumbing, and the
 * aggregate model listing when one provider's listing fails.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OllamaClient } from '../providers/ollama.js';
import { GoogleClient } from '../providers/google.js';
import { AIModel, AIModelApiType } from '../index.js';
import type { LLMClientOptions } from '../interfaces.js';

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Route a mocked fetch by URL suffix; unknown paths answer 404. */
function mockRoutes(routes: Record<string, () => Response>): string[] {
    const seen: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        seen.push(url);
        for (const [suffix, respond] of Object.entries(routes)) {
            if (url.split('?')[0]!.endsWith(suffix)) return respond();
        }
        return json({ error: 'not found' }, 404);
    }) as unknown as typeof fetch;
    return seen;
}

// ============================================================================
// Ollama
// ============================================================================

describe('OllamaClient getModelInfo sources', () => {
    function ollama(overrides?: Partial<LLMClientOptions>): OllamaClient {
        return new OllamaClient({
            model: 'test-model',
            url: 'http://localhost:11434',
            apiType: AIModelApiType.Ollama,
            ...overrides,
        });
    }

    const show = () => json({
        model_info: {
            'general.architecture': 'gemma4',
            'gemma4.context_length': 131072,
            'general.parameter_count': 26_000_000_000,
        },
        capabilities: ['completion', 'vision', 'tools'],
    });

    test('values read from /api/show are marked endpoint', async () => {
        mockRoutes({ '/api/show': show, '/api/ps': () => json({ models: [] }) });
        const info = await ollama().getModelInfo();
        expect(info).toMatchObject({
            model: 'test-model',
            contextLength: 131072,
            contextLengthSource: 'endpoint',
            capabilities: ['completion', 'vision', 'tools'],
            capabilitiesSource: 'endpoint',
            architecture: 'gemma4',
        });
    });

    test('declared values win over /api/show; the rest still comes from the endpoint', async () => {
        mockRoutes({ '/api/show': show, '/api/ps': () => json({ models: [] }) });
        const info = await ollama({ contextLength: 32768, capabilities: ['completion'] }).getModelInfo();
        expect(info).toMatchObject({
            contextLength: 32768,
            contextLengthSource: 'declared',
            capabilities: ['completion'],
            capabilitiesSource: 'declared',
            architecture: 'gemma4',
            parameterCount: 26_000_000_000,
        });
    });

    test('a declared contextLength alone leaves the capabilities to the endpoint', async () => {
        mockRoutes({ '/api/show': show, '/api/ps': () => json({ models: [] }) });
        const info = await ollama({ contextLength: 32768 }).getModelInfo();
        expect(info.contextLengthSource).toBe('declared');
        expect(info.capabilitiesSource).toBe('endpoint');
    });

    test('a live window from /api/ps counts as endpoint even when /api/show has none', async () => {
        mockRoutes({
            '/api/show': () => json({ model_info: { 'general.architecture': 'mystery' } }),
            '/api/ps': () => json({ models: [{ name: 'test-model', context_length: 40960 }] }),
        });
        const info = await ollama().getModelInfo();
        expect(info.contextLength).toBe(40960);
        expect(info.contextLengthSource).toBe('endpoint');
    });

    test('with no window anywhere the default is marked assumed', async () => {
        mockRoutes({
            '/api/show': () => json({ model_info: { 'general.architecture': 'mystery' } }),
            '/api/ps': () => json({ models: [] }),
        });
        const info = await ollama().getModelInfo();
        expect(info.contextLength).toBe(8192);
        expect(info.contextLengthSource).toBe('assumed');
        expect(info.capabilities).toBeUndefined();
        expect(info.capabilitiesSource).toBeUndefined();
    });

    test('an unreachable endpoint gives the assumed default, or the declared values', async () => {
        globalThis.fetch = mock(async () => {
            throw new Error('connection refused');
        }) as unknown as typeof fetch;

        expect(await ollama().getModelInfo()).toEqual({ contextLength: 8192, contextLengthSource: 'assumed' });

        const declared = await ollama({ contextLength: 16384, capabilities: ['tools'] }).getModelInfo();
        expect(declared).toMatchObject({
            contextLength: 16384,
            contextLengthSource: 'declared',
            capabilities: ['tools'],
            capabilitiesSource: 'declared',
        });
    });

    test('declared values do not describe another model', async () => {
        mockRoutes({ '/api/show': show, '/api/ps': () => json({ models: [] }) });
        const info = await ollama({ contextLength: 32768, capabilities: ['completion'] }).getModelInfo('other-model');
        expect(info.contextLengthSource).toBe('endpoint');
        expect(info.capabilitiesSource).toBe('endpoint');
    });
});

// ============================================================================
// Google (inherits the base client's answer)
// ============================================================================

describe('GoogleClient getModelInfo sources', () => {
    function google(overrides?: Partial<LLMClientOptions>): GoogleClient {
        return new GoogleClient({
            model: 'model-id',
            apiKey: 'test-api-key',
            apiType: AIModelApiType.Google,
            ...overrides,
        });
    }

    test('reports the conservative default, marked assumed, without a request', async () => {
        const seen = mockRoutes({});
        const info = await google().getModelInfo();
        expect(info).toEqual({ contextLength: 8192, contextLengthSource: 'assumed' });
        expect(seen).toEqual([]);
    });

    test('reports a declared contextLength', async () => {
        const info = await google({ contextLength: 1_000_000 }).getModelInfo();
        expect(info.contextLength).toBe(1_000_000);
        expect(info.contextLengthSource).toBe('declared');
    });

    test('reports declared capabilities', async () => {
        const info = await google({ capabilities: ['tools', 'vision'] }).getModelInfo();
        expect(info.capabilities).toEqual(['tools', 'vision']);
        expect(info.capabilitiesSource).toBe('declared');
        expect(info.contextLengthSource).toBe('assumed');
    });

    test('declared values do not describe another model', async () => {
        const info = await google({ contextLength: 1_000_000 }).getModelInfo('other-model');
        expect(info.contextLengthSource).toBe('assumed');
    });

    test('the declared list is a copy, so editing the result does not change config', async () => {
        const capabilities = ['tools'];
        const client = google({ capabilities });
        (await client.getModelInfo()).capabilities!.push('vision');
        expect((await client.getModelInfo()).capabilities).toEqual(['tools']);
        expect(capabilities).toEqual(['tools']);
    });
});

// ============================================================================
// AIModel config plumbing
// ============================================================================

describe('AIModel declared model info', () => {
    // Anthropic answers getModelInfo() from config alone, so these isolate
    // the plumbing; the listing route only serves the router's cold probe.
    const listing = () => json({ data: [] });

    test('model-level capabilities and contextLength reach the client', async () => {
        mockRoutes({ '/v1/models': listing });
        const model = new AIModel({
            model: 'model-id',
            capabilities: ['tools'],
            contextLength: 64_000,
            providers: [{ type: 'anthropic', apiKey: 'k' }],
        });
        const info = await model.getModelInfo();
        expect(info).toMatchObject({
            capabilities: ['tools'],
            capabilitiesSource: 'declared',
            contextLength: 64_000,
            contextLengthSource: 'declared',
        });
        await model.dispose();
    });

    test('a provider value wins over the model-level value', async () => {
        mockRoutes({ '/v1/models': listing });
        const model = new AIModel({
            model: 'model-id',
            capabilities: ['tools'],
            contextLength: 64_000,
            providers: [{ type: 'anthropic', apiKey: 'k', capabilities: ['vision'], contextLength: 32_000 }],
        });
        const info = await model.getModelInfo();
        expect(info.capabilities).toEqual(['vision']);
        expect(info.contextLength).toBe(32_000);
        await model.dispose();
    });

    test('without declarations the client reports its own sources', async () => {
        mockRoutes({ '/v1/models': listing });
        const model = new AIModel({ model: 'model-id', providers: [{ type: 'anthropic', apiKey: 'k' }] });
        const info = await model.getModelInfo();
        expect(info.contextLengthSource).toBe('assumed');
        expect(info.capabilitiesSource).toBe('assumed');
        await model.dispose();
    });
});

// ============================================================================
// Aggregate model listing
// ============================================================================

describe('AIModel.getModels with a failing provider', () => {
    test('skips the provider whose listing fails and adds no made-up ids', async () => {
        mockRoutes({
            'api.anthropic.com/v1/models': () => json({ type: 'error', error: { message: 'down' } }, 500),
            'localhost:8000/v1/models': () => json({ object: 'list', data: [{ id: 'served-model' }] }),
        });
        const model = new AIModel({
            model: 'model-id',
            providers: [
                { type: 'anthropic', apiKey: 'k' },
                { type: 'openai', url: 'http://localhost:8000' },
            ],
            retries: 0,
        });
        expect(await model.getModels()).toEqual(['served-model']);
        await model.dispose();
    });
});
