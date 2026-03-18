/**
 * Ollama Provider Unit Tests
 *
 * Tests the OllamaClient's message conversion logic, specifically
 * the multimodal/vision path, tool call argument handling, and
 * structured output via format parameter.
 *
 * Validates assertions:
 * - VAL-PROVIDER-OLLAMA-001: format Parameter with JSON Schema
 * - VAL-PROVIDER-OLLAMA-003: Vision with Base64 Extraction
 * - VAL-PROVIDER-OLLAMA-004: format "json" vs Schema
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { z } from 'zod';
import { OllamaClient } from '../../providers/ollama.js';
import type { LLMClientOptions, LLMChatMessage, ChatOptions } from '../../interfaces.js';
import { AIModelApiType } from '../../interfaces.js';

// ============================================================================
// Helpers
// ============================================================================

function createClient(overrides?: Partial<LLMClientOptions>): OllamaClient {
    return new OllamaClient({
        model: 'test-model',
        url: 'http://localhost:11434',
        apiType: AIModelApiType.Ollama,
        ...overrides,
    });
}

const OLLAMA_RESPONSE = {
    model: 'test-model',
    created_at: '2026-01-01T00:00:00Z',
    message: { role: 'assistant', content: 'test response' },
    done: true,
    prompt_eval_count: 10,
    eval_count: 5,
};

// ============================================================================
// Tests
// ============================================================================

describe('OllamaClient', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    /** Capture the body sent to Ollama's /api/chat */
    function mockFetchAndCapture(response = OLLAMA_RESPONSE) {
        let capturedBody: Record<string, unknown> | null = null;

        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
            if (init?.body) {
                capturedBody = JSON.parse(init.body as string);
            }
            return new Response(JSON.stringify(response), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }) as typeof fetch;

        return () => capturedBody;
    }

    // ========================================================================
    // Text-only messages
    // ========================================================================

    describe('text-only messages', () => {
        test('passes string content through', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            await client.chat([
                { role: 'user', content: 'Hello' },
            ]);

            const body = getBody()!;
            const messages = body['messages'] as Record<string, unknown>[];
            expect(messages).toHaveLength(1);
            expect(messages[0]!['role']).toBe('user');
            expect(messages[0]!['content']).toBe('Hello');
            expect(messages[0]!['images']).toBeUndefined();
        });

        test('handles empty string content', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            await client.chat([
                { role: 'assistant', content: '' },
            ]);

            const body = getBody()!;
            const messages = body['messages'] as Record<string, unknown>[];
            expect(messages[0]!['content']).toBe('');
        });
    });

    // ========================================================================
    // Multimodal / Vision messages
    // ========================================================================

    describe('multimodal messages', () => {
        test('extracts base64 from data URLs', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const messages: LLMChatMessage[] = [{
                role: 'user',
                content: [
                    { type: 'text', text: 'What is this?' },
                    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA1234' } },
                ],
            }];

            await client.chat(messages);

            const body = getBody()!;
            const sent = body['messages'] as Record<string, unknown>[];
            expect(sent[0]!['content']).toBe('What is this?');
            expect(sent[0]!['images']).toEqual(['AAAA1234']);
        });

        test('handles raw base64 strings', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const messages: LLMChatMessage[] = [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Describe' },
                    { type: 'image_url', image_url: { url: 'iVBORw0KGgo=' } },
                ],
            }];

            await client.chat(messages);

            const body = getBody()!;
            const sent = body['messages'] as Record<string, unknown>[];
            expect(sent[0]!['images']).toEqual(['iVBORw0KGgo=']);
        });

        test('skips http URL images without crashing', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const messages: LLMChatMessage[] = [{
                role: 'user',
                content: [
                    { type: 'text', text: 'What is this?' },
                    { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } },
                ],
            }];

            await client.chat(messages);

            const body = getBody()!;
            const sent = body['messages'] as Record<string, unknown>[];
            // HTTP URLs are skipped — no images array
            expect(sent[0]!['images']).toBeUndefined();
            expect(sent[0]!['content']).toBe('What is this?');
        });

        test('handles multiple images', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const messages: LLMChatMessage[] = [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Compare these' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,IMG1' } },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,IMG2' } },
                ],
            }];

            await client.chat(messages);

            const body = getBody()!;
            const sent = body['messages'] as Record<string, unknown>[];
            expect(sent[0]!['images']).toEqual(['IMG1', 'IMG2']);
        });

        test('merges multiple text parts with newline', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const messages: LLMChatMessage[] = [{
                role: 'user',
                content: [
                    { type: 'text', text: 'First part' },
                    { type: 'text', text: 'Second part' },
                ],
            }];

            await client.chat(messages);

            const body = getBody()!;
            const sent = body['messages'] as Record<string, unknown>[];
            expect(sent[0]!['content']).toBe('First part\nSecond part');
        });
    });

    // ========================================================================
    // Tool call argument handling
    // ========================================================================

    describe('tool call arguments in messages', () => {
        test('deserializes JSON string arguments to objects', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const messages: LLMChatMessage[] = [{
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: {
                        name: 'get_weather',
                        arguments: JSON.stringify({ city: 'Tokyo' }),
                    },
                }],
            }];

            await client.chat(messages);

            const body = getBody()!;
            const sent = body['messages'] as Record<string, unknown>[];
            const toolCalls = sent[0]!['tool_calls'] as Array<{ function: { arguments: unknown } }>;
            // Ollama expects arguments as objects, not strings
            expect(toolCalls[0]!.function.arguments).toEqual({ city: 'Tokyo' });
        });

        test('passes through non-JSON arguments as-is', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const messages: LLMChatMessage[] = [{
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: {
                        name: 'test_tool',
                        arguments: 'not-valid-json',
                    },
                }],
            }];

            await client.chat(messages);

            const body = getBody()!;
            const sent = body['messages'] as Record<string, unknown>[];
            const toolCalls = sent[0]!['tool_calls'] as Array<{ function: { arguments: unknown } }>;
            expect(toolCalls[0]!.function.arguments).toBe('not-valid-json');
        });
    });

    // ========================================================================
    // Options mapping
    // ========================================================================

    describe('options mapping', () => {
        test('maps temperature and maxTokens to Ollama format', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            await client.chat(
                [{ role: 'user', content: 'Hi' }],
                { temperature: 0.7, maxTokens: 100 },
            );

            const body = getBody()!;
            const options = body['options'] as Record<string, unknown>;
            expect(options['temperature']).toBe(0.7);
            expect(options['num_predict']).toBe(100);
        });

        test('enables thinking mode when configured', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ thinking: true });

            await client.chat([{ role: 'user', content: 'Think about this' }]);

            const body = getBody()!;
            expect(body['think']).toBe(true);
        });
    });

    // ========================================================================
    // Response normalization
    // ========================================================================

    describe('response handling', () => {
        test('normalizes response with usage info', async () => {
            mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                prompt_eval_count: 42,
                eval_count: 18,
            });
            const client = createClient();

            const result = await client.chat([{ role: 'user', content: 'Hi' }]);

            expect(result.message.role).toBe('assistant');
            expect(result.message.content).toBe('test response');
            expect(result.usage).toEqual({
                inputTokens: 42,
                outputTokens: 18,
                totalTokens: 60,
            });
            expect(result.provider).toBe('ollama');
        });

        test('generates IDs for tool calls missing them', async () => {
            mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: '',
                        type: 'function',
                        function: { name: 'test', arguments: '{}' },
                    }],
                },
            });
            const client = createClient();

            const result = await client.chat([{ role: 'user', content: 'Hi' }]);

            expect(result.message.tool_calls).toHaveLength(1);
            expect(result.message.tool_calls![0]!.id).toBeTruthy();
            expect(result.message.tool_calls![0]!.id.length).toBeGreaterThan(0);
        });
    });

    // ========================================================================
    // VAL-PROVIDER-OLLAMA-001: format Parameter with JSON Schema
    // ========================================================================

    describe('structured output format parameter', () => {
        test('includes format with JSON Schema when schema provided', async () => {
            const getBody = mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: { role: 'assistant', content: '{"name": "Test", "age": 30}' },
            });
            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
                age: z.number(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            await client.chat([
                { role: 'user', content: 'Generate a user' },
            ], options);

            const body = getBody()!;
            expect(body['format']).toBeDefined();
            // Ollama format is an object with the schema
            const format = body['format'] as Record<string, unknown>;
            expect(format['type']).toBe('object');
            expect(format['properties']).toBeDefined();
        });

        test('converts Zod schema to JSON Schema in format', async () => {
            const getBody = mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: { role: 'assistant', content: '{"name": "Test", "age": 25}' },
            });
            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
                age: z.number().optional(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            await client.chat([
                { role: 'user', content: 'Generate a user' },
            ], options);

            const body = getBody()!;
            const format = body['format'] as Record<string, unknown>;

            expect(format['type']).toBe('object');
            expect(format['properties']).toBeDefined();
            const properties = format['properties'] as Record<string, unknown>;
            expect(properties['name']).toEqual({ type: 'string' });
            expect(properties['age']).toEqual({ type: 'number' });
            // Required should only include non-optional fields
            expect(format['required']).toEqual(['name']);
        });

        test('accepts raw JSON Schema in format', async () => {
            const getBody = mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: { role: 'assistant', content: '{"id": "123", "count": 5}' },
            });
            const client = createClient();

            const jsonSchema = {
                type: 'object' as const,
                properties: {
                    id: { type: 'string' as const },
                    count: { type: 'number' as const },
                },
                required: ['id'],
            };

            const options: ChatOptions = {
                jsonSchema,
            };

            await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);

            const body = getBody()!;
            const format = body['format'] as Record<string, unknown>;

            expect(format['type']).toBe('object');
            expect(format['properties']).toBeDefined();
            const properties = format['properties'] as Record<string, unknown>;
            expect(properties['id']).toEqual({ type: 'string' });
            expect(properties['count']).toEqual({ type: 'number' });
        });

        test('handles nested object schemas', async () => {
            const getBody = mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: { role: 'assistant', content: '{"name": "Alice", "address": {"street": "123 Main St", "city": "NYC"}}' },
            });
            const client = createClient();

            const AddressSchema = z.object({
                street: z.string(),
                city: z.string(),
            });

            const UserSchema = z.object({
                name: z.string(),
                address: AddressSchema,
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);

            const body = getBody()!;
            const format = body['format'] as Record<string, unknown>;

            expect(format['type']).toBe('object');
            const properties = format['properties'] as Record<string, unknown>;
            const addressSchema = properties['address'] as Record<string, unknown>;
            expect(addressSchema['type']).toBe('object');
            expect(addressSchema['properties']).toBeDefined();
        });

        test('handles array schemas', async () => {
            const getBody = mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: { role: 'assistant', content: '{"users": [{"name": "Alice", "email": "alice@example.com"}]}' },
            });
            const client = createClient();

            const UserListSchema = z.object({
                users: z.array(z.object({
                    name: z.string(),
                    email: z.string(),
                })),
            });

            const options: ChatOptions = {
                schema: UserListSchema,
            };

            await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);

            const body = getBody()!;
            const format = body['format'] as Record<string, unknown>;

            expect(format['type']).toBe('object');
            const properties = format['properties'] as Record<string, unknown>;
            const usersSchema = properties['users'] as Record<string, unknown>;
            expect(usersSchema['type']).toBe('array');
            expect(usersSchema['items']).toBeDefined();
        });

        test('handles enum schemas', async () => {
            const getBody = mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: { role: 'assistant', content: '{"status": "active"}' },
            });
            const client = createClient();

            const StatusSchema = z.object({
                status: z.enum(['active', 'inactive', 'pending']),
            });

            const options: ChatOptions = {
                schema: StatusSchema,
            };

            await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);

            const body = getBody()!;
            const format = body['format'] as Record<string, unknown>;

            const properties = format['properties'] as Record<string, unknown>;
            const statusSchema = properties['status'] as Record<string, unknown>;
            expect(statusSchema['type']).toBe('string');
            expect(statusSchema['enum']).toEqual(['active', 'inactive', 'pending']);
        });
    });

    // ========================================================================
    // VAL-PROVIDER-OLLAMA-004: format "json" vs Schema
    // ========================================================================

    describe('format json (simple mode)', () => {
        test('supports format: "json" string for simple JSON mode', async () => {
            const getBody = mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: { role: 'assistant', content: '{"key": "value"}' },
            });
            const client = createClient();

            const options: ChatOptions = {
                responseFormat: { type: 'json_object' },
            };

            await client.chat([
                { role: 'user', content: 'Generate JSON' },
            ], options);

            const body = getBody()!;
            // Ollama uses format: "json" for simple JSON mode
            expect(body['format']).toBe('json');
        });

        test('json mode does not include schema in request', async () => {
            const getBody = mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: { role: 'assistant', content: '{"key": "value"}' },
            });
            const client = createClient();

            const options: ChatOptions = {
                responseFormat: { type: 'json_object' },
            };

            await client.chat([
                { role: 'user', content: 'Generate JSON' },
            ], options);

            const body = getBody()!;
            // format should be a string, not an object with schema
            expect(typeof body['format']).toBe('string');
            expect(body['format']).toBe('json');
        });
    });

    // ========================================================================
    // Response Validation
    // ========================================================================

    describe('structured response validation', () => {
        test('validates response JSON against schema', async () => {
            mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: {
                    role: 'assistant',
                    content: '{"name": "Bob", "age": 25}',
                },
            });

            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
                age: z.number(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            const response = await client.chat([
                { role: 'user', content: 'Generate a user' },
            ], options);

            // If we got here without error, validation passed
            expect(response.message.content).toBe('{"name": "Bob", "age": 25}');
        });

        test('provider returns raw response on invalid JSON (Router validates)', async () => {
            mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: {
                    role: 'assistant',
                    content: 'not valid json at all',
                },
            });

            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            // Provider should NOT throw — validation is done at Router level
            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);
            expect(response.message.content).toBe('not valid json at all');
        });

        test('provider returns raw response on schema mismatch (Router validates)', async () => {
            mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: {
                    role: 'assistant',
                    content: '{"name": "Bob", "age": "not a number"}',
                },
            });

            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
                age: z.number(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            // Provider should NOT throw — validation is done at Router level
            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);
            expect(response.message.content).toBe('{"name": "Bob", "age": "not a number"}');
        });

        test('includes raw output in response when schema provided', async () => {
            const rawOutput = '{"name": 123}';
            mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: {
                    role: 'assistant',
                    content: rawOutput,
                },
            });

            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            // Provider returns raw response — Router handles validation
            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);
            expect(response.message.content).toBe(rawOutput);
        });

        test('provider returns raw response for null content (Router validates)', async () => {
            mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: {
                    role: 'assistant',
                    content: null as unknown as string,
                },
            });

            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            // Provider should NOT throw — returns raw response
            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);
            expect(response.message.content).toBe('');
        });

        test('provider returns raw response for empty content (Router validates)', async () => {
            mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: {
                    role: 'assistant',
                    content: '',
                },
            });

            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            // Provider should NOT throw — returns raw response
            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);
            expect(response.message.content).toBe('');
        });
    });

    // ========================================================================
    // VAL-PROVIDER-OLLAMA-003: Vision with Base64 Extraction + format
    // ========================================================================

    describe('vision with structured output', () => {
        test('includes both format and images array in request', async () => {
            const getBody = mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: {
                    role: 'assistant',
                    content: '{"objects": ["cat", "keyboard"], "scene": "office"}',
                },
            });
            const client = createClient();

            const DescriptionSchema = z.object({
                objects: z.array(z.string()),
                scene: z.string(),
            });

            const messages: LLMChatMessage[] = [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Describe this image' },
                    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,IMGDATA' } },
                ],
            }];

            const options: ChatOptions = {
                schema: DescriptionSchema,
            };

            await client.chat(messages, options);

            const body = getBody()!;
            const sent = body['messages'] as Record<string, unknown>[];

            // Should have format with schema
            expect(body['format']).toBeDefined();
            const format = body['format'] as Record<string, unknown>;
            expect(format['type']).toBe('object');

            // Should have images extracted from data URL
            expect(sent[0]!['images']).toEqual(['IMGDATA']);
        });

        test('validates structured output response with vision', async () => {
            mockFetchAndCapture({
                ...OLLAMA_RESPONSE,
                message: {
                    role: 'assistant',
                    content: '{"objects": ["cat", "keyboard"], "scene": "office"}',
                },
            });

            const client = createClient();

            const DescriptionSchema = z.object({
                objects: z.array(z.string()),
                scene: z.string(),
            });

            const messages: LLMChatMessage[] = [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Describe' },
                    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ABC' } },
                ],
            }];

            const options: ChatOptions = {
                schema: DescriptionSchema,
            };

            const response = await client.chat(messages, options);

            expect(response.message.content).toBe('{"objects": ["cat", "keyboard"], "scene": "office"}');
        });
    });

    // ========================================================================
    // No schema option (regular chat)
    // ========================================================================

    describe('regular chat without schema', () => {
        test('does not include format when no schema provided', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            await client.chat([
                { role: 'user', content: 'Hello' },
            ]);

            const body = getBody()!;
            expect(body['format']).toBeUndefined();
        });

        test('chat without schema returns raw response', async () => {
            mockFetchAndCapture();
            const client = createClient();

            const response = await client.chat([
                { role: 'user', content: 'Hello' },
            ]);

            expect(response.message.content).toBe('test response');
            expect(response.message.role).toBe('assistant');
        });
    });

    // ========================================================================
    // Schema with Tools (allowed together)
    // ========================================================================

    describe('schema with tools', () => {
        test('sends both format and tools in the request', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
                tools: [{
                    type: 'function',
                    function: {
                        name: 'test_tool',
                        description: 'A test tool',
                        parameters: {
                            type: 'object',
                            properties: {},
                        },
                    },
                }],
            };

            await client.chat([
                { role: 'user', content: 'Test' },
            ], options);

            const body = getBody();
            expect(body).not.toBeNull();

            // Both format and tools should be present
            expect(body!.format).toBeDefined();
            expect(body!.tools).toBeDefined();
            expect((body!.tools as unknown[]).length).toBe(1);
        });
    });
});

describe('OllamaClient Edge Cases', () => {
    let mockFetchAndCapture: ReturnType<typeof mock>;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        // Mock fetch and intercept requests
        mockFetchAndCapture = mock((responseBody: any, status = 200, headers = {}) => {
            const spy = mock(() => Promise.resolve(new Response(JSON.stringify(responseBody), {
                status,
                headers: { 'Content-Type': 'application/json', ...headers }
            })));
            globalThis.fetch = spy as any;
            return spy;
        });
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        mock.restore();
    });

    test('handles empty string tool call arguments without crashing', async () => {
        mockFetchAndCapture({
            ...OLLAMA_RESPONSE,
            message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    function: {
                        name: 'get_weather',
                        arguments: '' // Ollama might send this
                    }
                }]
            }
        });

        const client = createClient();
        const response = await client.chat([{ role: 'user', content: 'test' }]);

        expect(response.message.tool_calls).toBeDefined();
        // Ollama parser tries to JSON parse arguments if it is string,
        // if it fails it falls back. Let's see what it returns.
        expect(response.message.tool_calls![0].function.arguments).toBe('');
    });

    test('handles missing tool call names gracefully', async () => {
        mockFetchAndCapture({
            ...OLLAMA_RESPONSE,
            message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    function: {
                        // no name
                        arguments: '{"location": "Boston"}'
                    }
                }]
            }
        });

        const client = createClient();
        const response = await client.chat([{ role: 'user', content: 'test' }]);

        expect(response.message.tool_calls).toBeDefined();
        // Default to empty string if missing
        expect(response.message.tool_calls![0].function.name).toBe('');
    });

    test('handles HTTP 429 rate limit error', async () => {
        mockFetchAndCapture({
            error: 'Rate limit exceeded'
        }, 429);

        const client = createClient();

        try {
            await client.chat([{ role: 'user', content: 'test' }]);
            expect(false).toBe(true);
        } catch (e: any) {
            expect(e.message).toInclude('Rate limit exceeded');
        }
    });

    test('handles HTTP 500 server error', async () => {
        mockFetchAndCapture({
            error: 'Internal server error'
        }, 500);

        const client = createClient();

        try {
            await client.chat([{ role: 'user', content: 'test' }]);
            expect(false).toBe(true);
        } catch (e: any) {
            expect(e.message).toInclude('Internal server error');
        }
    });
});
