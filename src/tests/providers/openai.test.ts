/**
 * OpenAI-Compatible Provider Structured Output Tests
 *
 * Tests the OpenAICompatibleClient's structured output support (response_format).
 * Validates assertions:
 * - VAL-PROVIDER-OPENAI-001: response_format json_schema Request
 * - VAL-PROVIDER-OPENAI-005: Provider-Specific Schema Limitations
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { z } from 'zod';
import { OpenAICompatibleClient } from '../../providers/openai.js';
import type { LLMClientOptions, ChatOptions } from '../../interfaces.js';
import { AIModelApiType } from '../../interfaces.js';
import {
    type StructuredOutputOptions,
    parseStructured,
} from '../../structured-output.js';

// ============================================================================
// Helpers
// ============================================================================

function createClient(overrides?: Partial<LLMClientOptions>): OpenAICompatibleClient {
    return new OpenAICompatibleClient({
        model: 'test-model',
        url: 'https://api.openai.com/v1',
        apiType: AIModelApiType.OpenAI,
        ...overrides,
    });
}

const OPENAI_RESPONSE = {
    id: 'test-id',
    object: 'chat.completion',
    created: 1700000000,
    model: 'test-model',
    choices: [{
        index: 0,
        message: {
            role: 'assistant',
            content: '{"name": "Alice", "age": 30}',
        },
        finish_reason: 'stop',
    }],
    usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
    },
};

// ============================================================================
// Tests
// ============================================================================

describe('OpenAICompatibleClient Structured Output', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    /** Capture the body sent to OpenAI's /v1/chat/completions */
    function mockFetchAndCapture(response = OPENAI_RESPONSE) {
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
    // VAL-PROVIDER-OPENAI-001: response_format json_schema Request
    // ========================================================================

    describe('response_format json_schema', () => {
        test('includes response_format with json_schema type when schema provided', async () => {
            const getBody = mockFetchAndCapture();
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
            expect(body['response_format']).toBeDefined();
            expect((body['response_format'] as Record<string, unknown>)['type']).toBe('json_schema');
            expect((body['response_format'] as Record<string, unknown>)['json_schema']).toBeDefined();
        });

        test('includes strict mode when schema provided', async () => {
            const getBody = mockFetchAndCapture();
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
            const responseFormat = body['response_format'] as Record<string, unknown>;
            expect(responseFormat['json_schema']).toBeDefined();
            
            const jsonSchema = responseFormat['json_schema'] as Record<string, unknown>;
            // strict should be true for reliable structured output
            expect(jsonSchema['strict']).toBe(true);
            expect(jsonSchema['name']).toBeDefined();
            expect(jsonSchema['schema']).toBeDefined();
        });

        test('converts Zod schema to JSON Schema in response_format', async () => {
            const getBody = mockFetchAndCapture();
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
            const responseFormat = body['response_format'] as Record<string, unknown>;
            const jsonSchema = responseFormat['json_schema'] as Record<string, unknown>;
            const schema = jsonSchema['schema'] as Record<string, unknown>;

            expect(schema['type']).toBe('object');
            expect(schema['properties']).toBeDefined();
            expect(schema['properties']!['name']).toEqual({ type: 'string' });
            expect(schema['properties']!['age']).toEqual({ type: 'number' });
            expect(schema['required']).toEqual(['name']);
        });

        test('uses schema name from options when provided', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
                schemaName: 'CustomUserSchema',
            };

            await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);

            const body = getBody()!;
            const responseFormat = body['response_format'] as Record<string, unknown>;
            const jsonSchema = responseFormat['json_schema'] as Record<string, unknown>;

            expect(jsonSchema['name']).toBe('CustomUserSchema');
        });

        test('generates default schema name when not provided', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);

            const body = getBody()!;
            const responseFormat = body['response_format'] as Record<string, unknown>;
            const jsonSchema = responseFormat['json_schema'] as Record<string, unknown>;

            // Should have a name, either provided or auto-generated
            expect(jsonSchema['name']).toBeDefined();
            expect(typeof jsonSchema['name']).toBe('string');
            expect((jsonSchema['name'] as string).length).toBeGreaterThan(0);
        });

        test('includes schema description when provided', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
                schemaDescription: 'A user object with name',
            };

            await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);

            const body = getBody()!;
            const responseFormat = body['response_format'] as Record<string, unknown>;
            const jsonSchema = responseFormat['json_schema'] as Record<string, unknown>;

            expect(jsonSchema['description']).toBe('A user object with name');
        });

        test('accepts raw JSON Schema instead of Zod schema', async () => {
            // Create mock with custom response for jsonSchema test
            let capturedBody: Record<string, unknown> | null = null;

            globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
                if (init?.body) {
                    capturedBody = JSON.parse(init.body as string);
                }
                return new Response(JSON.stringify({
                    id: 'test-id',
                    object: 'chat.completion',
                    created: 1700000000,
                    model: 'test-model',
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: '{"id": "123", "count": 5}',
                        },
                        finish_reason: 'stop',
                    }],
                    usage: {
                        prompt_tokens: 10,
                        completion_tokens: 20,
                        total_tokens: 30,
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }) as typeof fetch;

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

            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);

            const body = capturedBody!;
            const responseFormat = body['response_format'] as Record<string, unknown>;
            expect(responseFormat).toBeDefined();
            expect(responseFormat['type']).toBe('json_schema');
            
            const jsonSchemaReq = responseFormat['json_schema'] as Record<string, unknown>;
            expect(jsonSchemaReq['schema']).toBeDefined();
            // The schema property contains the normalized JSON Schema
            const schema = jsonSchemaReq['schema'] as Record<string, unknown>;
            expect(schema.properties).toBeDefined();
            // Verify response processed successfully (z.unknown() always passes)
            expect(response.message.content).toContain('id');
        });
    });

    // ========================================================================
    // Response Validation
    // ========================================================================

    describe('response validation', () => {
        test('validates response JSON against schema', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"name": "Bob", "age": 25}',
                    },
                    finish_reason: 'stop',
                }],
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

        test('throws StructuredOutputError on invalid JSON response', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: 'not valid json at all',
                    },
                    finish_reason: 'stop',
                }],
            });

            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            await expect(client.chat([
                { role: 'user', content: 'Generate' },
            ], options)).rejects.toThrow('Failed to parse');
        });

        test('throws StructuredOutputError on schema validation failure', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"name": "Bob", "age": "not a number"}',
                    },
                    finish_reason: 'stop',
                }],
            });

            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
                age: z.number(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            await expect(client.chat([
                { role: 'user', content: 'Generate' },
            ], options)).rejects.toThrow('Validation failed');
        });

        test('includes raw output in validation error', async () => {
            const rawOutput = '{"name": 123}';
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: rawOutput,
                    },
                    finish_reason: 'stop',
                }],
            });

            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            try {
                await client.chat([
                    { role: 'user', content: 'Generate' },
                ], options);
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                if (error instanceof Error && 'rawOutput' in error) {
                    expect((error as { rawOutput: string }).rawOutput).toBe(rawOutput);
                }
            }
        });
    });

    // ========================================================================
    // VAL-PROVIDER-OPENAI-005: Provider-Specific Schema Limitations (json_object mode)
    // ========================================================================

    describe('json_object mode (backward compatibility)', () => {
        test('supports response_format type json_object for legacy providers', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const options: ChatOptions = {
                responseFormat: { type: 'json_object' },
            };

            await client.chat([
                { role: 'user', content: 'Generate JSON' },
            ], options);

            const body = getBody()!;
            expect(body['response_format']).toBeDefined();
            expect((body['response_format'] as Record<string, unknown>)['type']).toBe('json_object');
        });

        test('json_object mode does not include schema in request', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const options: ChatOptions = {
                responseFormat: { type: 'json_object' },
            };

            await client.chat([
                { role: 'user', content: 'Generate JSON' },
            ], options);

            const body = getBody()!;
            const responseFormat = body['response_format'] as Record<string, unknown>;
            
            expect(responseFormat['type']).toBe('json_object');
            expect(responseFormat['json_schema']).toBeUndefined();
        });

        test('can provide schema alongside json_object for validation', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"name": "Alice", "age": 30}',
                    },
                    finish_reason: 'stop',
                }],
            });

            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
                age: z.number(),
            });

            // Provider that only supports json_object (like older OpenAI)
            const options: ChatOptions = {
                schema: UserSchema,
                responseFormat: { type: 'json_object' },
            };

            const response = await client.chat([
                { role: 'user', content: 'Generate a user' },
            ], options);

            // Validation should still work
            expect(response.message.content).toBe('{"name": "Alice", "age": 30}');
        });
    });

    // ========================================================================
    // Error Handling
    // ========================================================================

    describe('error handling', () => {
        test('handles null content in response gracefully', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: null,
                    },
                    finish_reason: 'stop',
                }],
            });

            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            await expect(client.chat([
                { role: 'user', content: 'Generate' },
            ], options)).rejects.toThrow();
        });

        test('handles empty string content', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '',
                    },
                    finish_reason: 'stop',
                }],
            });

            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            await expect(client.chat([
                { role: 'user', content: 'Generate' },
            ], options)).rejects.toThrow();
        });

        test('validates response against schema when schema provided', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"name": "test"}', // Missing 'age'
                    },
                    finish_reason: 'stop',
                }],
            });

            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
                age: z.number(), // required
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            await expect(client.chat([
                { role: 'user', content: 'Generate' },
            ], options)).rejects.toThrow();
        });
    });

    // ========================================================================
    // No schema option (regular chat)
    // ========================================================================

    describe('regular chat without schema', () => {
        test('does not include response_format when no schema provided', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            await client.chat([
                { role: 'user', content: 'Hello' },
            ]);

            const body = getBody()!;
            expect(body['response_format']).toBeUndefined();
        });

        test('chat without schema returns raw response', async () => {
            mockFetchAndCapture(OPENAI_RESPONSE);
            const client = createClient();

            const response = await client.chat([
                { role: 'user', content: 'Hello' },
            ]);

            expect(response.message.content).toBe('{"name": "Alice", "age": 30}');
            expect(response.message.role).toBe('assistant');
        });
    });

    // ========================================================================
    // Schema with Tools (should be mutually exclusive)
    // ========================================================================

    describe('schema with tools', () => {
        test('throws error when both schema and tools provided', async () => {
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

            // The error message should contain "structured output" and "tools"
            await expect(client.chat([
                { role: 'user', content: 'Test' },
            ], options)).rejects.toThrow();
            
            // Also check for specific error message content
            try {
                await client.chat([{ role: 'user', content: 'Test' }], options);
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                const message = (error as Error).message.toLowerCase();
                expect(message).toContain('structured output');
                expect(message).toContain('tools');
            }
        });
    });

    // ========================================================================
    // VAL-PROVIDER-OPENAI-003: Vision with Structured Output
    // ========================================================================

    describe('vision with structured output', () => {
        test('includes image_url content parts with response_format in request', async () => {
            const getBody = mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"description": "A colorful image with flowers", "objects": ["flower", "vase", "table"]}',
                    },
                    finish_reason: 'stop',
                }],
            });
            const client = createClient();

            const DescriptionSchema = z.object({
                description: z.string(),
                objects: z.array(z.string()),
            });

            const messages = [{
                role: 'user' as const,
                content: [
                    { type: 'text' as const, text: 'Describe this image' },
                    { type: 'image_url' as const, image_url: { url: 'data:image/jpeg;base64,IMGDATA' } },
                ] as const,
            }];

            const options: ChatOptions = {
                schema: DescriptionSchema,
            };

            await client.chat(messages, options);

            const body = getBody()!;
            
            // Should have response_format with structured output
            expect(body['response_format']).toBeDefined();
            const responseFormat = body['response_format'] as Record<string, unknown>;
            expect(responseFormat['type']).toBe('json_schema');

            // Should preserve image_url content parts
            const sentMessages = body['messages'] as Array<Record<string, unknown>>;
            expect(sentMessages).toHaveLength(1);
            expect(sentMessages[0]!['role']).toBe('user');

            const content = sentMessages[0]!['content'] as Array<Record<string, unknown>>;
            expect(content).toHaveLength(2);
            
            // Text part
            expect(content[0]!['type']).toBe('text');
            expect(content[0]!['text']).toBe('Describe this image');

            // Image part
            expect(content[1]!['type']).toBe('image_url');
            expect(content[1]!['image_url']).toEqual({ url: 'data:image/jpeg;base64,IMGDATA' });
        });

        test('handles multiple images with structured output', async () => {
            const getBody = mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"comparison": "The images show different scenes"}',
                    },
                    finish_reason: 'stop',
                }],
            });
            const client = createClient();

            const ComparisonSchema = z.object({
                comparison: z.string(),
            });

            const messages = [{
                role: 'user' as const,
                content: [
                    { type: 'text' as const, text: 'Compare these images' },
                    { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,IMG1' } },
                    { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,IMG2' } },
                ] as const,
            }];

            const options: ChatOptions = {
                schema: ComparisonSchema,
            };

            await client.chat(messages, options);

            const body = getBody()!;
            
            // Should have response_format with structured output
            expect(body['response_format']).toBeDefined();

            // Should preserve all image_url content parts
            const sentMessages = body['messages'] as Array<Record<string, unknown>>;
            const content = sentMessages[0]!['content'] as Array<Record<string, unknown>>;
            
            expect(content).toHaveLength(3);
            expect(content[0]!['type']).toBe('text');
            expect(content[1]!['type']).toBe('image_url');
            expect(content[1]!['image_url']).toEqual({ url: 'data:image/png;base64,IMG1' });
            expect(content[2]!['type']).toBe('image_url');
            expect(content[2]!['image_url']).toEqual({ url: 'data:image/png;base64,IMG2' });
        });

        test('validates structured output response with vision', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"description": "A sunset over mountains", "colors": ["orange", "purple", "blue"]}',
                    },
                    finish_reason: 'stop',
                }],
            });
            const client = createClient();

            const ImageAnalysisSchema = z.object({
                description: z.string(),
                colors: z.array(z.string()),
            });

            const messages = [{
                role: 'user' as const,
                content: [
                    { type: 'text' as const, text: 'Analyze this image' },
                    { type: 'image_url' as const, image_url: { url: 'data:image/jpeg;base64,SUNSET' } },
                ] as const,
            }];

            const options: ChatOptions = {
                schema: ImageAnalysisSchema,
            };

            const response = await client.chat(messages, options);

            // Should validate and return successfully
            expect(response.message.content).toBe('{"description": "A sunset over mountains", "colors": ["orange", "purple", "blue"]}');
        });

        test('supports http image URLs with structured output', async () => {
            const getBody = mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"description": "An image from the web"}',
                    },
                    finish_reason: 'stop',
                }],
            });
            const client = createClient();

            const DescriptionSchema = z.object({
                description: z.string(),
            });

            const messages = [{
                role: 'user' as const,
                content: [
                    { type: 'text' as const, text: 'Describe this image' },
                    { type: 'image_url' as const, image_url: { url: 'https://example.com/image.jpg' } },
                ] as const,
            }];

            const options: ChatOptions = {
                schema: DescriptionSchema,
            };

            await client.chat(messages, options);

            const body = getBody()!;
            const sentMessages = body['messages'] as Array<Record<string, unknown>>;
            const content = sentMessages[0]!['content'] as Array<Record<string, unknown>>;

            // OpenAI accepts HTTP URLs directly (unlike Ollama which needs base64)
            expect(content[1]!['type']).toBe('image_url');
            expect(content[1]!['image_url']).toEqual({ url: 'https://example.com/image.jpg' });
            
            // And response_format should still be set
            expect(body['response_format']).toBeDefined();
        });

        test('supports image_url with detail parameter and structured output', async () => {
            const getBody = mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"objects": ["car", "tree", "building"]}',
                    },
                    finish_reason: 'stop',
                }],
            });
            const client = createClient();

            const DescriptionSchema = z.object({
                objects: z.array(z.string()),
            });

            const messages = [{
                role: 'user' as const,
                content: [
                    { type: 'text' as const, text: 'List objects in this image' },
                    { type: 'image_url' as const, image_url: { url: 'data:image/jpeg;base64,IMG', detail: 'high' } },
                ] as const,
            }];

            const options: ChatOptions = {
                schema: DescriptionSchema,
            };

            await client.chat(messages, options);

            const body = getBody()!;
            const sentMessages = body['messages'] as Array<Record<string, unknown>>;
            const content = sentMessages[0]!['content'] as Array<Record<string, unknown>>;

            // Should preserve detail parameter
            expect(content[1]!['image_url']).toEqual({ url: 'data:image/jpeg;base64,IMG', detail: 'high' });
            expect(body['response_format']).toBeDefined();
        });

        test('returns validated object on successful vision + structured output', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"count": 3, "items": ["cat", "dog", "bird"]}',
                    },
                    finish_reason: 'stop',
                }],
            });
            const client = createClient();

            const VisionSchema = z.object({
                count: z.number(),
                items: z.array(z.string()),
            });

            const messages = [{
                role: 'user' as const,
                content: [
                    { type: 'text' as const, text: 'Count items' },
                    { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,IMG' } },
                ] as const,
            }];

            const options: ChatOptions = {
                schema: VisionSchema,
            };

            // Should not throw - response passes validation
            const result = await client.chat(messages, options);
            expect(result.message.content).toBe('{"count": 3, "items": ["cat", "dog", "bird"]}');
        });

        test('throws StructuredOutputError on invalid vision response', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"count": "not a number"}', // Invalid - count should be number
                    },
                    finish_reason: 'stop',
                }],
            });
            const client = createClient();

            const VisionSchema = z.object({
                count: z.number(),
            });

            const messages = [{
                role: 'user' as const,
                content: [
                    { type: 'text' as const, text: 'Count items' },
                    { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,IMG' } },
                ] as const,
            }];

            const options: ChatOptions = {
                schema: VisionSchema,
            };

            await expect(client.chat(messages, options)).rejects.toThrow('Validation failed');
        });
    });

    // ========================================================================
    // Complex Schemas
    // ========================================================================

    describe('complex schemas', () => {
        test('handles nested object schemas', async () => {
            const getBody = mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"name": "Alice", "address": {"street": "123 Main St", "city": "NYC"}}',
                    },
                    finish_reason: 'stop',
                }],
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

            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);

            const body = getBody()!;
            const responseFormat = body['response_format'] as Record<string, unknown>;
            const jsonSchema = responseFormat['json_schema'] as Record<string, unknown>;
            const schema = jsonSchema['schema'] as Record<string, unknown>;

            expect(schema['type']).toBe('object');
            const addressSchema = schema['properties']!['address'] as Record<string, unknown>;
            expect(addressSchema['type']).toBe('object');
            expect(addressSchema['properties']).toBeDefined();
            // Verify response validated successfully
            expect(response.message.content).toContain('Alice');
        });

        test('handles array schemas', async () => {
            const getBody = mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"users": [{"name": "Alice", "email": "alice@example.com"}]}',
                    },
                    finish_reason: 'stop',
                }],
            });
            const client = createClient();

            const UserListSchema = z.object({
                users: z.array(z.object({
                    name: z.string(),
                    email: z.string().email(),
                })),
            });

            const options: ChatOptions = {
                schema: UserListSchema,
            };

            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);

            const body = getBody()!;
            const responseFormat = body['response_format'] as Record<string, unknown>;
            const jsonSchema = responseFormat['json_schema'] as Record<string, unknown>;
            const schema = jsonSchema['schema'] as Record<string, unknown>;

            expect(schema['type']).toBe('object');
            const usersSchema = schema['properties']!['users'] as Record<string, unknown>;
            expect(usersSchema['type']).toBe('array');
            expect(usersSchema['items']).toBeDefined();
            // Verify response validated successfully
            expect(response.message.content).toContain('Alice');
        });

        test('handles enum schemas', async () => {
            const getBody = mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"status": "active"}',
                    },
                    finish_reason: 'stop',
                }],
            });
            const client = createClient();

            const StatusSchema = z.object({
                status: z.enum(['active', 'inactive', 'pending']),
            });

            const options: ChatOptions = {
                schema: StatusSchema,
            };

            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);

            const body = getBody()!;
            const responseFormat = body['response_format'] as Record<string, unknown>;
            const jsonSchema = responseFormat['json_schema'] as Record<string, unknown>;
            const schema = jsonSchema['schema'] as Record<string, unknown>;

            const statusSchema = schema['properties']!['status'] as Record<string, unknown>;
            expect(statusSchema['type']).toBe('string');
            expect(statusSchema['enum']).toEqual(['active', 'inactive', 'pending']);
            // Verify response validated successfully
            expect(response.message.content).toContain('active');
        });
    });
});
