import { describe, test, expect } from 'bun:test';

import {
    LLMHttpError,
    LLMProviderError,
    extractProviderErrorMessage,
    looksLikeErrorPayload,
    classifyFailure,
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

    test('timeouts and connection errors → no retry, cooldown', () => {
        expect(classifyFailure(new Error('Request timeout after 30000ms'))).toEqual({ retry: false, cooldown: true });
        expect(classifyFailure(new Error('fetch failed: ECONNREFUSED'))).toEqual({ retry: false, cooldown: true });
    });

    test('unknown errors preserve retry-then-failover', () => {
        expect(classifyFailure(new Error('something weird'))).toEqual({ retry: true, cooldown: false });
    });
});
