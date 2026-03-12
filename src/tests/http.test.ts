/**
 * Tests for http.ts — Universal HTTP utilities
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { httpRequest, parseNDJSON, parseSSE, buildHeaders } from '../http.js';
import { AIModelApiType } from '../interfaces.js';

describe('httpRequest', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('makes a GET request and parses JSON', async () => {
        globalThis.fetch = mock(async () =>
            new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        ) as typeof fetch;

        const result = await httpRequest<{ ok: boolean }>('http://test.com/api');
        expect(result.ok).toBe(true);
        expect(result.status).toBe(200);
        expect(result.data.ok).toBe(true);
    });

    it('makes a POST request with body', async () => {
        let capturedBody: string | undefined;
        globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
            capturedBody = init?.body as string;
            return new Response(JSON.stringify({ received: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }) as typeof fetch;

        await httpRequest('http://test.com/api', {
            method: 'POST',
            body: { message: 'hello' },
        });

        expect(capturedBody).toBe(JSON.stringify({ message: 'hello' }));
    });

    it('throws on non-OK response', async () => {
        globalThis.fetch = mock(async () =>
            new Response('Unauthorized', { status: 401 })
        ) as typeof fetch;

        expect(httpRequest('http://test.com/api')).rejects.toThrow('HTTP 401');
    });

    it('includes custom headers', async () => {
        let capturedHeaders: HeadersInit | undefined;
        globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
            capturedHeaders = init?.headers;
            return new Response(JSON.stringify({}), { status: 200 });
        }) as typeof fetch;

        await httpRequest('http://test.com/api', {
            headers: { 'X-Custom': 'value' },
        });

        expect(capturedHeaders).toHaveProperty('X-Custom', 'value');
    });
});

describe('parseNDJSON', () => {
    it('parses newline-delimited JSON', async () => {
        async function* source(): AsyncGenerator<string> {
            yield '{"a":1}\n{"b":2}\n';
        }

        const results: Record<string, number>[] = [];
        for await (const item of parseNDJSON<Record<string, number>>(source())) {
            results.push(item);
        }

        expect(results).toHaveLength(2);
        expect(results[0]).toEqual({ a: 1 });
        expect(results[1]).toEqual({ b: 2 });
    });

    it('handles chunks split across JSON boundaries', async () => {
        async function* source(): AsyncGenerator<string> {
            yield '{"a":';
            yield '1}\n{"b":2';
            yield '}\n';
        }

        const results: unknown[] = [];
        for await (const item of parseNDJSON(source())) {
            results.push(item);
        }

        expect(results).toHaveLength(2);
    });

    it('skips empty lines', async () => {
        async function* source(): AsyncGenerator<string> {
            yield '{"a":1}\n\n\n{"b":2}\n';
        }

        const results: unknown[] = [];
        for await (const item of parseNDJSON(source())) {
            results.push(item);
        }

        expect(results).toHaveLength(2);
    });

    it('handles remaining buffer content', async () => {
        async function* source(): AsyncGenerator<string> {
            yield '{"a":1}';
        }

        const results: unknown[] = [];
        for await (const item of parseNDJSON(source())) {
            results.push(item);
        }

        expect(results).toHaveLength(1);
    });
});

describe('parseSSE', () => {
    it('parses server-sent events', async () => {
        async function* source(): AsyncGenerator<string> {
            yield 'data: {"content":"hello"}\n\ndata: {"content":"world"}\n\n';
        }

        const results: { event?: string; data: string }[] = [];
        for await (const event of parseSSE(source())) {
            results.push(event);
        }

        expect(results).toHaveLength(2);
        expect(results[0]!.data).toBe('{"content":"hello"}');
        expect(results[1]!.data).toBe('{"content":"world"}');
    });

    it('skips [DONE] events', async () => {
        async function* source(): AsyncGenerator<string> {
            yield 'data: {"content":"hello"}\n\ndata: [DONE]\n\n';
        }

        const results: unknown[] = [];
        for await (const event of parseSSE(source())) {
            results.push(event);
        }

        expect(results).toHaveLength(1);
    });

    it('extracts event type', async () => {
        async function* source(): AsyncGenerator<string> {
            yield 'event: custom\ndata: {"test":true}\n\n';
        }

        const results: { event?: string; data: string }[] = [];
        for await (const event of parseSSE(source())) {
            results.push(event);
        }

        expect(results).toHaveLength(1);
        expect(results[0]!.event).toBe('custom');
    });
});

describe('buildHeaders', () => {
    it('returns Content-Type header', () => {
        const headers = buildHeaders({
            model: 'test',
            url: 'http://test.com',
            apiType: AIModelApiType.Ollama,
        });
        expect(headers['Content-Type']).toBe('application/json');
    });

    it('adds Authorization header when apiKey is set', () => {
        const headers = buildHeaders({
            model: 'test',
            url: 'http://test.com',
            apiType: AIModelApiType.OpenAI,
            apiKey: 'sk-test',
        });
        expect(headers['Authorization']).toBe('Bearer sk-test');
    });

    it('omits Authorization when no apiKey', () => {
        const headers = buildHeaders({
            model: 'test',
            url: 'http://test.com',
            apiType: AIModelApiType.Ollama,
        });
        expect(headers['Authorization']).toBeUndefined();
    });
});
