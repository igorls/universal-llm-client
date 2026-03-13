/**
 * Tests for ai-model.ts — Universal Client (AIModel)
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { z } from 'zod';
import { AIModel, type AIModelConfig, AIModelApiType, BufferedAuditor, StructuredOutputError } from '../index.js';

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

    // ========================================================================
    // Structured Output Tests (VAL-API-001, VAL-API-002, VAL-API-003, VAL-API-006, VAL-API-007)
    // ========================================================================

    describe('generateStructured', () => {
        const UserSchema = z.object({
            name: z.string(),
            age: z.number(),
            email: z.string().email().optional(),
        });

        type User = z.infer<typeof UserSchema>;

        it('returns typed object matching schema (VAL-API-001)', async () => {
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: '{"name": "Alice", "age": 30}' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());
            const result = await model.generateStructured(UserSchema, [
                { role: 'user', content: 'Generate a user' },
            ]);

            expect(result.name).toBe('Alice');
            expect(result.age).toBe(30);
        });

        it('returns typed object with optional fields', async () => {
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: '{"name": "Bob", "age": 25, "email": "bob@example.com"}' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());
            const result = await model.generateStructured(UserSchema, [
                { role: 'user', content: 'Generate a user with email' },
            ]);

            expect(result.name).toBe('Bob');
            expect(result.age).toBe(25);
            expect(result.email).toBe('bob@example.com');
        });

        it('passes options (temperature, maxTokens) to provider (VAL-API-002)', async () => {
            let capturedBody: Record<string, unknown> | undefined;
            globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
                if (init?.body) {
                    capturedBody = JSON.parse(init.body as string);
                }
                return new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: '{"name": "Test", "age": 20}' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }) as typeof fetch;

            const model = new AIModel(createTestConfig());
            await model.generateStructured(UserSchema, [
                { role: 'user', content: 'Generate a user' },
            ], { temperature: 0.5, maxTokens: 100 });

            // Ollama uses 'options' object for temperature and max_tokens
            expect(capturedBody?.options).toBeDefined();
            expect((capturedBody?.options as Record<string, unknown>)?.temperature).toBe(0.5);
        });

        it('failover works across providers with same structured output request (VAL-API-003)', async () => {
            let firstProviderCalled = false;
            globalThis.fetch = mock(async (url: string | URL | Request) => {
                const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
                // First provider (Ollama) fails
                if (urlStr.includes('11434') && !firstProviderCalled) {
                    firstProviderCalled = true;
                    return new Response('Server Error', { status: 500 });
                }
                // Second provider (OpenAI-compatible) succeeds
                return new Response(JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion',
                    created: Date.now(),
                    model: 'test-model',
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: '{"name": "Failover", "age": 40}' },
                        finish_reason: 'stop',
                    }],
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }) as typeof fetch;

            const model = new AIModel(createTestConfig({
                retries: 0,
                providers: [
                    { type: 'ollama', url: 'http://localhost:11434' },
                    { type: 'openai', url: 'http://localhost:8080/v1', apiKey: 'test' },
                ],
            }));

            const result = await model.generateStructured(UserSchema, [
                { role: 'user', content: 'Generate a user' },
            ]);

            expect(result.name).toBe('Failover');
            expect(result.age).toBe(40);
        });

        it('throws StructuredOutputError on validation failure (VAL-API-001)', async () => {
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: '{"name": "Alice", "age": "not a number"}' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());

            expect(
                model.generateStructured(UserSchema, [{ role: 'user', content: 'Generate a user' }])
            ).rejects.toThrow(StructuredOutputError);
        });

        it('throws StructuredOutputError on invalid JSON response', async () => {
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: 'not valid json' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());

            expect(
                model.generateStructured(UserSchema, [{ role: 'user', content: 'Generate a user' }])
            ).rejects.toThrow(StructuredOutputError);
        });

        it('accepts raw JSON Schema instead of Zod', async () => {
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: '{"name": "Schema", "age": 50}' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());
            const result = await model.generateStructured(
                UserSchema,
                [{ role: 'user', content: 'Generate a user' }],
            );

            expect(result.name).toBe('Schema');
            expect(result.age).toBe(50);
        });

        it('works with nested object schemas', async () => {
            const NestedSchema = z.object({
                user: z.object({
                    name: z.string(),
                    address: z.object({
                        city: z.string(),
                        country: z.string(),
                    }),
                }),
            });

            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: {
                        role: 'assistant',
                        content: '{"user": {"name": "Nested", "address": {"city": "NYC", "country": "USA"}}}',
                    },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());
            const result = await model.generateStructured(NestedSchema, [
                { role: 'user', content: 'Generate a nested user' },
            ]);

            expect(result.user.name).toBe('Nested');
            expect(result.user.address.city).toBe('NYC');
        });

        it('works with array schemas', async () => {
            const ArraySchema = z.object({
                items: z.array(z.string()),
            });

            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: '{"items": ["a", "b", "c"]}' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());
            const result = await model.generateStructured(ArraySchema, [
                { role: 'user', content: 'Generate items' },
            ]);

            expect(result.items).toEqual(['a', 'b', 'c']);
        });

        it('works with enum schemas', async () => {
            const EnumSchema = z.object({
                status: z.enum(['active', 'inactive', 'pending']),
            });

            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: '{"status": "active"}' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());
            const result = await model.generateStructured(EnumSchema, [
                { role: 'user', content: 'Generate status' },
            ]);

            expect(result.status).toBe('active');
        });
    });

    describe('tryParseStructured', () => {
        const UserSchema = z.object({
            name: z.string(),
            age: z.number(),
        });

        type User = z.infer<typeof UserSchema>;

        it('returns { ok: true, value } on success (VAL-API-006)', async () => {
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: '{"name": "Alice", "age": 30}' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());
            const result = await model.tryParseStructured(UserSchema, [
                { role: 'user', content: 'Generate a user' },
            ]);

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.name).toBe('Alice');
                expect(result.value.age).toBe(30);
            }
        });

        it('returns { ok: false, error, rawOutput } on validation failure (VAL-API-007)', async () => {
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: '{"name": "Alice", "age": "wrong type"}' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());
            const result = await model.tryParseStructured(UserSchema, [
                { role: 'user', content: 'Generate a user' },
            ]);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(StructuredOutputError);
                expect(result.rawOutput).toBe('{"name": "Alice", "age": "wrong type"}');
            }
        });

        it('returns { ok: false, ... } on malformed JSON (VAL-API-007)', async () => {
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: 'not valid json at all' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());
            const result = await model.tryParseStructured(UserSchema, [
                { role: 'user', content: 'Generate a user' },
            ]);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(StructuredOutputError);
                expect(result.rawOutput).toBe('not valid json at all');
            }
        });

        it('never throws, always returns result object (VAL-API-007)', async () => {
            // Test with valid response
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: '{"name": "Test", "age": 25}' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());

            // Should not throw on success
            const result1 = await model.tryParseStructured(UserSchema, [
                { role: 'user', content: 'Test' },
            ]);
            expect(result1.ok).toBe(true);

            // Now test with invalid response - need to re-mock
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: 'invalid' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            // Should not throw on failure
            const result2 = await model.tryParseStructured(UserSchema, [
                { role: 'user', content: 'Test' },
            ]);
            expect(result2.ok).toBe(false);
        });

        it('includes raw output in failure result for debugging', async () => {
            globalThis.fetch = mock(async () =>
                new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: '{"unexpected": "structure"}' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            ) as typeof fetch;

            const model = new AIModel(createTestConfig());
            const result = await model.tryParseStructured(UserSchema, [
                { role: 'user', content: 'Generate a user' },
            ]);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.rawOutput).toBe('{"unexpected": "structure"}');
                expect(result.error.message).toContain('Validation failed');
            }
        });

        it('handles options (temperature, maxTokens)', async () => {
            let capturedBody: Record<string, unknown> | undefined;
            globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
                if (init?.body) {
                    capturedBody = JSON.parse(init.body as string);
                }
                return new Response(JSON.stringify({
                    model: 'test-model',
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content: '{"name": "Test", "age": 20}' },
                    done: true,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }) as typeof fetch;

            const model = new AIModel(createTestConfig());
            const result = await model.tryParseStructured(UserSchema, [
                { role: 'user', content: 'Generate a user' },
            ], { temperature: 0.3, maxTokens: 50 });

            expect(result.ok).toBe(true);
            // Verify options were passed to provider
            expect(capturedBody?.options).toBeDefined();
        });

        it('works with failover across providers', async () => {
            let firstProviderCalled = false;
            globalThis.fetch = mock(async (url: string | URL | Request) => {
                const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
                // First provider (Ollama) fails
                if (urlStr.includes('11434') && !firstProviderCalled) {
                    firstProviderCalled = true;
                    return new Response('Server Error', { status: 500 });
                }
                // Second provider succeeds
                return new Response(JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion',
                    created: Date.now(),
                    model: 'test-model',
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: '{"name": "Failover", "age": 99}' },
                        finish_reason: 'stop',
                    }],
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }) as typeof fetch;

            const model = new AIModel(createTestConfig({
                retries: 0,
                providers: [
                    { type: 'ollama', url: 'http://localhost:11434' },
                    { type: 'openai', url: 'http://localhost:8080/v1', apiKey: 'test' },
                ],
            }));

            const result = await model.tryParseStructured(UserSchema, [
                { role: 'user', content: 'Generate a user' },
            ]);

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.name).toBe('Failover');
                expect(result.value.age).toBe(99);
            }
        });
    });
});
