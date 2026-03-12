/**
 * Tests for router.ts — Failover Engine
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { Router, type ProviderEntry } from '../router.js';
import { BaseLLMClient } from '../client.js';
import { BufferedAuditor } from '../auditor.js';
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

    constructor(id: string, opts?: {
        chatFn?: (messages: LLMChatMessage[]) => Promise<LLMChatResponse>;
        embedFn?: (text: string) => Promise<number[]>;
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
    }

    async chat(messages: LLMChatMessage[]): Promise<LLMChatResponse> {
        return this.chatFn(messages);
    }

    async *chatStream(): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
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
});
