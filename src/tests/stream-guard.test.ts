/**
 * Stream Loop Guard tests — client-side runaway protection.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { StreamLoopGuard } from '../stream-guard.js';
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
});
