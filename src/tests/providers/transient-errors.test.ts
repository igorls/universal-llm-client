/**
 * Provider transient errors: Anthropic stream `error` events become typed
 * provider errors (message unchanged; overloaded_error is a 529 provider
 * error), and Google Flex retries what the shared classifier calls transient.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { AnthropicClient, anthropicStreamError } from '../../providers/anthropic.js';
import { GoogleClient } from '../../providers/google.js';
import { AIModelApiType } from '../../interfaces.js';
import { LLMHttpError, LLMProviderError, classifyFailure } from '../../errors.js';
import { classifyTransient } from '../../retry.js';

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

function sse(events: Array<Record<string, unknown>>): string {
    return events.map(e => `event: ${e['type']}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

async function streamError(type: string, message: string): Promise<unknown> {
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
        if (!init?.body) {
            return new Response(JSON.stringify({ id: 'claude-sonnet-4-5', type: 'model' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(sse([
            { type: 'message_start', message: { id: 'm', usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: 'error', error: { type, message } },
        ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const client = new AnthropicClient({ model: 'claude-sonnet-4-5', apiKey: 'k', apiType: AIModelApiType.Anthropic });
    try {
        for await (const _event of client.chatStream([{ role: 'user', content: 'hi' }])) { /* drain */ }
        return null;
    } catch (error) {
        return error;
    }
}

describe('Anthropic stream error events', () => {
    test('overloaded_error is a retryable 529 provider error with the same message', async () => {
        const error = await streamError('overloaded_error', 'Overloaded');
        expect(error).toBeInstanceOf(LLMProviderError);
        const e = error as LLMProviderError;
        expect(e.message).toBe('Anthropic stream error: overloaded_error — Overloaded');
        expect(e.provider).toBe('anthropic');
        expect(e.errorType).toBe('overloaded_error');
        expect(e.status).toBe(529);
        expect(e.retryable).toBe(true);
        expect(classifyTransient(e)).toMatchObject({ retry: true, kind: 'provider_error', status: 529 });
        expect(classifyFailure(e)).toEqual({ retry: true, cooldown: false });
    });

    test('api_error is a retryable 500', async () => {
        const e = (await streamError('api_error', 'Internal server error')) as LLMProviderError;
        expect(e).toBeInstanceOf(LLMProviderError);
        expect(e.status).toBe(500);
        expect(classifyTransient(e)).toMatchObject({ retry: true, kind: 'provider_error' });
    });

    test('rate_limit_error is a 429: rate limited, and the router cools the node down', () => {
        const e = anthropicStreamError('rate_limit_error', 'slow') as LLMProviderError;
        expect(e.status).toBe(429);
        expect(e.retryable).toBe(false);
        expect(classifyTransient(e)).toMatchObject({ kind: 'rate_limited' });
        expect(classifyFailure(e)).toEqual({ retry: false, cooldown: true });
    });

    test('invalid_request_error is terminal and does not cool the node down', () => {
        const e = anthropicStreamError('invalid_request_error', 'bad') as LLMProviderError;
        expect(classifyTransient(e)).toMatchObject({ retry: false, kind: 'terminal' });
        expect(classifyFailure(e)).toEqual({ retry: false, cooldown: false });
    });

    test('an unknown type stays a plain Error with the same message', async () => {
        const error = await streamError('brand_new_error', 'what');
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(LLMProviderError);
        expect((error as Error).message).toBe('Anthropic stream error: brand_new_error — what');
        expect(classifyFailure(error)).toEqual({ retry: true, cooldown: false });
    });
});

describe('Google Flex retry', () => {
    const okBody = { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] };

    function flexClient(): GoogleClient {
        const client = new GoogleClient({ model: 'gemini-3-flash', apiKey: 'k', apiType: AIModelApiType.Google });
        (client as unknown as { flexRetryBaseMs: number }).flexRetryBaseMs = 1;
        return client;
    }

    function serve(statuses: Array<number | { status: number; headers: Record<string, string> }>) {
        let calls = 0;
        globalThis.fetch = mock(async () => {
            const next = statuses[calls++];
            if (next === undefined) return new Response(JSON.stringify(okBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
            const { status, headers } = typeof next === 'number' ? { status: next, headers: {} } : next;
            return new Response('{"error":{"message":"busy"}}', { status, headers });
        }) as unknown as typeof fetch;
        return () => calls;
    }

    test('a 500 is retried (it used to fail at once)', async () => {
        const calls = serve([500]);
        const res = await flexClient().chat([{ role: 'user', content: 'hi' }], { serviceTier: 'flex' });
        expect(res.message.content).toBe('ok');
        expect(calls()).toBe(2);
    });

    test('503 and 429 are still retried', async () => {
        const calls = serve([503, 429]);
        await flexClient().chat([{ role: 'user', content: 'hi' }], { serviceTier: 'flex' });
        expect(calls()).toBe(3);
    });

    test('a 400 is not retried', async () => {
        const calls = serve([400]);
        await expect(flexClient().chat([{ role: 'user', content: 'hi' }], { serviceTier: 'flex' })).rejects.toBeInstanceOf(LLMHttpError);
        expect(calls()).toBe(1);
    });

    test('a Retry-After past a minute is not retried early', async () => {
        const calls = serve([{ status: 503, headers: { 'Retry-After': '600' } }]);
        await expect(flexClient().chat([{ role: 'user', content: 'hi' }], { serviceTier: 'flex' })).rejects.toBeInstanceOf(LLMHttpError);
        expect(calls()).toBe(1);
    });

    test('the standard tier does not retry', async () => {
        const calls = serve([500]);
        await expect(flexClient().chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(LLMHttpError);
        expect(calls()).toBe(1);
    });
});
