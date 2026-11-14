import { describe, test, expect } from 'bun:test';

import {
    LLMHttpError,
    LLMProviderError,
    extractProviderErrorMessage,
    looksLikeErrorPayload,
    classifyFailure,
    isEndpointUnreachable,
} from '../errors.js';

describe('error helpers', () => {
    test('extractProviderErrorMessage: flat + nested shapes, ignores normal responses', () => {
        expect(extractProviderErrorMessage({ error: 'quota' })).toBe('quota');
        expect(extractProviderErrorMessage({ error: { message: 'nested quota' } })).toBe('nested quota');
        // A normal Ollama-shaped response has no `error` field.
        expect(extractProviderErrorMessage({ message: { content: 'hi' }, done: true })).toBeNull();
        expect(extractProviderErrorMessage({ error: '' })).toBeNull();
        expect(extractProviderErrorMessage({ error: '   ' })).toBeNull();
        expect(extractProviderErrorMessage('not an object')).toBeNull();
        expect(extractProviderErrorMessage(null)).toBeNull();
        expect(extractProviderErrorMessage(undefined)).toBeNull();
    });

    test('looksLikeErrorPayload: only a bare {error} object counts', () => {
        expect(looksLikeErrorPayload('{"error":"limit"}')).toBe(true);
        expect(looksLikeErrorPayload('  {"error":{"message":"x"}}  ')).toBe(true);
        expect(looksLikeErrorPayload('Hello, how can I help?')).toBe(false);
        expect(looksLikeErrorPayload('{"answer":42}')).toBe(false);
        expect(looksLikeErrorPayload('{ not json }')).toBe(false);
    });

    test('typed errors carry the fields the failover engine classifies on', () => {
        const http = new LLMHttpError(429, '{"error":"rate limited"}', 'http://x/api/chat');
        expect(http).toBeInstanceOf(Error);
        expect(http.status).toBe(429);
        expect(http.body).toContain('rate limited');
        expect(http.url).toBe('http://x/api/chat');
        expect(http.message).toContain('HTTP 429');

        const prov = new LLMProviderError('ollama', 'Ollama error: quota', { retryable: false });
        expect(prov).toBeInstanceOf(Error);
        expect(prov.provider).toBe('ollama');
        expect(prov.retryable).toBe(false);
        // Default is non-retryable (a provider error is rarely worth an immediate retry).
        expect(new LLMProviderError('ollama', 'x').retryable).toBe(false);
    });
});

describe('classifyFailure', () => {
    test('5xx and 408 are retryable, not cooled down', () => {
        expect(classifyFailure(new LLMHttpError(500, 'boom'))).toEqual({ retry: true, cooldown: false });
        expect(classifyFailure(new LLMHttpError(503, 'boom'))).toEqual({ retry: true, cooldown: false });
        expect(classifyFailure(new LLMHttpError(408, 'timeout'))).toEqual({ retry: true, cooldown: false });
    });

    test('quota / auth / not-found → no retry, cooldown the node', () => {
        for (const status of [429, 401, 403, 404]) {
            expect(classifyFailure(new LLMHttpError(status, 'x'))).toEqual({ retry: false, cooldown: true });
        }
    });

    test('other 4xx → no retry, no cooldown (bad request; node is fine)', () => {
        expect(classifyFailure(new LLMHttpError(400, 'bad request'))).toEqual({ retry: false, cooldown: false });
    });

    test('LLMProviderError follows its retryable flag', () => {
        expect(classifyFailure(new LLMProviderError('ollama', 'quota'))).toEqual({ retry: false, cooldown: true });
        expect(classifyFailure(new LLMProviderError('ollama', 'blip', { retryable: true }))).toEqual({ retry: true, cooldown: false });
    });

    test('timeouts and connection errors → no retry, cooldown (cross-runtime)', () => {
        expect(classifyFailure(new Error('Request timeout after 30000ms'))).toEqual({ retry: false, cooldown: true });
        expect(classifyFailure(new Error('fetch failed'))).toEqual({ retry: false, cooldown: true });
        // Bun's connection-refused message (surfaced by the local failover test):
        expect(classifyFailure(new Error('Unable to connect. Is the computer able to access the url?'))).toEqual({ retry: false, cooldown: true });
        // Node-style TypeError('fetch failed') with cause.code:
        expect(classifyFailure(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toEqual({ retry: false, cooldown: true });
        // A direct .code (some HTTP stacks):
        expect(classifyFailure(Object.assign(new Error('boom'), { code: 'ENOTFOUND' }))).toEqual({ retry: false, cooldown: true });
    });

    test('unknown errors preserve retry-then-failover', () => {
        expect(classifyFailure(new Error('something weird'))).toEqual({ retry: true, cooldown: false });
    });
});

describe('isEndpointUnreachable', () => {
    test('refused, reset and DNS failures are unreachable, by transport code', () => {
        // Node: TypeError('fetch failed') with cause.code. Bun: TypeError with code.
        expect(isEndpointUnreachable(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(true);
        expect(isEndpointUnreachable(Object.assign(new TypeError('Unable to connect. Is the computer able to access the url?'), { code: 'ECONNREFUSED' }))).toBe(true);
        expect(isEndpointUnreachable(Object.assign(new TypeError('getaddrinfo ENOTFOUND host.test'), { code: 'ENOTFOUND' }))).toBe(true);
        expect(isEndpointUnreachable(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true);
    });

    test('message text alone never counts, so a server cannot mark a host down', () => {
        expect(isEndpointUnreachable(new Error('ECONNREFUSED: Unable to connect'))).toBe(false);
        expect(isEndpointUnreachable(new TypeError('fetch failed'))).toBe(false);
        expect(isEndpointUnreachable(new LLMProviderError('ollama', 'upstream: connection refused'))).toBe(false);
        expect(isEndpointUnreachable(Object.assign(new LLMProviderError('ollama', 'x'), { code: 'ECONNREFUSED' }))).toBe(false);
        expect(isEndpointUnreachable(Object.assign(new Error('x'), { code: 'ECONNREFUSED', failover: { retry: false, cooldown: false } }))).toBe(false);
    });

    test('timeouts and HTTP responses are not', () => {
        expect(isEndpointUnreachable(new Error('Request timeout after 30000ms: http://host.test/v1'))).toBe(false);
        expect(isEndpointUnreachable(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))).toBe(false);
        expect(isEndpointUnreachable(new LLMHttpError(504, 'Gateway Timeout'))).toBe(false);
        expect(isEndpointUnreachable(new LLMHttpError(401, 'connection refused by policy'))).toBe(false);
        expect(isEndpointUnreachable(new Error('something else'))).toBe(false);
    });
});
