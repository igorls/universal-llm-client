/**
 * Router retries: backoff between per-provider retries, Retry-After,
 * onRetry, streams retried only before their first event, the
 * afterFirstEvent tag, and caller aborts that never retry.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { Router } from '../router.js';
import { resetEndpointHealth } from '../endpoint-health.js';
import { BaseLLMClient } from '../client.js';
import { BufferedAuditor } from '../auditor.js';
import { LLMHttpError, streamErrorPhase } from '../errors.js';
import type { RetryEvent } from '../retry.js';
import type { LLMChatMessage, LLMChatResponse, DecodedEvent } from '../interfaces.js';

type StreamFn = () => AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>;

class MockClient extends BaseLLMClient {
    constructor(
        id: string,
        private readonly chatFn: () => Promise<LLMChatResponse> = async () => ({ message: { role: 'assistant', content: id }, provider: id }),
        private readonly streamFn?: StreamFn,
    ) {
        super({ model: `mock-${id}`, url: `http://mock-${id}`, apiType: 'openai' as never });
    }
    async chat(_messages: LLMChatMessage[]): Promise<LLMChatResponse> { return this.chatFn(); }
    async *chatStream(): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
        if (this.streamFn) return yield* this.streamFn();
        yield { type: 'text', content: 'ok' };
        return { message: { role: 'assistant', content: 'ok' }, provider: 'mock' };
    }
    async getModels(): Promise<string[]> { return ['m']; }
    async embed(): Promise<number[]> { return [1]; }
}

async function drain(gen: AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>): Promise<DecodedEvent[]> {
    const events: DecodedEvent[] = [];
    while (true) {
        const step = await gen.next();
        if (step.done) return events;
        events.push(step.value);
    }
}

const fast = { baseMs: 1, capMs: 5, retryAfterMinMs: 0 };

beforeEach(() => resetEndpointHealth());

describe('Router unary retries', () => {
    it('backs off between retries and reports each one', async () => {
        const events: RetryEvent[] = [];
        const auditor = new BufferedAuditor();
        const r = new Router({ retriesPerProvider: 2, maxFailures: 9, auditor, retry: { baseMs: 40, capMs: 40, random: () => 0.999999, onRetry: e => events.push(e) } });
        let calls = 0;
        r.addProvider({ id: 'a', priority: 0, client: new MockClient('a', async () => { calls++; throw new LLMHttpError(503, 'unavailable'); }) });
        r.addProvider({ id: 'b', priority: 1, client: new MockClient('b') });

        const started = Date.now();
        const res = await r.chat([{ role: 'user', content: 'hi' }]);
        expect(res.provider).toBe('b');
        expect(calls).toBe(3);
        expect(Date.now() - started).toBeGreaterThanOrEqual(70); // two ~40ms waits
        expect(events.map(e => [e.attempt, e.kind, e.stream, e.beforeFirstEvent, e.provider])).toEqual([
            [1, 'provider_error', false, false, 'a'],
            [2, 'provider_error', false, false, 'a'],
        ]);
        expect(events.every(e => e.delayMs === 40 && !e.providerRequested)).toBe(true);
        const retries = auditor.getEvents().filter(e => e.type === 'retry');
        expect(retries.map(e => e.metadata?.['delayMs'])).toEqual([40, 40]);
    });

    it('waits the Retry-After the provider sent', async () => {
        const events: RetryEvent[] = [];
        const r = new Router({ retriesPerProvider: 1, retry: { ...fast, onRetry: e => events.push(e) } });
        let calls = 0;
        r.addProvider({
            id: 'a', priority: 0, client: new MockClient('a', async () => {
                calls++;
                if (calls === 1) throw new LLMHttpError(503, 'busy', undefined, new Headers({ 'retry-after-ms': '60' }));
                return { message: { role: 'assistant', content: 'ok' }, provider: 'a' };
            }),
        });
        const started = Date.now();
        const res = await r.chat([{ role: 'user', content: 'hi' }]);
        expect(res.provider).toBe('a');
        expect(Date.now() - started).toBeGreaterThanOrEqual(55);
        expect(events[0]).toMatchObject({ delayMs: 60, providerRequested: true });
    });

    it('fails over instead of waiting a Retry-After past the cap', async () => {
        const r = new Router({ retriesPerProvider: 3, maxFailures: 9, retry: { ...fast, retryAfterCapMs: 100 } });
        let calls = 0;
        r.addProvider({ id: 'a', priority: 0, client: new MockClient('a', async () => { calls++; throw new LLMHttpError(503, 'later', undefined, new Headers({ 'retry-after': '120' })); }) });
        r.addProvider({ id: 'b', priority: 1, client: new MockClient('b') });
        const started = Date.now();
        const res = await r.chat([{ role: 'user', content: 'hi' }]);
        expect(res.provider).toBe('b');
        expect(calls).toBe(1);
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('a caller abort during the backoff stops without failover', async () => {
        const controller = new AbortController();
        const r = new Router({ retriesPerProvider: 3, retry: { baseMs: 5000, capMs: 5000, random: () => 0.999999 } });
        let bCalls = 0;
        r.addProvider({ id: 'a', priority: 0, client: new MockClient('a', async () => { throw new LLMHttpError(503, 'x'); }) });
        r.addProvider({ id: 'b', priority: 1, client: new MockClient('b', async () => { bCalls++; return { message: { role: 'assistant', content: 'b' }, provider: 'b' }; }) });
        setTimeout(() => controller.abort(), 30);
        const started = Date.now();
        await expect(r.execute(c => c.chat([]), 'chat', { signal: controller.signal })).rejects.toThrow('HTTP 503');
        expect(Date.now() - started).toBeLessThan(1000);
        expect(bCalls).toBe(0);
    });

    it('a throwing onRetry does not change the retry', async () => {
        const r = new Router({ retriesPerProvider: 1, retry: { ...fast, onRetry: () => { throw new Error('observer'); } } });
        let calls = 0;
        r.addProvider({ id: 'a', priority: 0, client: new MockClient('a', async () => { calls++; if (calls === 1) throw new LLMHttpError(500, 'x'); return { message: { role: 'assistant', content: 'a' }, provider: 'a' }; }) });
        expect((await r.chat([{ role: 'user', content: 'hi' }])).provider).toBe('a');
    });
});

describe('Router stream retries', () => {
    it('retries the same node before the first event, with onRetry', async () => {
        const events: RetryEvent[] = [];
        const r = new Router({ retriesPerProvider: 2, retry: { ...fast, onRetry: e => events.push(e) } });
        let attempts = 0;
        r.addProvider({
            id: 'a', priority: 0, client: new MockClient('a', undefined, async function* () {
                attempts++;
                if (attempts < 3) throw new LLMHttpError(529, 'overloaded');
                yield { type: 'text', content: 'hello' };
                return { message: { role: 'assistant', content: 'hello' }, provider: 'a' };
            }),
        });
        const out = await drain(r.executeStream(c => c.chatStream(), 'stream'));
        expect(out).toEqual([{ type: 'text', content: 'hello' }]);
        expect(attempts).toBe(3);
        expect(events.map(e => [e.attempt, e.kind, e.stream, e.beforeFirstEvent, e.context])).toEqual([
            [1, 'provider_error', true, true, 'stream'],
            [2, 'provider_error', true, true, 'stream'],
        ]);
    });

    it('does not retry or fail over after an event, and tags the error afterFirstEvent', async () => {
        const events: RetryEvent[] = [];
        const r = new Router({ retriesPerProvider: 3, retry: { ...fast, onRetry: e => events.push(e) } });
        let aAttempts = 0;
        let bAttempts = 0;
        r.addProvider({
            id: 'a', priority: 0, client: new MockClient('a', undefined, async function* () {
                aAttempts++;
                yield { type: 'text', content: 'partial' };
                throw new LLMHttpError(503, 'dropped');
            }),
        });
        r.addProvider({ id: 'b', priority: 1, client: new MockClient('b', undefined, async function* () { bAttempts++; yield { type: 'text', content: 'b' }; }) });
        const seen: DecodedEvent[] = [];
        const error = await (async () => {
            const gen = r.executeStream(c => c.chatStream());
            while (true) { const s = await gen.next(); if (s.done) return null; seen.push(s.value); }
        })().catch(e => e);
        expect(seen).toEqual([{ type: 'text', content: 'partial' }]);
        expect(error).toBeInstanceOf(LLMHttpError);
        expect(error.message).toBe('HTTP 503: dropped');
        expect(streamErrorPhase(error)).toEqual({ afterFirstEvent: true });
        expect(aAttempts).toBe(1);
        expect(bAttempts).toBe(0);
        expect(events).toHaveLength(0);
    });

    it('tags a failure before any event as afterFirstEvent: false', async () => {
        const r = new Router({ retriesPerProvider: 0 });
        r.addProvider({ id: 'a', priority: 0, client: new MockClient('a', undefined, async function* () { throw new LLMHttpError(400, 'bad'); }) });
        const error = await drain(r.executeStream(c => c.chatStream())).catch(e => e);
        expect(error.message).toBe('HTTP 400: bad');
        expect(streamErrorPhase(error)).toEqual({ afterFirstEvent: false });
    });

    it('a connection failure fails over without a same-node retry (no stacking)', async () => {
        const events: RetryEvent[] = [];
        const r = new Router({ retriesPerProvider: 3, retry: { ...fast, onRetry: e => events.push(e) } });
        let aAttempts = 0;
        r.addProvider({
            id: 'a', priority: 0, client: new MockClient('a', undefined, async function* () {
                aAttempts++;
                throw Object.assign(new Error('Unable to connect'), { code: 'ECONNREFUSED' });
            }),
        });
        r.addProvider({ id: 'b', priority: 1, client: new MockClient('b') });
        const out = await drain(r.executeStream(c => c.chatStream()));
        expect(out).toEqual([{ type: 'text', content: 'ok' }]);
        expect(aAttempts).toBe(1);
        expect(events).toHaveLength(0);
    });

    it('a caller abort before the first event is not retried or failed over', async () => {
        const controller = new AbortController();
        const r = new Router({ retriesPerProvider: 3, retry: fast });
        let aAttempts = 0;
        let bAttempts = 0;
        r.addProvider({
            id: 'a', priority: 0, client: new MockClient('a', undefined, async function* () {
                aAttempts++;
                controller.abort();
                const abort = new Error('aborted');
                abort.name = 'AbortError';
                throw abort;
            }),
        });
        r.addProvider({ id: 'b', priority: 1, client: new MockClient('b', undefined, async function* () { bAttempts++; yield { type: 'text', content: 'b' }; }) });
        const error = await drain(r.executeStream(c => c.chatStream(), 'stream', { signal: controller.signal })).catch(e => e);
        expect(error.name).toBe('AbortError');
        expect(aAttempts).toBe(1);
        expect(bAttempts).toBe(0);
    });
});
