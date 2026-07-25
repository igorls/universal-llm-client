/**
 * OpenAI Responses API Provider Tests
 *
 * Pins the wire contract of the ChatGPT-backend dialect: the request shape
 * (store/include/instructions/flat tools), the message → input item mapping,
 * SSE event decoding, encrypted-reasoning carry-over across a tool loop, and
 * quota-error classification.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ResponsesClient, parseModelVariant } from '../../providers/openai-responses.js';
import { LLMHttpError, LLMProviderError, classifyFailure } from '../../errors.js';
import type { LLMChatMessage, LLMToolDefinition } from '../../interfaces.js';
import type { DecodedEvent } from '../../stream-decoder.js';

// ============================================================================
// Helpers
// ============================================================================

interface Captured {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
}

/** Mock an SSE response built from Responses-API event frames. */
function mockSSE(events: Array<Record<string, unknown>>): Captured {
    const cap: Captured = { url: '', headers: {}, body: {} };
    const payload = events.map(e => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`).join('');

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        cap.url = String(input);
        cap.headers = (init?.headers as Record<string, string>) ?? {};
        cap.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response(payload, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        });
    }) as typeof fetch;

    return cap;
}

function createClient(overrides: Record<string, unknown> = {}): ResponsesClient {
    return new ResponsesClient({
        model: 'gpt-5.2-codex',
        url: 'https://chatgpt.com/backend-api/codex',
        authResolver: async () => ({ accessToken: 'tok_123', accountId: 'acct_abc' }),
        originator: 'codex_cli_rs',
        ...overrides,
    });
}

async function drain(
    stream: AsyncGenerator<DecodedEvent, unknown, unknown>,
): Promise<{ events: DecodedEvent[]; result: unknown }> {
    const events: DecodedEvent[] = [];
    let next = await stream.next();
    while (!next.done) {
        events.push(next.value);
        next = await stream.next();
    }
    return { events, result: next.value };
}

const TEXT_STREAM = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.output_text.delta', delta: ' world' },
    {
        type: 'response.completed',
        response: {
            usage: {
                input_tokens: 100,
                output_tokens: 20,
                total_tokens: 120,
                input_tokens_details: { cached_tokens: 64 },
                output_tokens_details: { reasoning_tokens: 12 },
            },
        },
    },
];

// ============================================================================
// Tests
// ============================================================================

describe('ResponsesClient', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    // ========================================================================

    describe('request shape', () => {
        test('posts to /responses with the ChatGPT backend headers', async () => {
            const cap = mockSSE(TEXT_STREAM);
            await createClient().chat([{ role: 'user', content: 'hi' }]);

            expect(cap.url).toBe('https://chatgpt.com/backend-api/codex/responses');
            expect(cap.headers['Authorization']).toBe('Bearer tok_123');
            expect(cap.headers['chatgpt-account-id']).toBe('acct_abc');
            expect(cap.headers['OpenAI-Beta']).toBe('responses=experimental');
            expect(cap.headers['originator']).toBe('codex_cli_rs');
            expect(cap.headers['accept']).toBe('text/event-stream');
        });

        test('sends the mandatory stateless flags', async () => {
            const cap = mockSSE(TEXT_STREAM);
            await createClient().chat([{ role: 'user', content: 'hi' }]);

            // store:false is required by the backend; without the encrypted-content
            // include, reasoning cannot survive between tool-loop iterations.
            expect(cap.body['store']).toBe(false);
            expect(cap.body['stream']).toBe(true);
            expect(cap.body['include']).toEqual(['reasoning.encrypted_content']);
        });

        test('omits sampling params the reasoning models reject', async () => {
            const cap = mockSSE(TEXT_STREAM);
            await createClient().chat([{ role: 'user', content: 'hi' }], {
                temperature: 0.2,
                maxTokens: 500,
            });

            expect(cap.body['temperature']).toBeUndefined();
            expect(cap.body['max_tokens']).toBeUndefined();
            expect(cap.body['max_output_tokens']).toBeUndefined();
        });

        test('conversationId drives the prompt-cache headers', async () => {
            const cap = mockSSE(TEXT_STREAM);
            await createClient({ conversationId: 'conv_42' }).chat([{ role: 'user', content: 'hi' }]);

            expect(cap.headers['session_id']).toBe('conv_42');
            expect(cap.headers['conversation_id']).toBe('conv_42');
        });

        test('throws before hitting the network when no token is available', async () => {
            const cap = mockSSE(TEXT_STREAM);
            const client = new ResponsesClient({ model: 'gpt-5.2-codex', authResolver: async () => ({ accessToken: '' }) });

            await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(LLMProviderError);
            expect(cap.url).toBe('');
        });
    });

    // ========================================================================

    describe('model variants', () => {
        test('parses an effort suffix', () => {
            expect(parseModelVariant('gpt-5.2-codex:xhigh')).toEqual({ model: 'gpt-5.2-codex', effort: 'xhigh' });
        });

        test('leaves a plain model name alone', () => {
            expect(parseModelVariant('gpt-5.2-codex')).toEqual({ model: 'gpt-5.2-codex' });
        });

        test('ignores a suffix that is not an effort level', () => {
            expect(parseModelVariant('gpt-5.2:turbo')).toEqual({ model: 'gpt-5.2:turbo' });
        });

        test('the suffix reaches the wire as model + reasoning.effort', async () => {
            const cap = mockSSE(TEXT_STREAM);
            await createClient({ model: 'gpt-5.2-codex:high' }).chat([{ role: 'user', content: 'hi' }]);

            expect(cap.body['model']).toBe('gpt-5.2-codex');
            expect(cap.body['reasoning']).toMatchObject({ effort: 'high' });
        });

        test('effort "none" drops the reasoning block entirely', async () => {
            const cap = mockSSE(TEXT_STREAM);
            await createClient({ model: 'gpt-5.2:none' }).chat([{ role: 'user', content: 'hi' }]);

            expect(cap.body['reasoning']).toBeUndefined();
        });
    });

    // ========================================================================

    describe('message → input mapping', () => {
        test('hoists system messages into instructions', async () => {
            const cap = mockSSE(TEXT_STREAM);
            await createClient().chat([
                { role: 'system', content: 'You are terse.' },
                { role: 'user', content: 'hi' },
            ]);

            expect(cap.body['instructions']).toBe('You are terse.');
            expect(cap.body['input']).toEqual([
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
            ]);
        });

        test('an instructions override demotes system messages to developer items', async () => {
            const cap = mockSSE(TEXT_STREAM);
            await createClient({ instructions: 'CODEX PROMPT' }).chat([
                { role: 'system', content: 'BentoKit prompt' },
                { role: 'user', content: 'hi' },
            ]);

            // The host prompt must not be silently dropped when the backend's
            // canonical instructions take the top-level slot.
            expect(cap.body['instructions']).toBe('CODEX PROMPT');
            expect(cap.body['input']).toEqual([
                { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'BentoKit prompt' }] },
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
            ]);
        });

        test('assistant text uses output_text, user text uses input_text', async () => {
            const cap = mockSSE(TEXT_STREAM);
            await createClient().chat([
                { role: 'user', content: 'a' },
                { role: 'assistant', content: 'b' },
                { role: 'user', content: 'c' },
            ]);

            expect(cap.body['input']).toEqual([
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] },
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'b' }] },
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'c' }] },
            ]);
        });

        test('images map to input_image parts', async () => {
            const cap = mockSSE(TEXT_STREAM);
            await createClient().chat([
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'what is this' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
                    ],
                },
            ]);

            expect(cap.body['input']).toEqual([
                {
                    type: 'message',
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'what is this' },
                        { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
                    ],
                },
            ]);
        });

        test('tool calls and results become function_call / function_call_output items', async () => {
            const cap = mockSSE(TEXT_STREAM);
            const messages: LLMChatMessage[] = [
                { role: 'user', content: 'read a file' },
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":"a.ts"}' } }],
                },
                { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
            ];
            await createClient().chat(messages);

            expect(cap.body['input']).toEqual([
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read a file' }] },
                { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"p":"a.ts"}' },
                { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
            ]);
        });

        test('an assistant turn with no text emits only its function_call', async () => {
            const cap = mockSSE(TEXT_STREAM);
            await createClient().chat([
                { role: 'user', content: 'go' },
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
                },
            ]);

            const input = cap.body['input'] as Array<Record<string, unknown>>;
            expect(input.filter(i => i['role'] === 'assistant')).toHaveLength(0);
        });

        test('tool schemas are flattened out of the function wrapper', async () => {
            const cap = mockSSE(TEXT_STREAM);
            const tools: LLMToolDefinition[] = [{
                type: 'function',
                function: {
                    name: 'read_file',
                    description: 'Read a file',
                    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                },
            }];
            await createClient().chat([{ role: 'user', content: 'hi' }], { tools });

            expect(cap.body['tools']).toEqual([{
                type: 'function',
                name: 'read_file',
                description: 'Read a file',
                parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            }]);
        });
    });

    // ========================================================================

    describe('stream decoding', () => {
        test('text deltas yield text events and accumulate into the message', async () => {
            mockSSE(TEXT_STREAM);
            const { events, result } = await drain(createClient().chatStream([{ role: 'user', content: 'hi' }]));

            expect(events).toEqual([
                { type: 'text', content: 'Hello' },
                { type: 'text', content: ' world' },
            ]);
            expect((result as { message: LLMChatMessage }).message.content).toBe('Hello world');
        });

        test('reasoning deltas yield thinking events', async () => {
            mockSSE([
                { type: 'response.reasoning_summary_text.delta', delta: 'Plan: ' },
                { type: 'response.reasoning_text.delta', delta: 'read the file' },
                { type: 'response.output_text.delta', delta: 'done' },
                { type: 'response.completed', response: {} },
            ]);
            const { events, result } = await drain(createClient().chatStream([{ role: 'user', content: 'hi' }]));

            expect(events.filter(e => e.type === 'thinking')).toEqual([
                { type: 'thinking', content: 'Plan: ' },
                { type: 'thinking', content: 'read the file' },
            ]);
            expect((result as { reasoning?: string }).reasoning).toBe('Plan: read the file');
        });

        test('assembles a tool call from streamed argument deltas', async () => {
            mockSSE([
                {
                    type: 'response.output_item.added',
                    output_index: 0,
                    item: { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'read_file', arguments: '' },
                },
                { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"path":' },
                { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"a.ts"}' },
                {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'read_file' },
                },
                { type: 'response.completed', response: {} },
            ]);
            const { events, result } = await drain(createClient().chatStream([{ role: 'user', content: 'hi' }]));

            expect(events).toEqual([{
                type: 'tool_call',
                calls: [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
            }]);
            const response = result as { message: LLMChatMessage; finishReason?: string };
            expect(response.message.tool_calls).toHaveLength(1);
            expect(response.finishReason).toBe('tool_calls');
        });

        test('a complete arguments string on the done event wins over the deltas', async () => {
            mockSSE([
                {
                    type: 'response.output_item.added',
                    output_index: 0,
                    item: { id: 'fc_1', type: 'function_call', call_id: 'c1', name: 'ls', arguments: '' },
                },
                { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"tr' },
                {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: { id: 'fc_1', type: 'function_call', call_id: 'c1', name: 'ls', arguments: '{"truncated":false}' },
                },
                { type: 'response.completed', response: {} },
            ]);
            const { events } = await drain(createClient().chatStream([{ role: 'user', content: 'hi' }]));

            expect(events[0]).toEqual({
                type: 'tool_call',
                calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"truncated":false}' } }],
            });
        });

        test('maps usage including cached and reasoning token details', async () => {
            mockSSE(TEXT_STREAM);
            const { result } = await drain(createClient().chatStream([{ role: 'user', content: 'hi' }]));

            const usage = (result as { usage?: Record<string, number> }).usage;
            expect(usage).toMatchObject({
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
                cachedTokens: 64,
                reasoningTokens: 12,
            });
            // lastCallUsage must mirror usage — context accounting reads it.
            expect((result as { lastCallUsage?: unknown }).lastCallUsage).toEqual(usage);
        });

        test('response.incomplete surfaces as the finish reason', async () => {
            mockSSE([
                { type: 'response.output_text.delta', delta: 'partial' },
                { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
            ]);
            const { result } = await drain(createClient().chatStream([{ role: 'user', content: 'hi' }]));

            expect((result as { finishReason?: string }).finishReason).toBe('max_output_tokens');
        });

        test('ignores unparseable keep-alive frames', async () => {
            const cap = { url: '' };
            globalThis.fetch = mock(async () => new Response(
                'data: \n\n' + 'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
                { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
            )) as typeof fetch;
            void cap;

            const { events } = await drain(createClient().chatStream([{ role: 'user', content: 'hi' }]));
            expect(events).toEqual([{ type: 'text', content: 'ok' }]);
        });
    });

    // ========================================================================

    describe('encrypted reasoning carry-over', () => {
        test('echoes the reasoning item ahead of the tool call it produced', async () => {
            // Turn 1: the model reasons, then calls a tool.
            mockSSE([
                {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'ENC_BLOB', summary: [] },
                },
                {
                    type: 'response.output_item.done',
                    output_index: 1,
                    item: { id: 'fc_1', type: 'function_call', call_id: 'call_7', name: 'ls', arguments: '{}' },
                },
                { type: 'response.completed', response: {} },
            ]);

            const client = createClient();
            await drain(client.chatStream([{ role: 'user', content: 'list files' }]));

            // Turn 2: history is rebuilt by the caller, as an agent loop does.
            const cap = mockSSE(TEXT_STREAM);
            await client.chat([
                { role: 'user', content: 'list files' },
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ id: 'call_7', type: 'function', function: { name: 'ls', arguments: '{}' } }],
                },
                { role: 'tool', tool_call_id: 'call_7', content: 'a.ts' },
            ]);

            expect(cap.body['input']).toEqual([
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
                { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC_BLOB', summary: [] },
                { type: 'function_call', call_id: 'call_7', name: 'ls', arguments: '{}' },
                { type: 'function_call_output', call_id: 'call_7', output: 'a.ts' },
            ]);
        });

        test('resetReasoningCache drops the carried items', async () => {
            mockSSE([
                {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'ENC', summary: [] },
                },
                {
                    type: 'response.output_item.done',
                    output_index: 1,
                    item: { id: 'fc_1', type: 'function_call', call_id: 'c1', name: 'ls', arguments: '{}' },
                },
                { type: 'response.completed', response: {} },
            ]);
            const client = createClient();
            await drain(client.chatStream([{ role: 'user', content: 'go' }]));
            client.resetReasoningCache();

            const cap = mockSSE(TEXT_STREAM);
            await client.chat([
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
                },
            ]);

            const input = cap.body['input'] as Array<Record<string, unknown>>;
            expect(input.some(i => i['type'] === 'reasoning')).toBe(false);
        });
    });

    // ========================================================================

    describe('error classification', () => {
        test('quota exhaustion becomes a 429 that cools the provider down', async () => {
            mockSSE([
                {
                    type: 'response.failed',
                    response: { error: { code: 'usage_limit_reached', message: 'You have hit your weekly limit' } },
                },
            ]);

            const promise = drain(createClient().chatStream([{ role: 'user', content: 'hi' }]));
            await expect(promise).rejects.toThrow(LLMHttpError);

            const error = await promise.catch((e: unknown) => e);
            expect((error as LLMHttpError).status).toBe(429);
            // This is what makes failover hop to the next provider instead of
            // hammering a subscription that is out of quota.
            expect(classifyFailure(error)).toEqual({ retry: false, cooldown: true });
        });

        test('an expired token becomes a 401', async () => {
            mockSSE([{ type: 'error', error: { code: 'invalid_token', message: 'token expired' } }]);

            const error = await drain(createClient().chatStream([{ role: 'user', content: 'hi' }])).catch((e: unknown) => e);
            expect((error as LLMHttpError).status).toBe(401);
        });

        test('other failures stay provider errors', async () => {
            mockSSE([{ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } }]);

            const error = await drain(createClient().chatStream([{ role: 'user', content: 'hi' }])).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(LLMProviderError);
        });
    });

    // ========================================================================

    describe('capabilities', () => {
        test('embeddings are not available', async () => {
            await expect(createClient().embed('x')).rejects.toThrow(LLMProviderError);
        });

        test('reports a codex-sized context window', async () => {
            expect((await createClient().getModelInfo('gpt-5.2-codex')).contextLength).toBe(272000);
            expect((await createClient().getModelInfo('gpt-5.1-codex-mini')).contextLength).toBe(128000);
        });
    });
});
