/**
 * Anthropic Provider — unified thinking flag tests.
 *
 * Validates that the model-level `thinking` config and per-call
 * `ChatOptions.thinking` map to Anthropic extended thinking
 * (`thinking: { type: 'enabled', budget_tokens }`), with the API's
 * constraints handled (budget < max_tokens; temperature omitted when on).
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
