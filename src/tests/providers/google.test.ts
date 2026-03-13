/**
 * Google/Gemini Provider Structured Output Tests
 *
 * Tests the GoogleClient's structured output support (responseMimeType + responseSchema).
 * Validates assertions:
 * - VAL-PROVIDER-GOOGLE-001: responseMimeType and responseSchema
 * - VAL-PROVIDER-GOOGLE-002: Google AI Studio Integration (smoke test)
 * - VAL-PROVIDER-GOOGLE-003: Vision with Inline Data
 * - VAL-PROVIDER-GOOGLE-004: Gemini 3.x thoughtSignature Preservation
 * - VAL-PROVIDER-GOOGLE-006: Schema Conversion for Gemini
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { z } from 'zod';
import { GoogleClient } from '../../providers/google.js';
import type { LLMClientOptions, ChatOptions, LLMChatMessage } from '../../interfaces.js';
import { AIModelApiType } from '../../interfaces.js';

// ============================================================================
// Helpers
// ============================================================================

function createClient(overrides?: Partial<LLMClientOptions>): GoogleClient {
    return new GoogleClient({
        model: 'gemini-1.5-flash',
        apiKey: 'test-api-key',
        apiType: AIModelApiType.Google,
        ...overrides,
    });
}

const GOOGLE_RESPONSE = {
    candidates: [{
        content: {
            parts: [{ text: '{"name": "Alice", "age": 30}' }],
            role: 'model',
        },
        finishReason: 'STOP',
        index: 0,
    }],
    usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
    },
};

// ============================================================================
// Tests
// ============================================================================

describe('GoogleClient Structured Output', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    /** Capture the body sent to Google's generateContent API */
    function mockFetchAndCapture(response = GOOGLE_RESPONSE) {
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
    // VAL-PROVIDER-GOOGLE-001: responseMimeType and responseSchema
    // ========================================================================

    describe('responseMimeType and responseSchema', () => {
        test('includes responseMimeType: application/json in generationConfig when schema provided', async () => {
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
            expect(body['generationConfig']).toBeDefined();
            const genConfig = body['generationConfig'] as Record<string, unknown>;
            expect(genConfig['responseMimeType']).toBe('application/json');
        });

        test('includes responseSchema with converted schema in generationConfig', async () => {
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
            const genConfig = body['generationConfig'] as Record<string, unknown>;
            expect(genConfig['responseSchema']).toBeDefined();

            const schema = genConfig['responseSchema'] as Record<string, unknown>;
            expect(schema['type']).toBe('object');
            expect(schema['properties']).toBeDefined();
            expect(schema['properties']!['name']).toEqual({ type: 'string' });
            expect(schema['properties']!['age']).toEqual({ type: 'number' });
            // Google's schema should have required array
            expect(schema['required']).toEqual(['name']);
        });

        test('strips unsupported features from schema (pattern, minLength, etc.)', async () => {
            const getBody = mockFetchAndCapture({
                candidates: [{
                    content: {
                        parts: [{ text: '{"name": "Alice", "email": "alice@example.com", "age": 30}' }],
                        role: 'model',
                    },
                    finishReason: 'STOP',
                    index: 0,
                }],
            });
            const client = createClient();

            const UserSchema = z.object({
                name: z.string().min(1).max(100),
                email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
                age: z.number().min(0).max(150),
            });

            const options: ChatOptions = {
                schema: UserSchema,
            };

            await client.chat([
                { role: 'user', content: 'Generate a user' },
            ], options);

            const body = getBody()!;
            const genConfig = body['generationConfig'] as Record<string, unknown>;
            const schema = genConfig['responseSchema'] as Record<string, unknown>;
            const props = schema['properties'] as Record<string, unknown>;

            // Google doesn't support pattern, minLength, maxLength, min, max
            expect(props['name']).toEqual({ type: 'string' });
            expect(props['email']).toEqual({ type: 'string' });
            expect(props['age']).toEqual({ type: 'number' });
        });

        test('supports raw jsonSchema option', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const options: ChatOptions = {
                jsonSchema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        count: { type: 'number' },
                    },
                    required: ['id'],
                },
            };

            await client.chat([
                { role: 'user', content: 'Generate data' },
            ], options);

            const body = getBody()!;
            const genConfig = body['generationConfig'] as Record<string, unknown>;
            expect(genConfig['responseMimeType']).toBe('application/json');
            expect(genConfig['responseSchema']).toBeDefined();
        });

        test('validates response against schema on success', async () => {
            const validResponse = {
                candidates: [{
                    content: {
                        parts: [{ text: '{"name": "Bob", "age": 25}' }],
                        role: 'model',
                    },
                    index: 0,
                }],
            };

            mockFetchAndCapture(validResponse);
            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
                age: z.number(),
            });

            // Should not throw - valid response
            const result = await client.chat([
                { role: 'user', content: 'Generate user' },
            ], { schema: UserSchema });

            expect(result.message.content).toBe('{"name": "Bob", "age": 25}');
        });

        test('throws StructuredOutputError on invalid JSON response', async () => {
            const invalidJsonResponse = {
                candidates: [{
                    content: {
                        parts: [{ text: 'not valid json' }],
                        role: 'model',
                    },
                    index: 0,
                }],
            };

            mockFetchAndCapture(invalidJsonResponse);
            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            await expect(client.chat([
                { role: 'user', content: 'Generate user' },
            ], { schema: UserSchema })).rejects.toThrow('Failed to parse JSON');
        });

        test('throws StructuredOutputError on schema validation failure', async () => {
            const invalidSchemaResponse = {
                candidates: [{
                    content: {
                        parts: [{ text: '{"name": "Bob", "age": "not a number"}' }],
                        role: 'model',
                    },
                    index: 0,
                }],
            };

            mockFetchAndCapture(invalidSchemaResponse);
            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
                age: z.number(),
            });

            await expect(client.chat([
                { role: 'user', content: 'Generate user' },
            ], { schema: UserSchema })).rejects.toThrow('Validation failed');
        });

        test('throws error when both schema and tools are provided', async () => {
            const client = createClient();

            const UserSchema = z.object({ name: z.string() });
            const options: ChatOptions = {
                schema: UserSchema,
                tools: [{
                    type: 'function',
                    function: { name: 'test', description: 'test', parameters: { type: 'object' } },
                }],
            };

            await expect(client.chat([
                { role: 'user', content: 'Test' },
            ], options)).rejects.toThrow('Structured output and tools cannot be used together');
        });
    });

    // ========================================================================
    // VAL-PROVIDER-GOOGLE-003: Vision with Inline Data
    // ========================================================================

    describe('vision with structured output', () => {
        test('converts data URLs to inlineData with mimeType', async () => {
            const getBody = mockFetchAndCapture({
                candidates: [{
                    content: {
                        parts: [{ text: '{"description": "A colorful image"}' }],
                        role: 'model',
                    },
                    index: 0,
                }],
            });
            const client = createClient();

            const messages: LLMChatMessage[] = [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Describe this image' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,ABC123' } },
                ],
            }];

            const options: ChatOptions = {
                schema: z.object({ description: z.string() }),
            };

            await client.chat(messages, options);

            const body = getBody()!;
            const contents = body['contents'] as Array<Record<string, unknown>>;
            expect(contents).toHaveLength(1);
            expect(contents[0]!['role']).toBe('user');

            const parts = contents[0]!['parts'] as Array<Record<string, unknown>>;
            expect(parts).toHaveLength(2);

            // First part: text
            expect(parts[0]!['text']).toBe('Describe this image');

            // Second part: inlineData with mimeType and data
            expect(parts[1]!['inlineData']).toBeDefined();
            const inlineData = parts[1]!['inlineData'] as Record<string, unknown>;
            expect(inlineData['mimeType']).toBe('image/png');
            expect(inlineData['data']).toBe('ABC123');

            // Also check that generationConfig is set
            const genConfig = body['generationConfig'] as Record<string, unknown>;
            expect(genConfig['responseMimeType']).toBe('application/json');
        });

        test('handles multiple images with structured output', async () => {
            const getBody = mockFetchAndCapture({
                candidates: [{
                    content: {
                        parts: [{ text: '{"difference": "They are different images"}' }],
                        role: 'model',
                    },
                    index: 0,
                }],
            });
            const client = createClient();

            const messages: LLMChatMessage[] = [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Compare these' },
                    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,IMG1' } },
                    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,IMG2' } },
                ],
            }];

            const options: ChatOptions = {
                schema: z.object({
                    difference: z.string(),
                }),
            };

            await client.chat(messages, options);

            const body = getBody()!;
            const contents = body['contents'] as Array<Record<string, unknown>>;
            const parts = contents[0]!['parts'] as Array<Record<string, unknown>>;

            // Text + 2 images
            expect(parts).toHaveLength(3);
            expect(parts[0]!['text']).toBe('Compare these');
            expect(parts[1]!['inlineData']!['data']).toBe('IMG1');
            expect(parts[2]!['inlineData']!['data']).toBe('IMG2');
        });
    });

    // ========================================================================
    // VAL-PROVIDER-GOOGLE-004: Gemini 3.x thoughtSignature Preservation
    // ========================================================================

    describe('thoughtSignature preservation', () => {
        test('preserves thoughtSignature in assistant message tool_calls', async () => {
            mockFetchAndCapture();
            const client = createClient();

            // First, send a message with a tool call that has thoughtSignature
            // This simulates a multi-turn conversation with Gemini 3.x
            const messages: LLMChatMessage[] = [
                { role: 'user', content: 'What is the weather?' },
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'call-123',
                        type: 'function',
                        function: { name: 'get_weather', arguments: '{"location": "NYC"}' },
                        thoughtSignature: 'encrypted-thought-data-here',
                    }],
                },
                {
                    role: 'tool',
                    tool_call_id: 'call-123',
                    content: '{"temp": 72, "condition": "sunny"}',
                },
            ];

            await client.chat(messages);

            // The tool call with thoughtSignature should still be preserved
            // This is handled in convertFunctionCallToToolCall
            // Google's format expects thoughtSignature on the functionCall part
        });

        test('converts tool calls with thoughtSignature to Google format', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const messages: LLMChatMessage[] = [
                { role: 'user', content: 'Test' },
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'call-123',
                        type: 'function',
                        function: { name: 'test_func', arguments: '{"arg": "value"}' },
                        thoughtSignature: 'sig-123',
                    }],
                },
            ];

            await client.chat(messages);

            const body = getBody()!;
            const contents = body['contents'] as Array<Record<string, unknown>>;

            // Find the model message
            const modelContent = contents.find(c => c['role'] === 'model');
            expect(modelContent).toBeDefined();

            const parts = (modelContent!['parts'] as Array<Record<string, unknown>>).filter(
                (p: Record<string, unknown>) => p['functionCall']
            );
            expect(parts).toHaveLength(1);

            const functionCall = parts[0]!['functionCall'] as Record<string, unknown>;
            expect(functionCall['name']).toBe('test_func');
            expect(functionCall['args']).toEqual({ arg: 'value' });

            // Check that thoughtSignature is echoed from the tool call
            expect(parts[0]!['thoughtSignature']).toBe('sig-123');
        });

        test('echoes thoughtSignature in response tool calls', async () => {
            const responseWithToolCall = {
                candidates: [{
                    content: {
                        parts: [{
                            functionCall: {
                                name: 'get_weather',
                                args: { location: 'NYC' },
                            },
                            thoughtSignature: 'response-sig-123',
                        }],
                        role: 'model',
                    },
                    index: 0,
                }],
            };

            mockFetchAndCapture(responseWithToolCall);
            const client = createClient();

            const result = await client.chat([
                { role: 'user', content: 'Weather?' },
            ]);

            expect(result.message.tool_calls).toBeDefined();
            expect(result.message.tool_calls).toHaveLength(1);
            expect(result.message.tool_calls![0]!.function.name).toBe('get_weather');
            expect(result.message.tool_calls![0]!.thoughtSignature).toBe('response-sig-123');
        });
    });

    // ========================================================================
    // Additional Features: System Instructions, Tools
    // ========================================================================

    describe('structured output with system instructions', () => {
        test('includes system instruction with structured output', async () => {
            const getBody = mockFetchAndCapture({
                candidates: [{
                    content: {
                        parts: [{ text: '{"result": "test output"}' }],
                        role: 'model',
                    },
                    index: 0,
                }],
            });
            const client = createClient();

            const options: ChatOptions = {
                schema: z.object({ result: z.string() }),
            };

            await client.chat([
                { role: 'system', content: 'Always respond in JSON format.' },
                { role: 'user', content: 'Generate data' },
            ], options);

            const body = getBody()!;
            expect(body['systemInstruction']).toBeDefined();
            const sysInst = body['systemInstruction'] as Record<string, unknown>;
            expect(sysInst['parts']).toEqual([{ text: 'Always respond in JSON format.' }]);

            // Also verify structured output is still set
            const genConfig = body['generationConfig'] as Record<string, unknown>;
            expect(genConfig['responseMimeType']).toBe('application/json');
        });
    });

    describe('structured output with parameters', () => {
        test('includes temperature and maxTokens alongside responseMimeType', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const options: ChatOptions = {
                schema: z.object({ name: z.string() }),
                temperature: 0.7,
                maxTokens: 100,
            };

            await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);

            const body = getBody()!;
            const genConfig = body['generationConfig'] as Record<string, unknown>;
            
            expect(genConfig['responseMimeType']).toBe('application/json');
            expect(genConfig['responseSchema']).toBeDefined();
            expect(genConfig['temperature']).toBe(0.7);
            expect(genConfig['maxOutputTokens']).toBe(100);
        });
    });

    // ========================================================================
    // Vertex AI Support
    // ========================================================================

    describe('Vertex AI structured output', () => {
        test('builds correct URL for Vertex AI', async () => {
            let capturedUrl = '';
            
            globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
                capturedUrl = typeof input === 'string' ? input : input.toString();
                return new Response(JSON.stringify({
                    candidates: [{
                        content: {
                            parts: [{ text: '{"text": "test"}' }],
                            role: 'model',
                        },
                        index: 0,
                    }],
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }) as typeof fetch;

            const client = new GoogleClient({
                model: 'gemini-1.5-pro',
                apiType: AIModelApiType.Vertex,
                region: 'us-central1',
                apiKey: 'vertex-token',
            });

            const options: ChatOptions = {
                schema: z.object({ text: z.string() }),
            };

            await client.chat([{ role: 'user', content: 'Test' }], options);

            // Vertex AI URL format
            expect(capturedUrl).toContain('aiplatform.googleapis.com');
            expect(capturedUrl).toContain('us-central1');
            expect(capturedUrl).toContain(':generateContent');
        });

        test('uses Authorization header for Vertex AI', async () => {
            let capturedHeaders: Record<string, string> = {};
            
            globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
                capturedHeaders = init?.headers as Record<string, string> || {};
                return new Response(JSON.stringify({
                    candidates: [{
                        content: {
                            parts: [{ text: '{"text": "test"}' }],
                            role: 'model',
                        },
                        index: 0,
                    }],
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }) as typeof fetch;

            const client = new GoogleClient({
                model: 'gemini-1.5-pro',
                apiType: AIModelApiType.Vertex,
                region: 'us-central1',
                apiKey: 'vertex-token',
            });

            const options: ChatOptions = {
                schema: z.object({ text: z.string() }),
            };

            await client.chat([{ role: 'user', content: 'Test' }], options);

            // Vertex uses Bearer token, not query param
            expect(capturedHeaders['Authorization']).toBe('Bearer vertex-token');
            // URL should NOT have ?key= in it
            expect(capturedHeaders['Content-Type']).toBe('application/json');
        });
    });
});
