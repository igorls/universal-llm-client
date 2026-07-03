/**
 * Tests for router.ts — Failover Engine
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { Router, type ProviderEntry } from '../router.js';
import { BaseLLMClient } from '../client.js';
import { BufferedAuditor } from '../auditor.js';
import { LLMHttpError, LLMProviderError } from '../errors.js';
import type {
    LLMChatMessage,
    LLMChatResponse,
    ChatOptions,
    DecodedEvent,
} from '../interfaces.js';

// ============================================================================
// Mock Client
// ============================================================================

class MockClient extends BaseLLMClient {
    public chatFn: (messages: LLMChatMessage[]) => Promise<LLMChatResponse>;
    public embedFn: (text: string) => Promise<number[]>;
    public modelsFn: () => Promise<string[]>;

    public streamFn?: () => AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>;

    constructor(id: string, opts?: {
        chatFn?: (messages: LLMChatMessage[]) => Promise<LLMChatResponse>;
        embedFn?: (text: string) => Promise<number[]>;
        streamFn?: () => AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>;
    }) {
        super({
            model: `mock-${id}`,
            url: `http://mock-${id}`,
            apiType: 'openai' as never,
        });
        this.chatFn = opts?.chatFn ?? (async () => ({
            message: { role: 'assistant' as const, content: `Response from ${id}` },
            provider: id,
        }));
        this.embedFn = opts?.embedFn ?? (async () => [1, 2, 3]);
        this.modelsFn = async () => [`mock-${id}`];
        this.streamFn = opts?.streamFn;
    }

    async chat(messages: LLMChatMessage[]): Promise<LLMChatResponse> {
        return this.chatFn(messages);
    }

    async *chatStream(): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
        if (this.streamFn) {
            return yield* this.streamFn();
        }
        yield { type: 'text', content: 'streamed' };
        return { message: { role: 'assistant', content: 'streamed' }, provider: 'mock' };
    }

    async getModels(): Promise<string[]> {
        return this.modelsFn();
    }

    async embed(text: string): Promise<number[]> {
        return this.embedFn(text);
    }
}

// ============================================================================
// Tests
// ============================================================================

describe('Router', () => {
    let router: Router;
    let auditor: BufferedAuditor;

    beforeEach(() => {
        auditor = new BufferedAuditor();
        router = new Router({ auditor, retriesPerProvider: 1, maxFailures: 2, cooldownMs: 100 });
    });

    describe('provider management', () => {
        it('adds providers and sorts by priority', () => {
            const clientA = new MockClient('a');
            const clientB = new MockClient('b');

            router.addProvider({ id: 'a', client: clientA, priority: 2 });
            router.addProvider({ id: 'b', client: clientB, priority: 1 });

            const status = router.getStatus();
            expect(status).toHaveLength(2);
            // b has lower priority number = tried first
            expect(status[0]!.id).toBe('b');
            expect(status[1]!.id).toBe('a');
        });

        it('removes providers', () => {
            router.addProvider({ id: 'a', client: new MockClient('a'), priority: 0 });
            router.addProvider({ id: 'b', client: new MockClient('b'), priority: 1 });
            router.removeProvider('a');

            expect(router.getStatus()).toHaveLength(1);
            expect(router.getStatus()[0]!.id).toBe('b');
        });
    });

    describe('execution with failover', () => {
        it('uses the highest-priority provider', async () => {
            const clientA = new MockClient('a');
            const clientB = new MockClient('b');

            router.addProvider({ id: 'a', client: clientA, priority: 0 });
            router.addProvider({ id: 'b', client: clientB, priority: 1 });

            const result = await router.chat([{ role: 'user', content: 'test' }]);
            expect(result.provider).toBe('a');
        });

        it('fails over to next provider on error', async () => {
            const clientA = new MockClient('a', {
                chatFn: async () => { throw new Error('A failed'); },
            });
            const clientB = new MockClient('b');

            router.addProvider({ id: 'a', client: clientA, priority: 0 });
            router.addProvider({ id: 'b', client: clientB, priority: 1 });

            const result = await router.chat([{ role: 'user', content: 'test' }]);
            expect(result.provider).toBe('b');

            // Check audit events
            const events = auditor.getEvents();
            const failoverEvents = events.filter(e => e.type === 'failover');
            expect(failoverEvents.length).toBeGreaterThan(0);
        });

        it('retries within a provider before failover', async () => {
            let attempts = 0;
            const clientA = new MockClient('a', {
                chatFn: async () => {
                    attempts++;
                    if (attempts === 1) throw new Error('Transient failure');
                    return {
                        message: { role: 'assistant' as const, content: 'recovered' },
                        provider: 'a',
                    };
                },
            });

            router.addProvider({ id: 'a', client: clientA, priority: 0 });
            const result = await router.chat([{ role: 'user', content: 'test' }]);

            expect(result.provider).toBe('a');
            expect(attempts).toBe(2); // first attempt + 1 retry
        });

        it('throws when all providers fail', async () => {
            const clientA = new MockClient('a', {
                chatFn: async () => { throw new Error('A failed'); },
            });
            const clientB = new MockClient('b', {
                chatFn: async () => { throw new Error('B failed'); },
            });

            router.addProvider({ id: 'a', client: clientA, priority: 0 });
            router.addProvider({ id: 'b', client: clientB, priority: 1 });

            expect(router.chat([{ role: 'user', content: 'test' }])).rejects.toThrow();
        });

        it('throws when no providers configured', async () => {
            expect(router.chat([{ role: 'user', content: 'test' }])).rejects.toThrow(
                'No available LLM providers'
            );
        });
    });

    describe('health tracking', () => {
        it('marks unhealthy after max failures', async () => {
            const failing = new MockClient('fail', {
                chatFn: async () => { throw new Error('always fails'); },
            });
            const backup = new MockClient('backup');

            router.addProvider({ id: 'fail', client: failing, priority: 0 });
            router.addProvider({ id: 'backup', client: backup, priority: 1 });

            // Each chat call records 1 failure for 'fail', maxFailures is 2
            await router.chat([{ role: 'user', content: 'test 1' }]);
            await router.chat([{ role: 'user', content: 'test 2' }]);

            const status = router.getStatus();
            const failStatus = status.find(s => s.id === 'fail');
            expect(failStatus!.healthy).toBe(false);
        });

        it('recovers after cooldown expires', async () => {
            let callCount = 0;
            const failing = new MockClient('fail', {
                chatFn: async () => {
                    callCount++;
                    if (callCount <= 4) throw new Error('failing');
                    return {
                        message: { role: 'assistant' as const, content: 'recovered' },
                        provider: 'fail',
                    };
                },
            });
            const backup = new MockClient('backup');

            router.addProvider({ id: 'fail', client: failing, priority: 0 });
            router.addProvider({ id: 'backup', client: backup, priority: 1 });

            // First call: fail → backup
            await router.chat([{ role: 'user', content: '1' }]);

            // Wait for cooldown (100ms in test config)
            await new Promise(r => setTimeout(r, 150));

            // After cooldown, fail should be tried again
            const status = router.getStatus();
            const failStatus = status.find(s => s.id === 'fail');
            expect(failStatus!.healthy).toBe(true);
        });
    });

    describe('tool registration', () => {
        it('broadcasts tool registration to all providers', () => {
            const clientA = new MockClient('a');
            const clientB = new MockClient('b');

            router.addProvider({ id: 'a', client: clientA, priority: 0 });
            router.addProvider({ id: 'b', client: clientB, priority: 1 });

            router.registerTool(
                'test_tool',
                'A test tool',
                { type: 'object', properties: {} },
                async () => 'result',
            );

            // Both clients should have the tool registered
            const defsA = clientA.getToolDefinitions();
            const defsB = clientB.getToolDefinitions();
            expect(defsA).toHaveLength(1);
            expect(defsB).toHaveLength(1);
            expect(defsA[0]!.function.name).toBe('test_tool');
        });
    });

    describe('model aggregation', () => {
        it('aggregates models from all providers', async () => {
            const clientA = new MockClient('a');
            const clientB = new MockClient('b');

            router.addProvider({ id: 'a', client: clientA, priority: 0 });
            router.addProvider({ id: 'b', client: clientB, priority: 1 });

            const models = await router.getModels();
            expect(models).toContain('mock-a');
            expect(models).toContain('mock-b');
        });
    });

    describe('streaming failover (first-token boundary)', () => {
        const okStream = (label: string) => (async function* (): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
            yield { type: 'text', content: label };
            return { message: { role: 'assistant', content: label }, provider: label };
        });
        const failBeforeToken = () => (async function* (): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
            throw new Error('connection refused');
        });
        const failAfterToken = () => (async function* (): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
            yield { type: 'text', content: 'partial from A' };
            throw new Error('mid-stream boom');
        });

        async function drainAll(gen: AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>) {
            const events: DecodedEvent[] = [];
            let value: LLMChatResponse | void;
            while (true) {
                const r = await gen.next();
                if (r.done) { value = r.value; break; }
                events.push(r.value);
            }
            return { events, value };
        }

        it('fails over cleanly when the first provider fails BEFORE any token', async () => {
            const r = new Router({ retriesPerProvider: 0 });
            r.addProvider({ id: 'a', priority: 0, client: new MockClient('a', { streamFn: failBeforeToken() }) });
            r.addProvider({ id: 'b', priority: 1, client: new MockClient('b', { streamFn: okStream('b') }) });

            const { events, value } = await drainAll(r.executeStream(c => c.chatStream()));
            expect(events).toEqual([{ type: 'text', content: 'b' }]); // only B — no duplication
            expect((value as LLMChatResponse).provider).toBe('b');
            expect(r.getStatus().find(s => s.id === 'a')?.consecutiveFailures).toBe(1);
        });

        it('surfaces the error WITHOUT failover once a token has been emitted', async () => {
            const r = new Router({ retriesPerProvider: 0 });
            let bTried = false;
            r.addProvider({ id: 'a', priority: 0, client: new MockClient('a', { streamFn: failAfterToken() }) });
            r.addProvider({
                id: 'b', priority: 1, client: new MockClient('b', {
                    streamFn: async function* () { bTried = true; yield { type: 'text', content: 'from B' }; },
                }),
            });

            const events: DecodedEvent[] = [];
            const run = async () => {
                const gen = r.executeStream(c => c.chatStream());
                while (true) { const x = await gen.next(); if (x.done) break; events.push(x.value); }
            };
            await expect(run()).rejects.toThrow('mid-stream boom');
            expect(events).toEqual([{ type: 'text', content: 'partial from A' }]); // A's partial, not re-streamed
            expect(bTried).toBe(false); // B never tried — no double output
        });

        it('throws when every provider fails before the first token', async () => {
            const r = new Router({ retriesPerProvider: 0 });
            r.addProvider({ id: 'a', priority: 0, client: new MockClient('a', { streamFn: failBeforeToken() }) });
            r.addProvider({ id: 'b', priority: 1, client: new MockClient('b', { streamFn: failBeforeToken() }) });
            const run = async () => { const gen = r.executeStream(c => c.chatStream()); while (true) { if ((await gen.next()).done) break; } };
            await expect(run()).rejects.toThrow('connection refused');
        });
    });

    describe('fast failover (error classification, Gap 3)', () => {
        it('skips per-provider retries on a terminal error and cools the node down', async () => {
            const r = new Router({ retriesPerProvider: 3, maxFailures: 5 });
            let aCalls = 0;
            r.addProvider({ id: 'a', priority: 0, client: new MockClient('a', { chatFn: async () => { aCalls++; throw new LLMProviderError('ollama', 'quota'); } }) });
            r.addProvider({ id: 'b', priority: 1, client: new MockClient('b') });

            const res = await r.chat([{ role: 'user', content: 'hi' }]);
            expect(res.provider).toBe('b');
            expect(aCalls).toBe(1); // terminal error → NOT retriesPerProvider+1 attempts
            const aStatus = r.getStatus().find(s => s.id === 'a')!;
            expect(aStatus.healthy).toBe(false); // cooled down now, despite maxFailures=5
            expect(aStatus.cooldownUntil).toBeGreaterThan(Date.now() - 1);
        });

        it('still retries the same provider on a transient (5xx) error', async () => {
            const r = new Router({ retriesPerProvider: 2, maxFailures: 5 });
            let aCalls = 0;
            r.addProvider({ id: 'a', priority: 0, client: new MockClient('a', { chatFn: async () => { aCalls++; throw new LLMHttpError(503, 'unavailable'); } }) });
            r.addProvider({ id: 'b', priority: 1, client: new MockClient('b') });

            const res = await r.chat([{ role: 'user', content: 'hi' }]);
            expect(res.provider).toBe('b');
            expect(aCalls).toBe(3); // 1 initial + 2 retries before failover
            expect(r.getStatus().find(s => s.id === 'a')!.healthy).toBe(true); // one failover, 5xx isn't a cooldown reason
        });

        it('a cooled-down provider is skipped entirely on the next call', async () => {
            const r = new Router({ retriesPerProvider: 3, maxFailures: 5, cooldownMs: 10_000 });
            let aCalls = 0;
            r.addProvider({ id: 'a', priority: 0, client: new MockClient('a', { chatFn: async () => { aCalls++; throw new LLMHttpError(429, 'rate limited'); } }) });
            r.addProvider({ id: 'b', priority: 1, client: new MockClient('b') });

            await r.chat([{ role: 'user', content: '1' }]); // a → 429 → cooldown; b serves
            expect(aCalls).toBe(1);
            await r.chat([{ role: 'user', content: '2' }]); // a in cooldown → not tried at all
            expect(aCalls).toBe(1);
        });
    });
});
