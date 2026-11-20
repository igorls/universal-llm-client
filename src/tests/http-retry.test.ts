/**
 * http.ts — response headers and Retry-After on LLMHttpError at both throw
 * sites, typed timeouts with unchanged messages, and a caller abort that is
 * not reported as a timeout. Uses a real local server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { httpRequest, httpStream } from '../http.js';
import { LLMHttpError, LLMTimeoutError } from '../errors.js';

let server: ReturnType<typeof Bun.serve>;
let base = '';

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        async fetch(req) {
            const path = new URL(req.url).pathname;
            if (path === '/limited') {
                return new Response('{"error":"slow down"}', { status: 429, headers: { 'Retry-After': '12', 'x-trace': 't1' } });
            }
            if (path === '/limited-ms') {
                return new Response('slow', { status: 429, headers: { 'retry-after-ms': '350' } });
            }
            if (path === '/hang') {
                await new Promise(r => setTimeout(r, 2000));
                return new Response('{}');
            }
            if (path === '/stall') {
                const stream = new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'));
                        // then stall
                    },
                });
                return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
            }
            return new Response('{}');
        },
    });
    base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

async function drain(gen: AsyncGenerator<string>): Promise<string[]> {
    const out: string[] = [];
    for await (const chunk of gen) out.push(chunk);
    return out;
}

describe('LLMHttpError carries response headers', () => {
    it('httpRequest: headers and parsed Retry-After', async () => {
        const error = await httpRequest(`${base}/limited`).catch(e => e);
        expect(error).toBeInstanceOf(LLMHttpError);
        expect(error.status).toBe(429);
        expect(error.message).toBe('HTTP 429: {"error":"slow down"}');
        expect(error.headers.get('x-trace')).toBe('t1');
        expect(error.retryAfterMs).toBe(12_000);
    });

    it('httpStream: headers and retry-after-ms', async () => {
        const error = await drain(httpStream(`${base}/limited-ms`, { body: {} })).catch(e => e);
        expect(error).toBeInstanceOf(LLMHttpError);
        expect(error.status).toBe(429);
        expect(error.headers.get('retry-after-ms')).toBe('350');
        expect(error.retryAfterMs).toBe(350);
    });

    it('constructing without headers still works and has none', () => {
        const error = new LLMHttpError(503, 'x', 'http://h');
        expect(error.headers).toBeUndefined();
        expect(error.retryAfterMs).toBeUndefined();
    });
});

describe('timeouts are LLMTimeoutError with the old wording', () => {
    it('httpRequest total timeout', async () => {
        const error = await httpRequest(`${base}/hang`, { timeout: 50 }).catch(e => e);
        expect(error).toBeInstanceOf(LLMTimeoutError);
        expect(error.kind).toBe('request');
        expect(error.timeoutMs).toBe(50);
        expect(error.message).toBe(`Request timeout after 50ms: ${base}/hang`);
    });

    it('httpStream idle timeout', async () => {
        const error = await drain(httpStream(`${base}/stall`, { body: {}, timeout: 80 })).catch(e => e);
        expect(error).toBeInstanceOf(LLMTimeoutError);
        expect(error.kind).toBe('idle');
        expect(error.message).toBe(`Stream idle timeout after 80ms: ${base}/stall`);
    });

    it('a caller abort of httpRequest is not a timeout', async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        const error = await httpRequest(`${base}/hang`, { timeout: 5000, signal: controller.signal }).catch(e => e);
        expect(error).not.toBeInstanceOf(LLMTimeoutError);
        expect(error.name).toBe('AbortError');
    });

    it('a caller abort of httpStream is not a timeout', async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        const error = await drain(httpStream(`${base}/stall`, { body: {}, timeout: 5000, signal: controller.signal })).catch(e => e);
        expect(error).not.toBeInstanceOf(LLMTimeoutError);
        expect(error.name).toBe('AbortError');
    });
});
