/**
 * Ollama Provider Unit Tests
 *
 * Tests the OllamaClient's message conversion logic, specifically
 * the multimodal/vision path and tool call argument handling.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OllamaClient } from '../../providers/ollama.js';
import type { LLMClientOptions, LLMChatMessage } from '../../interfaces.js';
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
});
