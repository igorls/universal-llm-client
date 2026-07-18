/**
 * Tests for router.ts — Pool-aware routing (Phase 1)
 *
 * Same-priority pools: least-inflight dispatch, per-node maxConcurrent caps,
 * bounded queue then spill to the next tier, session affinity (rendezvous
 * hashing), and the pool/node telemetry counters.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { Router } from '../router.js';
import { BaseLLMClient } from '../client.js';
import { BufferedAuditor } from '../auditor.js';
import type {
    LLMChatMessage,
    LLMChatResponse,
    DecodedEvent,
} from '../interfaces.js';

// ============================================================================
// Mock Client (controllable completion)
// ============================================================================

class MockClient extends BaseLLMClient {
    public chatFn: (messages: LLMChatMessage[]) => Promise<LLMChatResponse>;
    public streamFn?: () => AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>;

    constructor(id: string, opts?: {
        chatFn?: (messages: LLMChatMessage[]) => Promise<LLMChatResponse>;
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
        return [this.options.model];
    }

    async embed(): Promise<number[]> {
        return [1, 2, 3];
    }
}

/** A chat whose completion the test controls. */
function deferredClient(id: string): { client: MockClient; release: () => void; started: () => number } {
    let startedCount = 0;
    const releases: Array<() => void> = [];
    const client = new MockClient(id, {
        chatFn: () => {
            startedCount++;
            return new Promise<LLMChatResponse>(resolve => {
                releases.push(() => resolve({
                    message: { role: 'assistant', content: `Response from ${id}` },
                    provider: id,
                }));
            });
        },
    });
    return {
        client,
        release: () => {
            const r = releases.shift();
            if (r) r();
        },
        started: () => startedCount,
    };
}

function countingClient(id: string): { client: MockClient; calls: () => number } {
    let calls = 0;
    const client = new MockClient(id, {
        chatFn: async () => {
            calls++;
            return {
                message: { role: 'assistant', content: `Response from ${id}` },
                provider: id,
            };
        },
    });
    return { client, calls: () => calls };
}

const MSG: LLMChatMessage[] = [{ role: 'user', content: 'hi' }];
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

// ============================================================================
// Tests
// ============================================================================

describe('Router pools', () => {
    let auditor: BufferedAuditor;
    let router: Router;

    beforeEach(() => {
        auditor = new BufferedAuditor();
        router = new Router({ auditor, retriesPerProvider: 0, maxFailures: 2, cooldownMs: 100, spillAfterMs: 60 });
    });

    describe('least-inflight dispatch', () => {
        it('sends a request to the less-loaded node of a pool', async () => {
            const a = deferredClient('a');
            const b = countingClient('b');
            router.addProvider({ id: 'a', client: a.client, priority: 0 });
            router.addProvider({ id: 'b', client: b.client, priority: 0 });

            // Occupy node a (declaration order wins the 0-0 tie).
            const first = router.chat(MSG);
            await tick();
            expect(a.started()).toBe(1);

            // Second request must prefer idle b over busy a.
            const second = await router.chat(MSG);
            expect(second.provider).toBe('b');
            expect(b.calls()).toBe(1);

            a.release();
            expect((await first).provider).toBe('a');
        });
    });

    describe('maxConcurrent + bounded queue + spill', () => {
        it('waits for a freed slot instead of spilling when one frees in time', async () => {
            const a = deferredClient('a');
            const cloud = countingClient('cloud');
            router.addProvider({ id: 'a', client: a.client, priority: 0, maxConcurrent: 1 });
            router.addProvider({ id: 'cloud', client: cloud.client, priority: 1 });

            const first = router.chat(MSG);
            await tick();
            const second = router.chat(MSG); // pool saturated → queues
            await tick();
            a.release(); // frees within spillAfterMs
            const r1 = await first;
            a.release();
            const r2 = await second;

            expect(r1.provider).toBe('a');
            expect(r2.provider).toBe('a'); // stayed on the GPU pool
            expect(cloud.calls()).toBe(0);
            const pool0 = router.getPoolStatus().find(p => p.priority === 0)!;
            expect(pool0.queueWaits).toBe(1);
            expect(pool0.spills).toBe(0);
        });

        it('spills to the next tier when the pool stays saturated past spillAfterMs', async () => {
            const a = deferredClient('a');
            const cloud = countingClient('cloud');
            router.addProvider({ id: 'a', client: a.client, priority: 0, maxConcurrent: 1 });
            router.addProvider({ id: 'cloud', client: cloud.client, priority: 1 });

            const first = router.chat(MSG);
            await tick();
            const second = await router.chat(MSG); // saturated → spills after 60ms
            expect(second.provider).toBe('cloud');
            expect(cloud.calls()).toBe(1);

            const pool0 = router.getPoolStatus().find(p => p.priority === 0)!;
            expect(pool0.spills).toBe(1);

            a.release();
            expect((await first).provider).toBe('a');
        });

        it('skips a capped node for its pool sibling without queueing', async () => {
            const a = deferredClient('a');
            const b = countingClient('b');
            router.addProvider({ id: 'a', client: a.client, priority: 0, maxConcurrent: 1 });
            router.addProvider({ id: 'b', client: b.client, priority: 0, maxConcurrent: 1 });

            const first = router.chat(MSG);
            await tick();
            const second = await router.chat(MSG);
            expect(second.provider).toBe('b');
            const pool0 = router.getPoolStatus().find(p => p.priority === 0)!;
            expect(pool0.queueWaits).toBe(0);

            a.release();
            await first;
        });
    });

    describe('session affinity', () => {
        it('keeps one session on one node and is stable across calls', async () => {
            const a = countingClient('a');
            const b = countingClient('b');
            router.addProvider({ id: 'a', client: a.client, priority: 0 });
            router.addProvider({ id: 'b', client: b.client, priority: 0 });

            const firstProvider = (await router.chat(MSG, { sessionKey: 'conv_123' })).provider;
            for (let i = 0; i < 5; i++) {
                const r = await router.chat(MSG, { sessionKey: 'conv_123' });
                expect(r.provider).toBe(firstProvider);
            }
            // One node took all 6, the other none.
            expect(a.calls() + b.calls()).toBe(6);
            expect(Math.max(a.calls(), b.calls())).toBe(6);
        });

        it('distributes distinct session keys across the pool', async () => {
            const a = countingClient('a');
            const b = countingClient('b');
            router.addProvider({ id: 'a', client: a.client, priority: 0 });
            router.addProvider({ id: 'b', client: b.client, priority: 0 });

            for (let i = 0; i < 32; i++) {
                await router.chat(MSG, { sessionKey: `conv_${i}` });
            }
            // Rendezvous hashing over 32 keys should hit both nodes.
            expect(a.calls()).toBeGreaterThan(0);
            expect(b.calls()).toBeGreaterThan(0);
        });

        it('falls through to the pool sibling when the affine node is at its cap', async () => {
            const a = deferredClient('a');
            const b = deferredClient('b');
            router.addProvider({ id: 'a', client: a.client, priority: 0, maxConcurrent: 1 });
            router.addProvider({ id: 'b', client: b.client, priority: 0, maxConcurrent: 1 });

            // Find which node conv_X prefers by dispatching once.
            const probe = router.chat(MSG, { sessionKey: 'conv_X' });
            await tick();
            const preferred = a.started() === 1 ? a : b;
            const other = preferred === a ? b : a;

            // Preferred node is now busy (cap 1) — same session must fall through.
            const second = router.chat(MSG, { sessionKey: 'conv_X' });
            await tick();
            expect(other.started()).toBe(1);

            preferred.release();
            other.release();
            await probe;
            await second;
        });
    });

    describe('failover inside and across pools', () => {
        it('tries the pool sibling before the next tier on node failure', async () => {
            const bad = new MockClient('bad', {
                chatFn: async () => {
                    throw new Error('boom');
                },
            });
            const good = countingClient('good');
            const cloud = countingClient('cloud');
            router.addProvider({ id: 'bad', client: bad, priority: 0 });
            router.addProvider({ id: 'good', client: good.client, priority: 0 });
            router.addProvider({ id: 'cloud', client: cloud.client, priority: 1 });

            // Both idle → least-inflight tie → stable sort keeps declaration order,
            // so 'bad' is dispatched first, throws, and must fail over to its POOL
            // SIBLING — never straight to the cloud tier.
            const r = await router.chat(MSG);
            expect(r.provider).toBe('good');
            expect(good.calls()).toBe(1);
            expect(cloud.calls()).toBe(0);
            expect(auditor.getEvents().some(e => e.type === 'error' && e.provider === 'bad')).toBe(true);
        });

        it('reaches the next tier when every pool node fails', async () => {
            const badA = new MockClient('badA', { chatFn: async () => { throw new Error('a down'); } });
            const badB = new MockClient('badB', { chatFn: async () => { throw new Error('b down'); } });
            const cloud = countingClient('cloud');
            router.addProvider({ id: 'badA', client: badA, priority: 0 });
            router.addProvider({ id: 'badB', client: badB, priority: 0 });
            router.addProvider({ id: 'cloud', client: cloud.client, priority: 1 });

            const r = await router.chat(MSG);
            expect(r.provider).toBe('cloud');
            expect(cloud.calls()).toBe(1);
        });
    });

    describe('streaming slot accounting', () => {
        it('holds the slot for the stream lifetime and releases it after', async () => {
            let releaseStream: (() => void) | null = null;
            const gate = new Promise<void>(resolve => { releaseStream = resolve; });
            const a = new MockClient('a', {
                streamFn: async function* () {
                    yield { type: 'text', content: 'hello ' };
                    await gate;
                    yield { type: 'text', content: 'world' };
                    return { message: { role: 'assistant' as const, content: 'hello world' }, provider: 'a' };
                },
            });
            router.addProvider({ id: 'a', client: a, priority: 0, maxConcurrent: 1 });

            const consumed: string[] = [];
            const consume = (async () => {
                const gen = router.chatStream(MSG);
                let next = await gen.next();
                while (!next.done) {
                    const ev = next.value;
                    if (ev.type === 'text') consumed.push(ev.content);
                    next = await gen.next();
                }
            })();

            await tick();
            expect(router.getStatus().find(s => s.id === 'a')!.inflight).toBe(1);
            releaseStream!();
            await consume;
            expect(consumed.join('')).toBe('hello world');
            expect(router.getStatus().find(s => s.id === 'a')!.inflight).toBe(0);
        });
    });

    describe('telemetry', () => {
        it('tracks per-node requests, failures and latency', async () => {
            const a = countingClient('a');
            const bad = new MockClient('bad', { chatFn: async () => { throw new Error('down'); } });
            router.addProvider({ id: 'bad', client: bad, priority: 0 });
            router.addProvider({ id: 'a', client: a.client, priority: 1 });

            await router.chat(MSG);
            const status = router.getStatus();
            const badS = status.find(s => s.id === 'bad')!;
            const aS = status.find(s => s.id === 'a')!;
            expect(badS.failures).toBe(1);
            expect(badS.requests).toBe(1);
            expect(aS.requests).toBe(1);
            expect(aS.failures).toBe(0);
            expect(aS.avgLatencyMs).toBeGreaterThanOrEqual(0);
            expect(aS.inflight).toBe(0);
            expect(aS.priority).toBe(1);
        });

        it('reports pool membership and inflight totals', async () => {
            const a = deferredClient('a');
            const b = countingClient('b');
            router.addProvider({ id: 'a', client: a.client, priority: 0 });
            router.addProvider({ id: 'b', client: b.client, priority: 0 });
            router.addProvider({ id: 'cloud', client: countingClient('cloud').client, priority: 1 });

            const inFlightCall = router.chat(MSG);
            await tick();
            const pools = router.getPoolStatus();
            expect(pools).toHaveLength(2);
            expect(pools[0]!.nodes.sort()).toEqual(['a', 'b']);
            expect(pools[0]!.inflight).toBe(1);
            expect(pools[1]!.nodes).toEqual(['cloud']);

            a.release();
            await inFlightCall;
        });
    });

    describe('backward compatibility (distinct priorities = classic chain)', () => {
        it('always prefers the lowest-priority healthy node', async () => {
            const a = countingClient('primary');
            const b = countingClient('fallback');
            router.addProvider({ id: 'primary', client: a.client, priority: 0 });
            router.addProvider({ id: 'fallback', client: b.client, priority: 1 });

            for (let i = 0; i < 3; i++) {
                const r = await router.chat(MSG);
                expect(r.provider).toBe('primary');
            }
            expect(b.calls()).toBe(0);
        });
    });
});
