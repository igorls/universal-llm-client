/**
 * Tests for router.ts — Failover Engine
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { Router, type ProviderEntry } from '../router.js';
import { resetEndpointHealth } from '../endpoint-health.js';
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

beforeEach(() => resetEndpointHealth());

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

    describe('single-node chains survive a dropped connection', () => {
        // A headless agent on one self-hosted node lost its socket mid-turn; the
        // node was cooled for cooldownMs and every retry inside that window threw
        // "No available LLM providers" — one blip became an outage of the only node.
        it('does not cool down a node that already streamed events', async () => {
            let calls = 0;
            const client = new MockClient('solo', {
                async *streamFn() {
                    calls++;
                    yield { type: 'text', content: 'partial' } as DecodedEvent;
                    if (calls === 1) throw new Error('The socket connection was closed unexpectedly');
                    return { message: { role: 'assistant' as const, content: 'ok' }, provider: 'solo' };
                },
            });
            const r = new Router({ retriesPerProvider: 1, maxFailures: 5, cooldownMs: 60_000 });
            r.addProvider({ id: 'solo', client, priority: 0 });

            const first = r.chatStream([{ role: 'user', content: 'x' }]);
            await expect((async () => { for await (const _ of first) { /* drain */ } })()).rejects.toThrow('socket');
            expect(r.getStatus()[0]!.healthy).toBe(true); // it was alive: it streamed

            const events: DecodedEvent[] = [];
            for await (const e of r.chatStream([{ role: 'user', content: 'y' }])) events.push(e);
            expect(events).toHaveLength(1);
        });

        it('panic-routes to the soonest-recovering node when every node is cooling down', async () => {
            let calls = 0;
            const client = new MockClient('solo', {
                chatFn: async () => {
                    calls++;
                    if (calls === 1) throw new Error('fetch failed'); // connectivity → cooldown
                    return { message: { role: 'assistant' as const, content: 'back' }, provider: 'solo' };
                },
            });
            const r = new Router({ auditor, retriesPerProvider: 0, maxFailures: 5, cooldownMs: 60_000 });
            r.addProvider({ id: 'solo', client, priority: 0 });

            await expect(r.chat([{ role: 'user', content: '1' }])).rejects.toThrow('fetch failed');
            expect(r.getStatus()[0]!.healthy).toBe(false);

            const res = await r.chat([{ role: 'user', content: '2' }]);
            expect(res.message.content).toBe('back');
            expect(auditor.getEvents().some(e => e.metadata?.['phase'] === 'panic')).toBe(true);
        });

        it('still prefers a healthy node over a cooling one', async () => {
            let aCalls = 0;
            const a = new MockClient('a', { chatFn: async () => { aCalls++; throw new Error('fetch failed'); } });
            const b = new MockClient('b');
            const r = new Router({ retriesPerProvider: 0, maxFailures: 5, cooldownMs: 60_000 });
            r.addProvider({ id: 'a', client: a, priority: 0 });
            r.addProvider({ id: 'b', client: b, priority: 1 });

            await r.chat([{ role: 'user', content: '1' }]); // a → cooldown, b serves
            await r.chat([{ role: 'user', content: '2' }]); // a skipped, no panic
            expect(aCalls).toBe(1);
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

// ============================================================================
// Cold-node liveness preflight (SYN-blackhole bounding)
// ============================================================================

describe("cold-node preflight", () => {
    function neverResolves(): Promise<string[]> {
        return new Promise(() => undefined);
    }

    it("skips a blackholed node within the probe budget and serves from the fallback", async () => {
        const dead = new MockClient("dead");
        dead.modelsFn = neverResolves; // powered-off host: probe hangs
        dead.chatFn = async () => {
            throw new Error("should never be dispatched to the dead node");
        };
        const alive = new MockClient("alive");

        const router = new Router({ coldProbeTimeoutMs: 100, retriesPerProvider: 0 });
        router.addProvider({ id: "dead", client: dead, priority: 0 } as ProviderEntry);
        router.addProvider({ id: "alive", client: alive, priority: 1 } as ProviderEntry);

        const t0 = Date.now();
        const res = await router.execute((c) => c.chat([{ role: "user", content: "hi" }]));
        expect((res as { provider?: string }).provider).toBe("alive");
        expect(Date.now() - t0).toBeLessThan(1500); // bounded by the probe, not a TCP stall
    });

    it("probe errors (reachable host) do NOT mark the node dead", async () => {
        const grumpy = new MockClient("grumpy");
        grumpy.modelsFn = async () => {
            throw new Error("401 unauthorized"); // host answers — reachable
        };
        const router = new Router({ coldProbeTimeoutMs: 100, retriesPerProvider: 0 });
        router.addProvider({ id: "grumpy", client: grumpy, priority: 0 } as ProviderEntry);

        const res = await router.execute((c) => c.chat([{ role: "user", content: "hi" }]));
        expect((res as { provider?: string }).provider).toBe("grumpy");
    });

    it("recent success skips the probe entirely", async () => {
        let probes = 0;
        const node = new MockClient("hot");
        const baseModels = node.modelsFn;
        node.modelsFn = async () => {
            probes++;
            return baseModels();
        };
        const router = new Router({ coldProbeTimeoutMs: 100, coldProbeAfterMs: 60000, retriesPerProvider: 0 });
        router.addProvider({ id: "hot", client: node, priority: 0 } as ProviderEntry);

        await router.execute((c) => c.chat([{ role: "user", content: "1" }]));
        await router.execute((c) => c.chat([{ role: "user", content: "2" }]));
        expect(probes).toBe(1); // only the cold first request probes
    });

    it("streaming also skips a blackholed node before the first token", async () => {
        const dead = new MockClient("dead-stream");
        dead.modelsFn = neverResolves;
        const alive = new MockClient("alive-stream");

        const router = new Router({ coldProbeTimeoutMs: 100, retriesPerProvider: 0 });
        router.addProvider({ id: "dead-stream", client: dead, priority: 0 } as ProviderEntry);
        router.addProvider({ id: "alive-stream", client: alive, priority: 1 } as ProviderEntry);

        let text = "";
        const gen = router.executeStream((c) => c.chatStream());
        for await (const ev of gen) {
            if (ev.type === "text" && ev.content) text += ev.content;
        }
        expect(text).toBe("streamed");
    });

    it("coldProbeTimeoutMs: 0 disables the preflight", async () => {
        let probes = 0;
        const node = new MockClient("noprobe");
        const baseModels = node.modelsFn;
        node.modelsFn = async () => {
            probes++;
            return baseModels();
        };
        const router = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0 });
        router.addProvider({ id: "noprobe", client: node, priority: 0 } as ProviderEntry);
        await router.execute((c) => c.chat([{ role: "user", content: "hi" }]));
        expect(probes).toBe(0);
    });
});

describe("shared endpoint circuit breaker", () => {
    it("skips an externally known-down endpoint without a foreground probe or chat attempt", async () => {
        let primaryChats = 0;
        let primaryModels = 0;
        const primary = new MockClient("cp-down", {
            chatFn: async () => {
                primaryChats++;
                throw new Error("should not run");
            },
        });
        primary.modelsFn = async () => {
            primaryModels++;
            return [];
        };
        const fallback = new MockClient("cp-fallback");
        const router = new Router({ coldProbeTimeoutMs: 100, retriesPerProvider: 0 });
        router.addProvider({
            id: "cp-down",
            client: primary,
            priority: 0,
            availability: { status: "down", checkedAt: new Date().toISOString(), retryAfterMs: 60_000 },
        });
        router.addProvider({ id: "cp-fallback", client: fallback, priority: 1 });

        const response = await router.chat([{ role: "user", content: "hi" }]);
        expect(response.provider).toBe("cp-fallback");
        expect(primaryChats).toBe(0);
        expect(primaryModels).toBe(0);
    });

    it("shares request-path connectivity failures across routers for the same endpoint", async () => {
        let secondPrimaryCalls = 0;
        const firstPrimary = new MockClient("shared-connectivity", {
            chatFn: async () => {
                throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
            },
        });
        const secondPrimary = new MockClient("shared-connectivity", {
            chatFn: async () => {
                secondPrimaryCalls++;
                return { message: { role: "assistant", content: "unexpected" }, provider: "shared-connectivity" };
            },
        });
        const first = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0 });
        first.addProvider({ id: "shared-a", client: firstPrimary, priority: 0 });
        first.addProvider({ id: "shared-a-fallback", client: new MockClient("shared-a-fallback"), priority: 1 });
        await first.chat([{ role: "user", content: "one" }]);

        const second = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0 });
        second.addProvider({ id: "shared-b", client: secondPrimary, priority: 0 });
        second.addProvider({ id: "shared-b-fallback", client: new MockClient("shared-b-fallback"), priority: 1 });
        const response = await second.chat([{ role: "user", content: "two" }]);
        expect(response.provider).toBe("shared-b-fallback");
        expect(secondPrimaryCalls).toBe(0);
    });

    it("does not share credential failures across routers", async () => {
        const badCredential = new MockClient("shared-auth", {
            chatFn: async () => {
                throw new LLMHttpError(401, "bad key");
            },
        });
        const validCredential = new MockClient("shared-auth");
        const first = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0 });
        first.addProvider({ id: "auth-a", client: badCredential, priority: 0 });
        first.addProvider({ id: "auth-a-fallback", client: new MockClient("auth-a-fallback"), priority: 1 });
        await first.chat([{ role: "user", content: "one" }]);

        const second = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0 });
        second.addProvider({ id: "auth-b", client: validCredential, priority: 0 });
        const response = await second.chat([{ role: "user", content: "two" }]);
        expect(response.provider).toBe("shared-auth");
    });

    it("does not share HTTP failures that prove transport reachability", async () => {
        const failingRequest = new MockClient("shared-http", {
            chatFn: async () => {
                throw new LLMHttpError(504, "Gateway Timeout");
            },
        });
        const healthyRequest = new MockClient("shared-http");
        const first = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0 });
        first.addProvider({ id: "http-a", client: failingRequest, priority: 0 });
        first.addProvider({ id: "http-a-fallback", client: new MockClient("http-a-fallback"), priority: 1 });
        await first.chat([{ role: "user", content: "one" }]);

        const second = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0 });
        second.addProvider({ id: "http-b", client: healthyRequest, priority: 0 });
        const response = await second.chat([{ role: "user", content: "two" }]);
        expect(response.provider).toBe("shared-http");
    });

    it("runs recovery in the background and only restores the endpoint after it succeeds", async () => {
        let finishProbe!: (reachable: boolean) => void;
        const probe = new Promise<boolean>((resolve) => {
            finishProbe = resolve;
        });
        const router = new Router({
            coldProbeTimeoutMs: 0,
            retriesPerProvider: 0,
            connectivityProbe: async () => await probe,
        });
        router.addProvider({
            id: "recovering",
            client: new MockClient("recovering"),
            priority: 0,
            availability: { status: "down", checkedAt: "1970-01-01T00:00:00.000Z", retryAfterMs: 0 },
        });
        router.addProvider({ id: "recovering-fallback", client: new MockClient("recovering-fallback"), priority: 1 });

        const first = await router.chat([{ role: "user", content: "one" }]);
        expect(first.provider).toBe("recovering-fallback");
        finishProbe(true);
        await new Promise((resolve) => setTimeout(resolve, 0)); // let the probe result land
        const second = await router.chat([{ role: "user", content: "two" }]);
        expect(second.provider).toBe("recovering");
    });
    it("does not share a timeout: a healthy server can be slow", async () => {
        let secondCalls = 0;
        const slow = new MockClient("shared-slow", {
            chatFn: async () => {
                throw new Error("Request timeout after 30000ms: http://mock-shared-slow/v1/chat/completions");
            },
        });
        const first = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0 });
        first.addProvider({ id: "slow-a", client: slow, priority: 0 });
        first.addProvider({ id: "slow-a-fallback", client: new MockClient("slow-a-fallback"), priority: 1 });
        await first.chat([{ role: "user", content: "one" }]);

        const second = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0 });
        second.addProvider({
            id: "slow-b",
            client: new MockClient("shared-slow", {
                chatFn: async () => {
                    secondCalls++;
                    return { message: { role: "assistant", content: "ok" }, provider: "shared-slow" };
                },
            }),
            priority: 0,
        });
        second.addProvider({ id: "slow-b-fallback", client: new MockClient("slow-b-fallback"), priority: 1 });
        const response = await second.chat([{ role: "user", content: "two" }]);
        expect(response.provider).toBe("shared-slow");
        expect(secondCalls).toBe(1);
    });

    it("does not share a cold-probe timeout: the model may be loading", async () => {
        const loading = new MockClient("shared-loading");
        loading.modelsFn = () => new Promise(() => undefined);
        const first = new Router({ coldProbeTimeoutMs: 50, retriesPerProvider: 0 });
        first.addProvider({ id: "loading-a", client: loading, priority: 0 });
        first.addProvider({ id: "loading-a-fallback", client: new MockClient("loading-a-fallback"), priority: 1 });
        const fellBack = await first.chat([{ role: "user", content: "one" }]);
        expect(fellBack.provider).toBe("loading-a-fallback");

        const second = new Router({ coldProbeTimeoutMs: 50, retriesPerProvider: 0 });
        second.addProvider({ id: "loading-b", client: new MockClient("shared-loading"), priority: 0 });
        second.addProvider({ id: "loading-b-fallback", client: new MockClient("loading-b-fallback"), priority: 1 });
        const response = await second.chat([{ role: "user", content: "two" }]);
        expect(response.provider).toBe("shared-loading");
    });

    it("still sends to a down endpoint when no other node can take the request", async () => {
        const probe = mock(async () => false);
        const router = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0, connectivityProbe: probe });
        router.addProvider({
            id: "only",
            client: new MockClient("only"),
            priority: 0,
            availability: { status: "down", checkedAt: new Date().toISOString(), retryAfterMs: 60_000 },
        });

        const response = await router.chat([{ role: "user", content: "hi" }]);
        expect(response.provider).toBe("only");
        // The answer itself restores the endpoint for every router.
        expect(router.getStatus()[0]!.endpointDown).toBe(false);
    });

    it("prefers a reachable node in a later tier over a down one in the first", async () => {
        let downCalls = 0;
        const router = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0, connectivityProbe: async () => false });
        router.addProvider({
            id: "tier0-down",
            client: new MockClient("tier0-down", {
                chatFn: async () => {
                    downCalls++;
                    return { message: { role: "assistant", content: "x" }, provider: "tier0-down" };
                },
            }),
            priority: 0,
            availability: { status: "down", retryAfterMs: 60_000 },
        });
        router.addProvider({ id: "tier1-up", client: new MockClient("tier1-up"), priority: 1 });

        const response = await router.chat([{ role: "user", content: "hi" }]);
        expect(response.provider).toBe("tier1-up");
        expect(downCalls).toBe(0);
        expect(router.getStatus().find(s => s.id === "tier0-down")!.endpointDown).toBe(true);
    });

    it("an older external signal does not override a newer success", async () => {
        const first = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0 });
        first.addProvider({ id: "fresh", client: new MockClient("shared-fresh"), priority: 0 });
        await first.chat([{ role: "user", content: "one" }]);

        const second = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0 });
        second.addProvider({
            id: "stale",
            client: new MockClient("shared-fresh"),
            priority: 0,
            availability: { status: "down", checkedAt: "2020-01-01T00:00:00.000Z" },
        });
        expect(second.getStatus()[0]!.endpointDown).toBe(false);
    });

    it("a stream that fails after its first event does not mark the endpoint down", async () => {
        const dropping = new MockClient("shared-stream", {
            streamFn: async function* () {
                yield { type: "text", content: "partial" };
                throw Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
            },
        });
        const router = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0 });
        router.addProvider({ id: "stream-a", client: dropping, priority: 0 });
        await expect(async () => {
            for await (const _event of router.chatStream([{ role: "user", content: "hi" }])) {
                // drain
            }
        }).toThrow("connection reset");

        const other = new Router({ coldProbeTimeoutMs: 0, retriesPerProvider: 0 });
        other.addProvider({ id: "stream-b", client: new MockClient("shared-stream"), priority: 0 });
        expect(other.getStatus()[0]!.endpointDown).toBe(false);
    });
});
