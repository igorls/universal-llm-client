/**
 * Stream Loop Guard tests — client-side runaway protection.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { StreamLoopGuard, collapseRepeatedRuns, collapseRepeatsInToolArguments } from '../stream-guard.js';
import { OpenAICompatibleClient } from '../providers/openai.js';
import { AIModelApiType } from '../interfaces.js';

describe('StreamLoopGuard', () => {
    test('triggers on a sustained short-pattern loop', () => {
        const guard = new StreamLoopGuard({ checkIntervalPushes: 10 });
        let detection = null;
        // "I'm sorry. " repeated far past the 600-char span threshold
        for (let i = 0; i < 200 && !detection; i++) {
            detection = guard.push("I'm sorry. ");
        }
        expect(detection).not.toBeNull();
        expect(detection!.reason).toBe('repetition');
        expect(detection!.repeats!).toBeGreaterThanOrEqual(8);
    });

    test('does NOT trigger on a legitimate separator line', () => {
        const guard = new StreamLoopGuard({ checkIntervalPushes: 1 });
        // Real output: prose + a 40-char '=' separator + more prose
        expect(guard.push('Here are the results of the benchmark run:\n')).toBeNull();
        expect(guard.push('='.repeat(40) + '\n')).toBeNull();
        expect(guard.push('All 12 tests passed with no regressions found in the suite.\n')).toBeNull();
        expect(guard.detection).toBeNull();
    });

    test('does NOT trigger on normal varied prose', () => {
        const guard = new StreamLoopGuard({ checkIntervalPushes: 1 });
        for (let i = 0; i < 300; i++) {
            expect(guard.push(`Sentence number ${i} talks about a different topic entirely. `)).toBeNull();
        }
    });

    test('catches sentence loops longer than the char-pattern cap (the std.os.args incident)', () => {
        const guard = new StreamLoopGuard({ checkIntervalPushes: 5 });
        // The exact live loop: a ~68-char sentence separated by blank lines —
        // longer than any char-level pattern the old detector tested.
        const unit = "I'll try to use `std.os.args` but I'll check if it's `std.os.args`.\n\n";
        let detection = null;
        for (let i = 0; i < 60 && !detection; i++) {
            detection = guard.push(unit);
        }
        expect(detection).not.toBeNull();
        expect(['paragraph_loop', 'repetition']).toContain(detection!.reason);
    });

    test('triggers the absolute max_chars ceiling on non-repetitive runaways', () => {
        const guard = new StreamLoopGuard({ maxChars: 5_000 });
        let detection = null;
        for (let i = 0; i < 200 && !detection; i++) {
            detection = guard.push(`Completely unique reasoning fragment ${i} ${Math.sin(i)} `);
        }
        expect(detection).not.toBeNull();
        expect(detection!.reason).toBe('max_chars');
    });
});

describe('collapseRepeatedRuns', () => {
    test('collapses a looping paragraph to one copy + marker', () => {
        const unit = "I'll try to use `std.os.args` but I'll check if it's `std.os.args`.";
        const text = Array.from({ length: 20 }, () => unit).join('\n\n');
        const result = collapseRepeatedRuns(text);
        expect(result.collapsed).toBe(19);
        expect(result.text).toContain(unit);
        expect(result.text).toContain('repeated 20×');
        expect(result.text.length).toBeLessThan(text.length / 5);
    });

    test('leaves varied text untouched', () => {
        const text = 'First paragraph about A.\n\nSecond paragraph about B.\n\nThird paragraph about C.';
        const result = collapseRepeatedRuns(text);
        expect(result.collapsed).toBe(0);
        expect(result.text).toBe(text);
    });

    test('collapses loops inside JSON tool arguments without corrupting the JSON', () => {
        const loop = Array.from({ length: 15 }, () => 'I will check std.process now.').join('\n\n');
        const args = JSON.stringify({ thought: loop, other: 42 });
        const result = collapseRepeatsInToolArguments(args);
        expect(result.collapsed).toBe(14);
        const parsed = JSON.parse(result.argsJson) as { thought: string; other: number };
        expect(parsed.other).toBe(42);
        expect(parsed.thought).toContain('repeated 15×');
    });

    test('returns non-JSON arguments unchanged', () => {
        const result = collapseRepeatsInToolArguments('not json at all');
        expect(result.argsJson).toBe('not json at all');
        expect(result.collapsed).toBe(0);
    });
});

describe('OpenAICompatibleClient runaway protection', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function sseChunk(delta: Record<string, unknown>): string {
        return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
    }

    test('applies a bounded default max_tokens when the endpoint reports its window', async () => {
        let chatBody: Record<string, unknown> | null = null;
        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).includes('/models')) {
                return new Response(
                    JSON.stringify({ object: 'list', data: [{ id: 'gemma-vllm', max_model_len: 32768 }] }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }
            chatBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
            return new Response(
                JSON.stringify({
                    id: 'x', object: 'chat.completion', created: 1, model: 'gemma-vllm',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }) as unknown as typeof globalThis.fetch;

        const client = new OpenAICompatibleClient({
            model: 'gemma-vllm',
            url: 'http://localhost:8010/v1',
            apiType: AIModelApiType.OpenAI,
        });
        await client.chat([{ role: 'user', content: 'hi' }]);

        expect(chatBody).not.toBeNull();
        const maxTokens = chatBody!['max_tokens'] as number;
        expect(maxTokens).toBeGreaterThanOrEqual(256);
        expect(maxTokens).toBeLessThanOrEqual(8192);
    });

    test('leaves max_tokens unset for endpoints with no window metadata', async () => {
        let chatBody: Record<string, unknown> | null = null;
        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).includes('/models')) {
                return new Response(JSON.stringify({ object: 'list', data: [] }), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            }
            chatBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
            return new Response(
                JSON.stringify({
                    id: 'x', object: 'chat.completion', created: 1, model: 'gpt-x',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }) as unknown as typeof globalThis.fetch;

        const client = new OpenAICompatibleClient({
            model: 'gpt-x',
            url: 'https://api.example.com/v1',
            apiType: AIModelApiType.OpenAI,
        });
        await client.chat([{ role: 'user', content: 'hi' }]);
        expect(chatBody!['max_tokens']).toBeUndefined();
    });

    test('aborts a looping stream and returns finishReason degeneration', async () => {
        const originalWarn = console.warn;
        console.warn = mock(() => undefined) as unknown as typeof console.warn;
        let aborted = false;

        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).includes('/models')) {
                return new Response(JSON.stringify({ object: 'list', data: [] }), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            }
            init?.signal?.addEventListener('abort', () => {
                aborted = true;
            });
            const stream = new ReadableStream<Uint8Array>({
                pull(controller) {
                    // Endless reasoning loop until the client aborts
                    if (aborted) {
                        controller.close();
                        return;
                    }
                    controller.enqueue(
                        new TextEncoder().encode(sseChunk({ reasoning_content: 'I need to think about this again. ' })),
                    );
                },
            });
            return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }) as unknown as typeof globalThis.fetch;

        try {
            const client = new OpenAICompatibleClient({
                model: 'loopy',
                url: 'http://localhost:8010/v1',
                apiType: AIModelApiType.OpenAI,
            });

            const gen = client.chatStream([{ role: 'user', content: 'hi' }]);
            let result: IteratorResult<unknown, unknown>;
            let events = 0;
            while (!(result = await gen.next()).done) {
                events++;
                if (events > 100_000) throw new Error('stream never terminated');
            }

            const response = result.value as { finishReason?: string };
            expect(response?.finishReason).toBe('degeneration');
            expect(aborted).toBe(true);
        } finally {
            console.warn = originalWarn;
        }
    });

    test('aborts a loop inside tool-call ARGUMENTS and drops the partial call', async () => {
        const originalWarn = console.warn;
        console.warn = mock(() => undefined) as unknown as typeof console.warn;
        let aborted = false;
        let first = true;

        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).includes('/models')) {
                return new Response(JSON.stringify({ object: 'list', data: [] }), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            }
            init?.signal?.addEventListener('abort', () => {
                aborted = true;
            });
            const stream = new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (aborted) {
                        controller.close();
                        return;
                    }
                    const delta = first
                        ? { tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'think', arguments: '{"thought":"' } }] }
                        : { tool_calls: [{ index: 0, function: { arguments: "I'll try to use argsAlloc again. " } }] };
                    first = false;
                    controller.enqueue(new TextEncoder().encode(sseChunk(delta)));
                },
            });
            return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }) as unknown as typeof globalThis.fetch;

        try {
            const client = new OpenAICompatibleClient({
                model: 'loopy-tool',
                url: 'http://localhost:8010/v1',
                apiType: AIModelApiType.OpenAI,
            });

            const gen = client.chatStream([{ role: 'user', content: 'hi' }], {
                tools: [{
                    type: 'function',
                    function: { name: 'think', description: 'think', parameters: { type: 'object', properties: {} } },
                }],
            });
            let result: IteratorResult<unknown, unknown>;
            let events = 0;
            while (!(result = await gen.next()).done) {
                events++;
                if (events > 100_000) throw new Error('stream never terminated');
            }

            const response = result.value as { finishReason?: string; message?: { tool_calls?: unknown[] } };
            expect(response?.finishReason).toBe('degeneration');
            expect(aborted).toBe(true);
            // The partial looping tool call must NOT be surfaced for execution
            expect(response?.message?.tool_calls ?? undefined).toBeUndefined();
        } finally {
            console.warn = originalWarn;
        }
    });
});
