/**
 * Tests for retry.ts — transient classification, Retry-After, backoff, sleep.
 */
import { describe, it, expect } from 'bun:test';
import {
    backoffDelay,
    classifyTransient,
    parseRetryAfter,
    retryAfterFrom,
    retryDelay,
    sleep,
} from '../retry.js';
import { LLMHttpError, LLMProviderError, LLMTimeoutError, retryAfterFromHeaders } from '../errors.js';

function codeError(code: string, viaCause = false): Error {
    const error = new Error('boom');
    if (viaCause) (error as { cause?: unknown }).cause = { code };
    else (error as { code?: string }).code = code;
    return error;
}

describe('classifyTransient', () => {
    it.each([
        [429, 'rate_limited'],
        [408, 'provider_error'],
        [500, 'provider_error'],
        [502, 'provider_error'],
        [503, 'provider_error'],
        [504, 'provider_error'],
        [520, 'provider_error'],
        [524, 'provider_error'],
        [529, 'provider_error'],
    ] as const)('HTTP %d is %s and retried', (status, kind) => {
        const result = classifyTransient(new LLMHttpError(status, 'x'));
        expect(result).toMatchObject({ retry: true, kind, status });
    });

    it.each([400, 401, 403, 404, 409, 422, 451, 501, 505])('HTTP %d is terminal', (status) => {
        expect(classifyTransient(new LLMHttpError(status, 'x'))).toMatchObject({ retry: false, kind: 'terminal', status });
    });

    it.each([
        'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
        'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT', 'ConnectionRefused', 'FailedToOpenSocket',
    ])('transport code %s is a lost connection (code and cause.code)', (code) => {
        expect(classifyTransient(codeError(code))).toMatchObject({ retry: true, kind: 'connection_lost' });
        expect(classifyTransient(codeError(code, true))).toMatchObject({ retry: true, kind: 'connection_lost' });
    });

    it('a timeout from this library is a lost connection, typed or by its wording', () => {
        expect(classifyTransient(new LLMTimeoutError('idle', 120000, 'http://h/v1'))).toMatchObject({ retry: true, kind: 'connection_lost' });
        expect(classifyTransient(new LLMTimeoutError('request', 30000))).toMatchObject({ retry: true, kind: 'connection_lost' });
        expect(classifyTransient(new Error('Stream idle timeout after 120000ms: http://h/v1'))).toMatchObject({ kind: 'connection_lost' });
        expect(classifyTransient(new Error('Request timeout after 30000ms'))).toMatchObject({ kind: 'connection_lost' });
    });

    it('socket and fetch failures by message are a lost connection', () => {
        for (const message of [
            'The socket connection was closed unexpectedly',
            'fetch failed',
            'Unable to connect. Is the computer able to access the url?',
            'socket hang up',
            'read ECONNRESET',
        ]) {
            expect(classifyTransient(new Error(message))).toMatchObject({ retry: true, kind: 'connection_lost' });
        }
    });

    it('a bare 3-digit number in a message is not a status', () => {
        for (const message of ['used 500 tokens', 'request id 512 failed', 'got 503 items', 'Model returned 429 results']) {
            expect(classifyTransient(new Error(message))).toEqual({ retry: false, kind: 'terminal' });
        }
    });

    it('an `HTTP NNN:` prefix from another copy of LLMHttpError is read', () => {
        expect(classifyTransient(new Error('HTTP 503: Service Unavailable'))).toMatchObject({ retry: true, kind: 'provider_error', status: 503 });
        expect(classifyTransient(new Error('HTTP 400: bad'))).toMatchObject({ retry: false, status: 400 });
        const copy = Object.assign(new Error('x'), { name: 'LLMHttpError', status: 429 });
        expect(classifyTransient(copy)).toMatchObject({ kind: 'rate_limited', status: 429 });
    });

    it('provider error types decide when there is no status', () => {
        expect(classifyTransient(new LLMProviderError('p', 'x', { errorType: 'overloaded_error' }))).toMatchObject({ retry: true, kind: 'provider_error' });
        expect(classifyTransient(new LLMProviderError('p', 'x', { errorType: 'rate_limit_error' }))).toMatchObject({ retry: true, kind: 'rate_limited' });
        expect(classifyTransient(new LLMProviderError('p', 'x', { errorType: 'api_error' }))).toMatchObject({ kind: 'provider_error' });
        expect(classifyTransient(new LLMProviderError('p', 'x', { errorType: 'invalid_request_error' }))).toMatchObject({ retry: false, kind: 'terminal' });
        expect(classifyTransient(new LLMProviderError('p', 'x', { retryable: true }))).toMatchObject({ retry: true, kind: 'provider_error' });
        expect(classifyTransient(new LLMProviderError('p', 'x'))).toMatchObject({ retry: false, kind: 'terminal' });
    });

    it('a status-bearing provider error uses its status (Anthropic overloaded = 529)', () => {
        expect(classifyTransient(new LLMProviderError('anthropic', 'x', { status: 529, errorType: 'overloaded_error', retryable: true })))
            .toMatchObject({ retry: true, kind: 'provider_error', status: 529, errorType: 'overloaded_error' });
    });

    it('the pre-typed Anthropic stream message is still read', () => {
        expect(classifyTransient(new Error('Anthropic stream error: overloaded_error — Overloaded'))).toMatchObject({ kind: 'provider_error' });
        expect(classifyTransient(new Error('Anthropic stream error: invalid_request_error — bad'))).toMatchObject({ retry: false });
    });

    it('an AbortError is never retried', () => {
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        (abort as { code?: string }).code = 'ECONNRESET';
        expect(classifyTransient(abort)).toEqual({ retry: false, kind: 'terminal' });
    });

    it('carries the wait the provider asked for', () => {
        const headers = new Headers({ 'retry-after': '7' });
        expect(classifyTransient(new LLMHttpError(429, 'slow down', undefined, headers))).toMatchObject({ retryAfterMs: 7000 });
        expect(classifyTransient(new LLMHttpError(400, 'bad', undefined, headers)).retryAfterMs).toBeUndefined();
    });
});

describe('parseRetryAfter', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');

    it('reads delta-seconds', () => {
        expect(parseRetryAfter('120', now)).toBe(120_000);
        expect(parseRetryAfter(' 1.5 ', now)).toBe(1500);
        expect(parseRetryAfter('0', now)).toBe(0);
    });

    it('reads an HTTP-date, and a past date is 0', () => {
        expect(parseRetryAfter('Fri, 20 Nov 2026 12:00:30 GMT', now)).toBe(30_000);
        expect(parseRetryAfter('Fri, 20 Nov 2026 11:00:00 GMT', now)).toBe(0);
    });

    it('rejects anything else', () => {
        for (const value of ['', '-1', '5s', 'soon', 'NaN', '1e3']) expect(parseRetryAfter(value, now)).toBeUndefined();
    });

    it('reads headers: retry-after-ms first, then Retry-After', () => {
        expect(retryAfterFromHeaders(new Headers({ 'retry-after-ms': '250', 'retry-after': '9' }), now)).toBe(250);
        expect(retryAfterFromHeaders(new Headers({ 'Retry-After': '9' }), now)).toBe(9000);
        expect(retryAfterFromHeaders(new Headers(), now)).toBeUndefined();
    });
});

describe('retryAfterFrom', () => {
    it('prefers an explicit retryAfterMs, then headers, then body hints', () => {
        expect(retryAfterFrom({ retryAfterMs: 1234 })).toBe(1234);
        expect(retryAfterFrom({ headers: { 'Retry-After': '3' } })).toBe(3000);
        expect(retryAfterFrom({ headers: new Map([['x', 'y']]) })).toBeUndefined();
        expect(retryAfterFrom(new LLMHttpError(429, '{"error":{"details":[{"retryDelay":"17s"}]}}'))).toBe(17_000);
        expect(retryAfterFrom(new Error('Rate limit reached. Please try again in 1.5s.'))).toBe(1500);
        expect(retryAfterFrom(new Error('retry after 20ms'))).toBe(20);
        expect(retryAfterFrom(new Error('no hint here'))).toBeUndefined();
    });
});

describe('backoffDelay', () => {
    it('is full jitter under a capped exponential ceiling', () => {
        const top = () => 0.999999;
        expect(backoffDelay(0, { baseMs: 1000, capMs: 60_000, random: top })).toBe(1000);
        expect(backoffDelay(1, { baseMs: 1000, capMs: 60_000, random: top })).toBe(2000);
        expect(backoffDelay(2, { baseMs: 1000, capMs: 60_000, random: top })).toBe(4000);
        expect(backoffDelay(10, { baseMs: 1000, capMs: 60_000, random: top })).toBe(60_000);
        expect(backoffDelay(3, { baseMs: 1000, random: () => 0 })).toBe(0);
        expect(backoffDelay(1, { baseMs: 1000, random: () => 0.5 })).toBe(1000);
    });

    it('stays within [0, ceiling] for a seeded sequence', () => {
        let seed = 42;
        const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
        for (let attempt = 0; attempt < 8; attempt++) {
            for (let i = 0; i < 50; i++) {
                const delay = backoffDelay(attempt, { baseMs: 500, capMs: 10_000, random });
                expect(delay).toBeGreaterThanOrEqual(0);
                expect(delay).toBeLessThanOrEqual(Math.min(10_000, 500 * 2 ** attempt));
            }
        }
    });

    it('baseMs 0 means no wait', () => {
        expect(backoffDelay(5, { baseMs: 0 })).toBe(0);
    });
});

describe('retryDelay', () => {
    it('waits what the provider asked, raised to the floor', () => {
        expect(retryDelay({ retryAfterMs: 5000 }, 0)).toEqual({ retry: true, delayMs: 5000, providerRequested: true });
        expect(retryDelay({ retryAfterMs: 0 }, 0)).toEqual({ retry: true, delayMs: 1000, providerRequested: true });
        expect(retryDelay({ retryAfterMs: 0 }, 0, { retryAfterMinMs: 0 })).toMatchObject({ delayMs: 0 });
    });

    it('does not retry when the provider asked for more than the cap', () => {
        expect(retryDelay({ retryAfterMs: 61_000 }, 0)).toEqual({ retry: false, reason: 'retry_after_exceeds_cap', retryAfterMs: 61_000 });
        expect(retryDelay({ retryAfterMs: 90_000 }, 0, { retryAfterCapMs: 300_000 })).toMatchObject({ retry: true, delayMs: 90_000 });
    });

    it('falls back to jittered backoff', () => {
        expect(retryDelay(new Error('x'), 2, { baseMs: 100, random: () => 0.999999 })).toEqual({ retry: true, delayMs: 400, providerRequested: false });
    });
});

describe('sleep', () => {
    it('waits', async () => {
        const started = Date.now();
        await sleep(30);
        expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    });

    it('rejects at once on an already-aborted signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(sleep(10_000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rejects when the signal aborts mid-wait', async () => {
        const controller = new AbortController();
        const started = Date.now();
        setTimeout(() => controller.abort(new Error('cancelled')), 10);
        await expect(sleep(10_000, controller.signal)).rejects.toThrow('cancelled');
        expect(Date.now() - started).toBeLessThan(1000);
    });
});
