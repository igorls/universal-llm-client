import { fromZod } from '../../zod-adapter.js';
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
import { OpenAICompatibleClient, sanitizeToolCallName, recoverLooseToolArguments } from '../../providers/openai.js';
import type { LLMClientOptions, ChatOptions, LLMChatMessage, LLMToolDefinition } from '../../interfaces.js';
import { AIModelApiType } from '../../interfaces.js';
import type { DecodedEvent } from '../../stream-decoder.js';

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
    function mockFetchAndCapture(response: unknown = OPENAI_RESPONSE, status = 200) {
        let capturedBody: Record<string, unknown> | null = null;

        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
            if (init?.body) {
                capturedBody = JSON.parse(init.body as string);
            }
            return new Response(JSON.stringify(response), {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
        }) as typeof fetch;

        return () => capturedBody;
    }

    test('strips runtime-only message metadata before sending OpenAI-compatible payloads', async () => {
        const getBody = mockFetchAndCapture();
        const client = createClient({ url: 'https://api.cerebras.ai' });

        const messages = [
            { role: 'system', content: 'base', timestamp: new Date('2026-06-29T00:00:00.000Z') },
            {
                role: 'user',
                content: 'hello',
                user: { timestamp: '2026-06-29T00:00:01.000Z' },
                metadata: { sessionId: 'session-1' },
            },
            { role: 'system', content: 'late', timestamp: 123 },
        ] as unknown as LLMChatMessage[];

        await client.chat(messages);

        expect(getBody()!['messages']).toEqual([
            { role: 'system', content: 'base' },
            { role: 'user', content: 'hello' },
            { role: 'user', content: '[SYSTEM MESSAGE]\nlate' },
        ]);
    });

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
                schema: fromZod(UserSchema),
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
                schema: fromZod(UserSchema),
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
                schema: fromZod(UserSchema),
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
                schema: fromZod(UserSchema),
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
                schema: fromZod(UserSchema),
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
                schema: fromZod(UserSchema),
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
                schema: fromZod(UserSchema),
            };

            const response = await client.chat([
                { role: 'user', content: 'Generate a user' },
            ], options);

            // If we got here without error, validation passed
            expect(response.message.content).toBe('{"name": "Bob", "age": 25}');
        });

        // ===================================================================
        // Reasoning models (vLLM --reasoning-parser, DeepSeek-R1, etc.)
        // ===================================================================

        test('exposes vLLM `reasoning_content` as result.reasoning, keeping content clean', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: 'The answer is 14.',
                        reasoning_content: 'All but 9 run away => 9 remain; 9 + 5 = 14.',
                    },
                    finish_reason: 'stop',
                }],
            });

            const client = createClient();
            const response = await client.chat([{ role: 'user', content: 'sheep riddle' }]);

            expect(response.reasoning).toBe('All but 9 run away => 9 remain; 9 + 5 = 14.');
            expect(response.message.content).toBe('The answer is 14.');
        });

        test('exposes gateway `reasoning` field as result.reasoning', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: 'Done.',
                        reasoning: 'Some chain of thought.',
                    },
                    finish_reason: 'stop',
                }],
            });

            const client = createClient();
            const response = await client.chat([{ role: 'user', content: 'hi' }]);

            expect(response.reasoning).toBe('Some chain of thought.');
            expect(response.message.content).toBe('Done.');
        });

        test('leaves reasoning undefined when no reasoning field is present', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: 'Plain answer.' },
                    finish_reason: 'stop',
                }],
            });

            const client = createClient();
            const response = await client.chat([{ role: 'user', content: 'hi' }]);

            expect(response.reasoning).toBeUndefined();
            expect(response.message.content).toBe('Plain answer.');
        });

        // ===================================================================
        // Unified thinking flag -> chat_template_kwargs.enable_thinking (vLLM)
        // ===================================================================

        const VLLM_URL = 'http://localhost:8000/v1'; // non-official endpoint

        test('translates per-call thinking:false to chat_template_kwargs.enable_thinking (vLLM)', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ url: VLLM_URL });

            await client.chat([{ role: 'user', content: 'hi' }], { thinking: false });

            const ctk = getBody()!['chat_template_kwargs'] as Record<string, unknown> | undefined;
            expect(ctk).toBeDefined();
            expect(ctk!['enable_thinking']).toBe(false);
        });

        test('translates client-level thinking:true to chat_template_kwargs.enable_thinking (vLLM)', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ thinking: true, url: VLLM_URL });

            await client.chat([{ role: 'user', content: 'hi' }]);

            const ctk = getBody()!['chat_template_kwargs'] as Record<string, unknown> | undefined;
            expect(ctk!['enable_thinking']).toBe(true);
        });

        test('does NOT send chat_template_kwargs to official OpenAI for non-reasoning models', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ thinking: true }); // default url = api.openai.com, model = test-model

            await client.chat([{ role: 'user', content: 'hi' }]);

            expect(getBody()!['chat_template_kwargs']).toBeUndefined();
        });

        test('omits chat_template_kwargs when thinking is not set', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            await client.chat([{ role: 'user', content: 'hi' }]);

            expect(getBody()!['chat_template_kwargs']).toBeUndefined();
        });

        test('does NOT send chat_template_kwargs to hosted gateways that reject it (Cerebras)', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ url: 'https://api.cerebras.ai', thinking: false });

            await client.chat([{ role: 'user', content: 'hi' }]);

            // Cerebras is OpenAI-compatible but rejects unknown body fields (HTTP 400).
            expect(getBody()!['chat_template_kwargs']).toBeUndefined();
        });

        test('maps thinking:false to Cerebras reasoning_effort none', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ url: 'https://api.cerebras.ai', model: 'gemma-4-31b', thinking: false });

            await client.chat([{ role: 'user', content: 'hi' }]);

            const body = getBody()!;
            expect(body['reasoning_effort']).toBe('none');
            expect(body['chat_template_kwargs']).toBeUndefined();
        });

        test('enables Cerebras Gemma reasoning by model default', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ url: 'https://api.cerebras.ai', model: 'gemma-4-31b' });

            await client.chat([{ role: 'user', content: 'hi' }]);

            const body = getBody()!;
            expect(body['reasoning_effort']).toBe('medium');
            expect(body['chat_template_kwargs']).toBeUndefined();
        });

        test('maps thinking levels to Cerebras-supported reasoning_effort values', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ url: 'https://api.cerebras.ai', model: 'gemma-4-31b' });

            await client.chat([{ role: 'user', content: 'hi' }], { thinking: 'minimal' });

            expect(getBody()!['reasoning_effort']).toBe('low');
        });

        test('uses max_completion_tokens for Cerebras instead of deprecated max_tokens', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ url: 'https://api.cerebras.ai', model: 'gemma-4-31b' });

            await client.chat([{ role: 'user', content: 'hi' }], { maxTokens: 32 });

            const body = getBody()!;
            expect(body['max_completion_tokens']).toBe(32);
            expect(body['max_tokens']).toBeUndefined();
        });

        test('still sends chat_template_kwargs to self-hosted vLLM (localhost)', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ url: VLLM_URL, thinking: false });

            await client.chat([{ role: 'user', content: 'hi' }]);

            expect((getBody()!['chat_template_kwargs'] as Record<string, unknown>)['enable_thinking']).toBe(false);
        });

        test('per-call thinking overrides client-level thinking (vLLM)', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ thinking: true, url: VLLM_URL });

            await client.chat([{ role: 'user', content: 'hi' }], { thinking: false });

            const ctk = getBody()!['chat_template_kwargs'] as Record<string, unknown>;
            expect(ctk['enable_thinking']).toBe(false);
        });

        test('OpenAI reasoning model maps a level to reasoning_effort (not chat_template_kwargs)', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ model: 'gpt-5', thinking: 'high' });

            await client.chat([{ role: 'user', content: 'hi' }]);

            const body = getBody()!;
            expect(body['reasoning_effort']).toBe('high');
            expect(body['chat_template_kwargs']).toBeUndefined();
        });

        test('OpenAI reasoning model maps thinking:true to reasoning_effort medium', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ model: 'o3', thinking: true });

            await client.chat([{ role: 'user', content: 'hi' }]);

            expect(getBody()!['reasoning_effort']).toBe('medium');
        });

        test('OpenAI reasoning model maps thinking:false to reasoning_effort minimal', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient({ model: 'gpt-5-mini', thinking: false });

            await client.chat([{ role: 'user', content: 'hi' }]);

            expect(getBody()!['reasoning_effort']).toBe('minimal');
        });

        // ===================================================================
        // Usage stats (timing / throughput)
        // ===================================================================

        test('populates durationMs in usage (client-measured wall-clock)', async () => {
            mockFetchAndCapture();
            const client = createClient();

            const response = await client.chat([{ role: 'user', content: 'hi' }]);

            expect(typeof response.usage?.durationMs).toBe('number');
            expect(response.usage!.durationMs!).toBeGreaterThanOrEqual(0);
        });

        test('provider does NOT validate response (validation is centralized in Router)', async () => {
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
                schema: fromZod(UserSchema),
            };

            // Provider should NOT throw — validation is done at Router level
            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);
            expect(response.message.content).toBe('not valid json at all');
        });

        test('provider returns raw response even on schema mismatch (Router validates)', async () => {
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
                schema: fromZod(UserSchema),
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
                schema: fromZod(UserSchema),
            };

            // Provider returns raw response — Router handles validation
            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);
            expect(response.message.content).toBe(rawOutput);
        });
    });

    // ========================================================================
    // Transport flexibility: apiBasePath / queryParams / auth headers
    // ========================================================================

    describe('transport flexibility', () => {
        function captureRequest(response: unknown = OPENAI_RESPONSE) {
            const cap = { url: '', headers: {} as Record<string, string> };
            globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
                cap.url = String(input);
                cap.headers = (init?.headers as Record<string, string>) ?? {};
                return new Response(JSON.stringify(response), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }) as typeof fetch;
            return cap;
        }
        const hi: LLMChatMessage[] = [{ role: 'user', content: 'hi' }];

        test('appends /v1 by default', async () => {
            const cap = captureRequest();
            await createClient({ url: 'https://host.example' }).chat(hi);
            expect(cap.url).toBe('https://host.example/v1/chat/completions');
        });

        test('apiBasePath "" disables the /v1 append', async () => {
            const cap = captureRequest();
            await createClient({ url: 'https://h/openai/deployments/d', apiBasePath: '' }).chat(hi);
            expect(cap.url).toBe('https://h/openai/deployments/d/chat/completions');
        });

        test('apiBasePath normalizes extra leading slashes (//v1 -> /v1)', async () => {
            const cap = captureRequest();
            await createClient({ url: 'https://host.example', apiBasePath: '//v1' }).chat(hi);
            expect(cap.url).toBe('https://host.example/v1/chat/completions');
        });

        test('queryParams are appended to the URL', async () => {
            const cap = captureRequest();
            await createClient({ url: 'https://host.example', queryParams: { 'api-version': '2024-10-21' } }).chat(hi);
            expect(cap.url).toContain('?api-version=2024-10-21');
        });

        test('preserves a query string already on the base URL (path before query)', async () => {
            const cap = captureRequest();
            await createClient({ url: 'https://h/v1?foo=1', apiBasePath: '' }).chat(hi);
            expect(cap.url).toBe('https://h/v1/chat/completions?foo=1');
        });

        test('authHeader + authPrefix produce a custom auth header (no Bearer)', async () => {
            const cap = captureRequest();
            await createClient({ apiKey: 'secret', authHeader: 'api-key', authPrefix: '' }).chat(hi);
            expect(cap.headers['api-key']).toBe('secret');
            expect(cap.headers['Authorization']).toBeUndefined();
        });

        test('extraHeaders are merged into the request', async () => {
            const cap = captureRequest();
            await createClient({ apiKey: 'k', extraHeaders: { 'x-custom': 'v' } }).chat(hi);
            expect(cap.headers['x-custom']).toBe('v');
        });

        test('uses known Cerebras context metadata when /models omits max_model_len', async () => {
            const client = createClient({ url: 'https://api.cerebras.ai', model: 'gemma-4-31b' });

            await expect(client.getModelInfo()).resolves.toMatchObject({
                model: 'gemma-4-31b',
                contextLength: 131_072,
            });
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
                schema: fromZod(UserSchema),
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
        test('provider returns raw response for null content (Router validates)', async () => {
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
                schema: fromZod(UserSchema),
            };

            // Provider should NOT throw — returns raw response
            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);
            expect(response.message.content).toBe('');
        });

        test('provider returns raw response for empty content (Router validates)', async () => {
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
                schema: fromZod(UserSchema),
            };

            // Provider should NOT throw — returns raw response
            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);
            expect(response.message.content).toBe('');
        });

        test('provider returns raw response for schema mismatch (Router validates)', async () => {
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
                schema: fromZod(UserSchema),
            };

            // Provider should NOT throw — returns raw response
            const response = await client.chat([
                { role: 'user', content: 'Generate' },
            ], options);
            expect(response.message.content).toBe('{"name": "test"}');
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
    // Message normalization
    // ========================================================================

    describe('message normalization', () => {
        test('keeps leading system messages and converts later system messages for chat', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const messages: LLMChatMessage[] = [
                { role: 'system', content: 'base prompt' },
                { role: 'user', content: 'hello' },
                { role: 'system', content: 'late update' },
                { role: 'assistant', content: 'working' },
            ];

            await client.chat(messages);

            const body = getBody()!;
            const sentMessages = body['messages'] as Array<Record<string, unknown>>;
            expect(sentMessages.map(message => message['role'])).toEqual(['system', 'user', 'user', 'assistant']);
            expect(sentMessages[2]?.['content']).toBe('[SYSTEM MESSAGE]\nlate update');
        });

        test('keeps late system messages out of the streaming payload', async () => {
            let capturedBody: Record<string, unknown> | null = null;

            globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
                capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
                return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' },
                });
            }) as unknown as typeof fetch;

            const client = createClient();
            const stream = client.chatStream([
                { role: 'user', content: 'hello' },
                { role: 'system', content: 'late update' },
            ]);

            for await (const _event of stream) {
                // Drain the stream so the request is sent.
            }

            expect(capturedBody).not.toBeNull();
            const sentMessages = capturedBody!['messages'] as Array<Record<string, unknown>>;
            expect(sentMessages.map(message => message['role'])).toEqual(['user', 'user']);
            expect(sentMessages[1]?.['content']).toBe('[SYSTEM MESSAGE]\nlate update');
        });
    });

    // ========================================================================
    // vLLM Tool Fallback
    // ========================================================================

    describe('vLLM tool fallback', () => {
        const multiplyTool: LLMToolDefinition = {
            type: 'function',
            function: {
                name: 'multiply',
                description: 'Multiply two numbers',
                parameters: {
                    type: 'object',
                    properties: {
                        a: { type: 'number' },
                        b: { type: 'number' },
                    },
                    required: ['a', 'b'],
                },
            },
        };

        test('retries with text-level tool protocol when vLLM rejects native tool choice', async () => {
            const requestBodies: Record<string, unknown>[] = [];
            const originalWarn = console.warn;
            console.warn = mock(() => undefined) as unknown as typeof console.warn;

            globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
                // The window-probe (/models) is not part of the chat-call sequence.
                if (String(input).includes('/models')) {
                    return new Response(JSON.stringify({ object: 'list', data: [] }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
                if (requestBodies.length === 1) {
                    return new Response(JSON.stringify({
                        error: {
                            message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
                            type: 'BadRequestError',
                            code: 400,
                        },
                    }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }

                return new Response(JSON.stringify({
                    ...OPENAI_RESPONSE,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: '<tool_call>multiply({"a":17,"b":23})</tool_call>',
                        },
                        finish_reason: 'stop',
                    }],
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }) as typeof fetch;

            try {
                const client = createClient({ url: 'http://localhost:8000' });
                const response = await client.chat([{ role: 'user', content: 'Multiply 17 by 23' }], {
                    tools: [multiplyTool],
                });

                expect(requestBodies).toHaveLength(2);
                expect(requestBodies[0]?.['tools']).toBeDefined();
                expect(requestBodies[1]?.['tools']).toBeUndefined();
                const fallbackMessages = requestBodies[1]?.['messages'] as LLMChatMessage[];
                expect(fallbackMessages[0]?.role).toBe('system');
                expect(String(fallbackMessages[0]?.content)).toContain('<tool_call>tool_name');
                expect(response.message.content).toBe('');
                expect(response.message.tool_calls?.[0]?.function).toEqual({
                    name: 'multiply',
                    arguments: '{"a":17,"b":23}',
                });
            } finally {
                console.warn = originalWarn;
            }
        });

        test('surfaces finish reason and reasoning token usage from OpenAI-compatible responses', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: 'OK',
                    },
                    finish_reason: 'stop',
                }],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 6,
                    total_tokens: 16,
                    completion_tokens_details: { reasoning_tokens: 4 },
                },
            });

            const client = createClient({ url: 'https://api.cerebras.ai', model: 'gemma-4-31b' });
            const response = await client.chat([{ role: 'user', content: 'hi' }]);

            expect(response.finishReason).toBe('stop');
            expect(response.usage?.reasoningTokens).toBe(4);
        });

        test('recovers bare Gemma call syntax from text-level tool fallback responses', async () => {
            globalThis.fetch = mock(async (_input: string | URL | Request, _init?: RequestInit) => {
                return new Response(JSON.stringify({
                    ...OPENAI_RESPONSE,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: 'call:multiply({ "a": 17, "b": 23 })',
                        },
                        finish_reason: 'stop',
                    }],
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }) as typeof fetch;

            const client = createClient({ url: 'https://api.cerebras.ai' });
            const response = await client.chat([{ role: 'user', content: 'Multiply 17 by 23' }], {
                tools: [multiplyTool],
            });

            expect(response.message.content).toBe('');
            expect(response.message.tool_calls?.[0]?.function).toEqual({
                name: 'multiply',
                arguments: '{"a":17,"b":23}',
            });
        });

        test('recovers adjacent bare Gemma call syntax as multiple tool calls', async () => {
            globalThis.fetch = mock(async (_input: string | URL | Request, _init?: RequestInit) => {
                return new Response(JSON.stringify({
                    ...OPENAI_RESPONSE,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: 'call:multiply({ "a": 17, "b": 23 })call:multiply({ "a": 2, "b": 5 })',
                        },
                        finish_reason: 'stop',
                    }],
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }) as typeof fetch;

            const client = createClient({ url: 'https://api.cerebras.ai' });
            const response = await client.chat([{ role: 'user', content: 'Multiply two pairs' }], {
                tools: [multiplyTool],
            });

            expect(response.message.content).toBe('');
            expect(response.message.tool_calls?.map(call => call.function)).toEqual([
                { name: 'multiply', arguments: '{"a":17,"b":23}' },
                { name: 'multiply', arguments: '{"a":2,"b":5}' },
            ]);
        });

        test('recovers loose bare Gemma call syntax from text-level tool fallback responses', async () => {
            globalThis.fetch = mock(async (_input: string | URL | Request, _init?: RequestInit) => {
                return new Response(JSON.stringify({
                    ...OPENAI_RESPONSE,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: 'call:multiply{a:2,b:3}',
                        },
                        finish_reason: 'stop',
                    }],
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }) as typeof fetch;

            const client = createClient({ url: 'https://api.cerebras.ai' });
            const response = await client.chat([{ role: 'user', content: 'Multiply 2 by 3' }], {
                tools: [multiplyTool],
            });

            expect(response.message.content).toBe('');
            expect(response.message.tool_calls?.[0]?.function).toEqual({
                name: 'multiply',
                arguments: '{"a":2,"b":3}',
            });
        });

        test('recovers streamed bare Gemma call syntax from native reasoning deltas', async () => {
            globalThis.fetch = mock(async (_input: string | URL | Request, _init?: RequestInit) => {
                return new Response(
                    'data: {"choices":[{"delta":{"reasoning":"call:multiply({\\"a\\":2,\\"b\\":3})"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                    {
                        status: 200,
                        headers: { 'Content-Type': 'text/event-stream' },
                    },
                );
            }) as typeof fetch;

            const client = createClient({ url: 'https://api.cerebras.ai' });
            const stream = client.chatStream([{ role: 'user', content: 'Multiply 2 by 3' }], {
                tools: [multiplyTool],
            });

            const events: DecodedEvent[] = [];
            let result: unknown;
            while (true) {
                const next = await stream.next();
                if (next.done) {
                    result = next.value;
                    break;
                }
                events.push(next.value);
            }

            const toolCalls = events
                .filter(event => event.type === 'tool_call')
                .flatMap(event => (event as Extract<DecodedEvent, { type: 'tool_call' }>).calls);

            expect(events.filter(event => event.type === 'thinking')).toEqual([]);
            expect(toolCalls.map(call => call.function)).toEqual([
                { name: 'multiply', arguments: '{"a":2,"b":3}' },
            ]);
            const final = result as {
                message?: { tool_calls?: Array<{ function: { name: string; arguments: string } }> };
                reasoning?: string;
            };
            expect(final.message?.tool_calls?.map(call => call.function)).toEqual([
                { name: 'multiply', arguments: '{"a":2,"b":3}' },
            ]);
            expect(final.reasoning).toBeUndefined();
        });

        test('recovers streamed loose Gemma call syntax from native reasoning deltas', async () => {
            globalThis.fetch = mock(async (_input: string | URL | Request, _init?: RequestInit) => {
                return new Response(
                    'data: {"choices":[{"delta":{"reasoning":"call:multiply{a:2,b:3}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                    {
                        status: 200,
                        headers: { 'Content-Type': 'text/event-stream' },
                    },
                );
            }) as typeof fetch;

            const client = createClient({ url: 'https://api.cerebras.ai' });
            const stream = client.chatStream([{ role: 'user', content: 'Multiply 2 by 3' }], {
                tools: [multiplyTool],
            });

            const events: DecodedEvent[] = [];
            let result: unknown;
            while (true) {
                const next = await stream.next();
                if (next.done) {
                    result = next.value;
                    break;
                }
                events.push(next.value);
            }

            const toolCalls = events
                .filter(event => event.type === 'tool_call')
                .flatMap(event => (event as Extract<DecodedEvent, { type: 'tool_call' }>).calls);
            const final = result as {
                message?: { tool_calls?: Array<{ function: { name: string; arguments: string } }> };
                reasoning?: string;
            };

            expect(events.filter(event => event.type === 'thinking')).toEqual([]);
            expect(toolCalls.map(call => call.function)).toEqual([
                { name: 'multiply', arguments: '{"a":2,"b":3}' },
            ]);
            expect(final.message?.tool_calls?.map(call => call.function)).toEqual([
                { name: 'multiply', arguments: '{"a":2,"b":3}' },
            ]);
            expect(final.reasoning).toBeUndefined();
        });

        test('recovers a bare Gemma call line after stray prose', async () => {
            globalThis.fetch = mock(async (_input: string | URL | Request, _init?: RequestInit) => {
                return new Response(JSON.stringify({
                    ...OPENAI_RESPONSE,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: [
                                'I should use the calculator.',
                                'thought',
                                'call:multiply({ "a": 17, "b": 23 })',
                            ].join('\n'),
                        },
                        finish_reason: 'stop',
                    }],
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }) as typeof fetch;

            const client = createClient({ url: 'https://api.cerebras.ai' });
            const response = await client.chat([{ role: 'user', content: 'Multiply 17 by 23' }], {
                tools: [multiplyTool],
            });

            expect(response.message.content).toContain('I should use the calculator.');
            expect(response.message.content).not.toContain('call:multiply');
            expect(response.message.tool_calls?.[0]?.function).toEqual({
                name: 'multiply',
                arguments: '{"a":17,"b":23}',
            });
        });

        test('does not auto-send registered tools for plain chat', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();
            client.registerTool('multiply', 'Multiply two numbers', multiplyTool.function.parameters, async () => 391);

            await client.chat([{ role: 'user', content: 'Say hi' }]);

            expect(getBody()?.['tools']).toBeUndefined();
        });
    });

    // ========================================================================
    // Schema with Tools (allowed together)
    // ========================================================================

    describe('schema with tools', () => {
        test('sends both response_format and tools in the request', async () => {
            const getBody = mockFetchAndCapture();
            const client = createClient();

            const UserSchema = z.object({
                name: z.string(),
            });

            const options: ChatOptions = {
                schema: fromZod(UserSchema),
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

            // Both response_format and tools should be present
            expect(body!.response_format).toBeDefined();
            expect(body!.tools).toBeDefined();
            expect((body!.tools as unknown[]).length).toBe(1);
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
                schema: fromZod(DescriptionSchema),
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
                schema: fromZod(ComparisonSchema),
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
                schema: fromZod(ImageAnalysisSchema),
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
                schema: fromZod(DescriptionSchema),
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
                schema: fromZod(DescriptionSchema),
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
                schema: fromZod(VisionSchema),
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
                schema: fromZod(VisionSchema),
            };

            // Provider should NOT throw — validation is done at Router level
            const result = await client.chat(messages, options);
            expect(result.message.content).toBe('{"count": "not a number"}');
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
                schema: fromZod(UserSchema),
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
                schema: fromZod(UserListSchema),
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
                schema: fromZod(StatusSchema),
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

    // ========================================================================
    // Edge cases
    // ========================================================================

    describe('edge cases', () => {
        test('returns malformed structured output without provider-side validation', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"name": "Alice", "age": 30',
                    },
                    finish_reason: 'stop',
                }],
            });
            const client = createClient();

            const response = await client.chat([{ role: 'user', content: 'Generate' }], {
                schema: fromZod(z.object({ name: z.string(), age: z.number() })),
            });

            expect(response.message.content).toBe('{"name": "Alice", "age": 30');
        });

        test('generates missing tool call IDs and normalizes empty arguments', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [{
                            type: 'function',
                            function: {
                                name: 'get_weather',
                                arguments: '',
                            },
                        }, {
                            id: '',
                            type: 'function',
                            function: {
                                name: 'get_time',
                            },
                        }, {
                            id: '',
                            type: 'function',
                            function: {
                                name: 'get_location',
                                arguments: " \n\t",
                            },
                        }],
                    },
                    finish_reason: 'tool_calls',
                }],
            });
            const client = createClient();

            const response = await client.chat([{ role: 'user', content: 'Use a tool' }]);

            expect(response.message.tool_calls).toHaveLength(3);
            expect(response.message.tool_calls![0]!.id).toStartWith('call_');
            expect(response.message.tool_calls![0]!.function.arguments).toBe('{}');
            expect(response.message.tool_calls![1]!.id).toStartWith('call_');
            expect(response.message.tool_calls![1]!.function.arguments).toBe('{}');
            expect(response.message.tool_calls![2]!.id).toStartWith('call_');
            expect(response.message.tool_calls![2]!.function.arguments).toBe('{}');
        });

        test('normalizes blank streamed tool call arguments', async () => {
            const chunks = [{
                choices: [{
                    delta: {
                        tool_calls: [{
                            index: 0,
                            id: 'call_blank',
                            type: 'function',
                            function: {
                                name: 'get_weather',
                                arguments: " \n",
                            },
                        }],
                    },
                }],
            }, {
                choices: [{
                    delta: {},
                    finish_reason: 'tool_calls',
                }],
            }];

            globalThis.fetch = mock(async () => new Response(
                chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
                {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' },
                },
            )) as typeof fetch;
            const client = createClient();

            const events: DecodedEvent[] = [];
            const stream = client.chatStream([{ role: 'user', content: 'Use a tool' }]);
            let finalResult: Awaited<ReturnType<typeof client.chat>> | undefined;
            while (true) {
                const next = await stream.next();
                if (next.done) {
                    finalResult = next.value || undefined;
                    break;
                }
                events.push(next.value);
            }

            const toolEvent = events.find(event => event.type === 'tool_call');
            expect(toolEvent?.type).toBe('tool_call');
            if (toolEvent?.type !== 'tool_call') {
                throw new Error('Expected a tool_call stream event');
            }
            expect(toolEvent.calls[0]!.function.arguments).toBe('{}');
            expect(finalResult?.message.tool_calls![0]!.function.arguments).toBe('{}');
        });

        test('passes through non-empty malformed tool call arguments', async () => {
            mockFetchAndCapture({
                ...OPENAI_RESPONSE,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [{
                            id: 'call_123',
                            type: 'function',
                            function: {
                                name: 'get_weather',
                                arguments: '{"location": "Boston"',
                            },
                        }],
                    },
                    finish_reason: 'tool_calls',
                }],
            });
            const client = createClient();

            const response = await client.chat([{ role: 'user', content: 'Use a tool' }]);

            expect(response.message.tool_calls![0]!.function.arguments).toBe('{"location": "Boston"');
        });

        test('surfaces HTTP rate limit errors', async () => {
            mockFetchAndCapture({
                error: {
                    message: 'Rate limit exceeded',
                    type: 'rate_limit_error',
                },
            }, 429);
            const client = createClient();

            await expect(client.chat([{ role: 'user', content: 'Hello' }]))
                .rejects.toThrow('Rate limit exceeded');
        });
    });
});

// ============================================================================
// Malformed native tool-call sanitization (server-side parser fallout)
// ============================================================================

describe('sanitizeToolCallName', () => {
    test('strips a trailing paren left by a server-side parser', () => {
        expect(sanitizeToolCallName('sessions(')).toBe('sessions');
        expect(sanitizeToolCallName('shell_execute(')).toBe('shell_execute');
        expect(sanitizeToolCallName('help( ')).toBe('help');
    });

    test('keeps valid names untouched', () => {
        expect(sanitizeToolCallName('sessions')).toBe('sessions');
        expect(sanitizeToolCallName('@core/shell:run_command')).toBe('@core/shell:run_command');
    });

    test('returns input unchanged when nothing valid leads', () => {
        expect(sanitizeToolCallName('(broken')).toBe('(broken');
        expect(sanitizeToolCallName('')).toBe('');
    });
});

describe('recoverLooseToolArguments', () => {
    test('recovers a sliced name({...}) argument tail', () => {
        expect(JSON.parse(recoverLooseToolArguments('{action: "list"})')!)).toEqual({ action: 'list' });
    });

    test('recovers unquoted-key pseudo-JSON', () => {
        expect(JSON.parse(recoverLooseToolArguments('{module: "@core/shell"}')!)).toEqual({ module: '@core/shell' });
    });

    test('passes through strict JSON', () => {
        expect(JSON.parse(recoverLooseToolArguments('{"a": 1}')!)).toEqual({ a: 1 });
    });

    test('empty arguments become an empty object', () => {
        expect(recoverLooseToolArguments('')).toBe('{}');
        expect(recoverLooseToolArguments('   ')).toBe('{}');
    });
});
