/**
 * Tests for ai-model.ts — Universal Client (AIModel)
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AIModel, type AIModelConfig, AIModelApiType, BufferedAuditor } from '../index.js';

// ============================================================================
// Helpers
// ============================================================================

function createTestConfig(overrides: Partial<AIModelConfig> = {}): AIModelConfig {
    return {
        model: 'test-model',
        providers: [
            { type: AIModelApiType.Ollama, url: 'http://localhost:11434' },
        ],
        ...overrides,
    };
}

// ============================================================================
// Tests
// ============================================================================

describe('AIModel', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    describe('constructor', () => {
        it('creates with single provider', () => {
            const model = new AIModel(createTestConfig());
            expect(model.model).toBe('test-model');
        });

        it('creates with multiple providers', () => {
            const model = new AIModel(createTestConfig({
                providers: [
                    { type: 'ollama', url: 'http://localhost:11434' },
                    { type: 'openai', apiKey: 'sk-test' },
                ],
            }));
            expect(model.model).toBe('test-model');
        });

        it('creates with all supported provider types', () => {
            const model = new AIModel(createTestConfig({
                providers: [
                    { type: 'ollama' },
                    { type: 'openai', apiKey: 'sk-test' },
                    { type: 'google', apiKey: 'test-key' },
                    { type: 'vertex', apiKey: 'token', region: 'us-east1' },
                    { type: 'llamacpp', url: 'http://localhost:8080' },
                ],
            }));
            expect(model.model).toBe('test-model');
        });

        it('throws for unknown provider type', () => {
            expect(() => new AIModel(createTestConfig({
                providers: [{ type: 'unknown' as never }],
            }))).toThrow('Unknown provider type');
        });
    });

    describe('model management', () => {
        it('returns model name', () => {
            const model = new AIModel(createTestConfig());
            expect(model.model).toBe('test-model');
        });

        it('switches model at runtime', () => {
            const model = new AIModel(createTestConfig());
            model.setModel('new-model');
            expect(model.model).toBe('new-model');
        });
    });

    describe('chat (with fetch mock)', () => {
        it('chat returns a response from Ollama provider', async () => {
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: 'Hello from Ollama' },
                    done: true,
                    prompt_eval_count: 10,
                    eval_count: 5,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());
            const response = await model.chat([
                { role: 'user', content: 'Hello' },
            ]);

            expect(response.message.role).toBe('assistant');
            expect(response.message.content).toBe('Hello from Ollama');
            expect(response.provider).toBe('ollama');
        });

        it('chat returns a response from OpenAI provider', async () => {
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion',
                    created: Date.now(),
                    model: 'test-model',
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: 'Hello from OpenAI' },
                        finish_reason: 'stop',
                    }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig({
                providers: [{ type: 'openai', apiKey: 'sk-test' }],
            }));

            const response = await model.chat([
                { role: 'user', content: 'Hello' },
            ]);

            expect(response.message.content).toBe('Hello from OpenAI');
            expect(response.provider).toBe('openai');
            expect(response.usage?.totalTokens).toBe(15);
        });

        it('chat returns a response from Google provider', async () => {
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    candidates: [{
                        content: {
                            parts: [{ text: 'Hello from Google' }],
                            role: 'model',
                        },
                        finishReason: 'STOP',
                        index: 0,
                    }],
                    usageMetadata: {
                        promptTokenCount: 10,
                        candidatesTokenCount: 5,
                        totalTokenCount: 15,
                    },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig({
                providers: [{ type: 'google', apiKey: 'test-key' }],
            }));

            const response = await model.chat([
                { role: 'user', content: 'Hello' },
            ]);

            expect(response.message.content).toBe('Hello from Google');
            expect(response.provider).toBe('google');
        });
    });

    describe('failover', () => {
        it('fails over from unhealthy provider to healthy one', async () => {
            let callCount = 0;
            globalThis.fetch = mock(async (url: string | URL | Request) => {
                callCount++;
                const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
                if (urlStr.includes('11434')) {
                    return new Response('Server Error', { status: 500 });
                }
                return new Response(JSON.stringify({
                    id: 'test',
                    object: 'chat.completion',
                    created: Date.now(),
                    model: 'test-model',
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: 'From backup' },
                        finish_reason: 'stop',
                    }],
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }) as typeof fetch;

            const model = new AIModel(createTestConfig({
                retries: 0, // No retries for faster test
                providers: [
                    { type: 'ollama', url: 'http://localhost:11434' },
                    { type: 'openai', url: 'http://localhost:8080', apiKey: 'test' },
                ],
            }));

            const response = await model.chat([
                { role: 'user', content: 'Hello' },
            ]);

            expect(response.message.content).toBe('From backup');
            expect(response.provider).toBe('openai');
        });
    });

    describe('tool registration', () => {
        it('registers a tool', () => {
            const model = new AIModel(createTestConfig());
            model.registerTool(
                'test_tool',
                'A test tool',
                { type: 'object', properties: {} },
                async () => 'result',
            );
            // If no error, registration succeeded
            expect(true).toBe(true);
        });

        it('registers multiple tools', () => {
            const model = new AIModel(createTestConfig());
            model.registerTools([
                {
                    name: 'tool_a',
                    description: 'Tool A',
                    parameters: { type: 'object' },
                    handler: async () => 'a',
                },
                {
                    name: 'tool_b',
                    description: 'Tool B',
                    parameters: { type: 'object' },
                    handler: async () => 'b',
                },
            ]);
            expect(true).toBe(true);
        });
    });

    describe('provider status', () => {
        it('returns provider status', () => {
            const model = new AIModel(createTestConfig({
                providers: [
                    { type: 'ollama' },
                    { type: 'openai', apiKey: 'sk-test' },
                ],
            }));

            const status = model.getProviderStatus();
            expect(status).toHaveLength(2);
            expect(status[0]!.healthy).toBe(true);
            expect(status[1]!.healthy).toBe(true);
        });
    });

    describe('observability', () => {
        it('records events through auditor', async () => {
            const auditor = new BufferedAuditor();
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test', created_at: '', done: true,
                    message: { role: 'assistant', content: 'ok' },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig({ auditor }));
            await model.chat([{ role: 'user', content: 'test' }]);

            const events = auditor.getEvents();
            expect(events.length).toBeGreaterThan(0);

            const types = events.map(e => e.type);
            expect(types).toContain('request');
            expect(types).toContain('response');
        });
    });

    describe('lifecycle', () => {
        it('dispose flushes auditor', async () => {
            let flushed = false;
            const auditor = new BufferedAuditor({
                onFlush: async () => { flushed = true; },
            });
            auditor.record({ timestamp: Date.now(), type: 'request' });

            const model = new AIModel(createTestConfig({ auditor }));
            await model.dispose();

            expect(flushed).toBe(true);
        });
    });
});
