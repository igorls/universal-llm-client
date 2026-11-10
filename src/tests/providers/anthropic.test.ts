/**
 * Anthropic Provider — unified thinking flag, model info and model listing.
 *
 * Validates that the model-level `thinking` config and per-call
 * `ChatOptions.thinking` map to Anthropic extended thinking
 * (`thinking: { type: 'enabled', budget_tokens }`), with the API's
 * constraints handled (budget < max_tokens; temperature omitted when on).
 *
 * Model info is declared or assumed, never read from the model name, and a
 * failed listing rejects instead of returning made-up ids.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { AnthropicClient } from '../../providers/anthropic.js';
import type { LLMClientOptions } from '../../interfaces.js';
import { AIModelApiType } from '../../interfaces.js';

function createClient(overrides?: Partial<LLMClientOptions>): AnthropicClient {
    return new AnthropicClient({
        model: 'claude-sonnet-4-5',
        apiKey: 'test-api-key',
        apiType: AIModelApiType.Anthropic,
        ...overrides,
    });
}

const ANTHROPIC_RESPONSE = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hi there.' }],
    model: 'claude-sonnet-4-5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 },
};

describe('AnthropicClient thinking flag', () => {
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    function mockFetchAndCapture(response: unknown = ANTHROPIC_RESPONSE, status = 200) {
        let capturedBody: Record<string, unknown> | null = null;
        globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
            if (init?.body) capturedBody = JSON.parse(init.body as string);
            return new Response(JSON.stringify(response), {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
        }) as typeof fetch;
        return () => capturedBody;
    }

    test('enables extended thinking when thinking:true (budget < max_tokens, temperature omitted)', async () => {
        const getBody = mockFetchAndCapture();
        const client = createClient();

        await client.chat([{ role: 'user', content: 'hi' }], { thinking: true, maxTokens: 4096, temperature: 0.7 });

        const body = getBody()!;
        const thinking = body['thinking'] as Record<string, unknown> | undefined;
        expect(thinking).toBeDefined();
        expect(thinking!['type']).toBe('enabled');
        expect(thinking!['budget_tokens']).toBe(2048);
        expect(thinking!['budget_tokens'] as number).toBeLessThan(body['max_tokens'] as number);
        // The API forbids a custom temperature while thinking is on — must be omitted.
        expect(body['temperature']).toBeUndefined();
    });

    test('does not request thinking when flag is unset (temperature preserved)', async () => {
        const getBody = mockFetchAndCapture();
        const client = createClient();

        await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0.5 });

        const body = getBody()!;
        expect(body['thinking']).toBeUndefined();
        expect(body['temperature']).toBe(0.5);
    });

    test('does not request thinking when thinking:false (overrides client config)', async () => {
        const getBody = mockFetchAndCapture();
        const client = createClient({ thinking: true });

        await client.chat([{ role: 'user', content: 'hi' }], { thinking: false });

        expect(getBody()!['thinking']).toBeUndefined();
    });

    test('per-call thinking:true overrides unset client config', async () => {
        const getBody = mockFetchAndCapture();
        const client = createClient();

        await client.chat([{ role: 'user', content: 'hi' }], { thinking: true });

        expect((getBody()!['thinking'] as Record<string, unknown>)['type']).toBe('enabled');
    });

    test('maps a thinking level to budget_tokens (high, clamped < max_tokens)', async () => {
        const getBody = mockFetchAndCapture();
        const client = createClient();

        await client.chat([{ role: 'user', content: 'hi' }], { thinking: 'high', maxTokens: 32000 });

        const thinking = getBody()!['thinking'] as Record<string, unknown>;
        expect(thinking['type']).toBe('enabled');
        expect(thinking['budget_tokens']).toBe(16384);
    });

    test('bumps max_tokens so budget_tokens stays below it when maxTokens is small', async () => {
        const getBody = mockFetchAndCapture();
        const client = createClient();

        await client.chat([{ role: 'user', content: 'hi' }], { thinking: 'low', maxTokens: 1024 });

        const body = getBody()!;
        const budget = (body['thinking'] as Record<string, unknown>)['budget_tokens'] as number;
        expect(budget).toBeGreaterThanOrEqual(1024);
        expect(budget).toBeLessThan(body['max_tokens'] as number);
    });
});

describe('AnthropicClient getModelInfo', () => {
    let originalFetch: typeof globalThis.fetch;
    let fetchMock: ReturnType<typeof mock>;
    beforeEach(() => {
        originalFetch = globalThis.fetch;
        fetchMock = mock(async () => new Response('{}', { status: 200 }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
    });
    afterEach(() => { globalThis.fetch = originalFetch; });

    test('reports the protocol features and window, marked assumed, without asking the endpoint', async () => {
        const info = await createClient().getModelInfo();
        expect(info).toEqual({
            model: 'claude-sonnet-4-5',
            contextLength: 200_000,
            contextLengthSource: 'assumed',
            capabilities: ['tools', 'vision'],
            capabilitiesSource: 'assumed',
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('does not read the model name', async () => {
        const named = await createClient({ model: 'claude-opus-4-1' }).getModelInfo();
        const unnamed = await createClient({ model: 'model-id' }).getModelInfo();
        expect({ ...named, model: undefined }).toEqual({ ...unnamed, model: undefined });
        expect(named.capabilities).not.toContain('thinking');
    });

    test('reports a declared contextLength', async () => {
        const info = await createClient({ contextLength: 64_000 }).getModelInfo();
        expect(info.contextLength).toBe(64_000);
        expect(info.contextLengthSource).toBe('declared');
        expect(info.capabilitiesSource).toBe('assumed');
    });

    test('reports declared capabilities as given', async () => {
        const info = await createClient({ capabilities: ['tools', 'vision', 'thinking'] }).getModelInfo();
        expect(info.capabilities).toEqual(['tools', 'vision', 'thinking']);
        expect(info.capabilitiesSource).toBe('declared');
        expect(info.contextLengthSource).toBe('assumed');
    });

    test('declared values do not describe another model', async () => {
        const client = createClient({ contextLength: 64_000, capabilities: ['tools'] });
        const info = await client.getModelInfo('some-other-model');
        expect(info.model).toBe('some-other-model');
        expect(info.contextLengthSource).toBe('assumed');
        expect(info.capabilitiesSource).toBe('assumed');
    });
});

describe('AnthropicClient getModels', () => {
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    test('returns the ids the endpoint lists', async () => {
        globalThis.fetch = mock(async () => new Response(JSON.stringify({
            data: [{ id: 'model-a', display_name: 'A', created_at: '2026-01-01', type: 'model' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

        expect(await createClient().getModels()).toEqual(['model-a']);
    });

    test('an HTTP error rejects instead of returning made-up ids', async () => {
        globalThis.fetch = mock(async () => new Response(
            JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
        )) as unknown as typeof fetch;

        await expect(createClient().getModels()).rejects.toThrow();
    });

    test('a network failure rejects', async () => {
        globalThis.fetch = mock(async () => {
            throw new Error('connection refused');
        }) as unknown as typeof fetch;

        await expect(createClient().getModels()).rejects.toThrow('connection refused');
    });
});
