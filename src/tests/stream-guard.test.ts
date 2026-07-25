/**
 * Stream Loop Guard tests — client-side runaway protection.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
    StreamLoopGuard,
    collapseRepeatedRuns,
    collapseRepeatsInToolArguments,
    stripRepeatedTail,
} from '../stream-guard.js';
import { OpenAICompatibleClient } from '../providers/openai.js';
import { AIModelApiType } from '../interfaces.js';

/**
 * The verbatim 5-paragraph, ~875-char cycle from the threejs-game session
 * (conv_ms02efk4_bf0w), which looped 18× past every guard in the stack.
 */
const INCIDENT_CYCLE = [
    'Actually, I think the issue might be that the `browser_evaluate` runs in an isolated context. The events dispatched in the `browser_evaluate` context might not be received by the page\'s JavaScript.',
    'Let me try a different approach. Let me use the `browser_key` tool to press keys, which should simulate real key presses.',
    "Actually, I already tried using `browser_key` to press ArrowRight and ArrowUp, and the timer started counting down. So the game is in the PLAYING state. But the score is still 0, which means the player hasn't collected a gem.",
    'The issue might be that the player is not moving to a collectible\'s position. The player moves 0.1 units per key press, and the collectibles are at random positions. I need to press many keys to move the player to a collectible.',
    "Let me try pressing more keys. I'll press ArrowUp 20 times to move the player from y=-2 to y=0.",
];

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

    test('catches a MULTI-paragraph cycle where no two consecutive paragraphs match (threejs-game incident)', () => {
        // The live loop: 5 different paragraphs repeating as a block, 18×.
        // Char-level missed it (875-char period > the 192 cap) and the
        // run detector missed it (max consecutive identical paragraphs = 1).
        const guard = new StreamLoopGuard({ checkIntervalPushes: 5 });
        let detection = null;
        for (let i = 0; i < 12 && !detection; i++) {
            for (const paragraph of INCIDENT_CYCLE) {
                detection = guard.push(paragraph + '\n\n');
                if (detection) break;
            }
        }
        expect(detection).not.toBeNull();
        expect(detection!.reason).toBe('cycle_loop');
        expect(detection!.period).toBe(INCIDENT_CYCLE.length);
        expect(detection!.repeats!).toBeGreaterThanOrEqual(3);
    });

    test('default tailWindow holds enough cycles for a ~875-char loop', () => {
        // The pre-fix 2048-char window could not have held 3 cycles even with a
        // correct detector — pin that the default is wide enough.
        expect(INCIDENT_CYCLE.join('\n\n').length).toBeGreaterThan(800);
        const guard = new StreamLoopGuard({ checkIntervalPushes: 5 });
        let detection = null;
        for (let i = 0; i < 10 && !detection; i++) {
            detection = guard.push(INCIDENT_CYCLE.join('\n\n') + '\n\n');
        }
        expect(detection).not.toBeNull();
        expect(detection!.reason).toBe('cycle_loop');
    });

    test('catches a multi-LINE cycle separated by single newlines', () => {
        const guard = new StreamLoopGuard({ checkIntervalPushes: 5 });
        const unitA = 'Checking whether the module resolved correctly before the retry.';
        const unitB = 'It did not resolve, so I will attempt the alternate import path again.';
        const unitC = 'The alternate import path is the same one I already attempted above.';
        let detection = null;
        for (let i = 0; i < 12 && !detection; i++) {
            detection = guard.push(`${unitA}\n${unitB}\n${unitC}\n`);
        }
        expect(detection).not.toBeNull();
        expect(detection!.reason).toBe('cycle_loop');
        expect(detection!.period).toBe(3);
    });

    test('does NOT trigger on a short repeated code block below the span floor', () => {
        // Legitimately repetitive structured output (assertions, table rows).
        // A 2-line block ×3 covers ~120 chars — far under the 600-char floor.
        const guard = new StreamLoopGuard({ checkIntervalPushes: 1 });
        for (let i = 0; i < 3; i++) {
            expect(guard.push('  expect(result.ok).toBe(true);\n  expect(result.id).toBe(7);\n')).toBeNull();
        }
        expect(guard.detection).toBeNull();
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

    test('collapses a multi-paragraph cycle to one copy + marker', () => {
        const text = Array.from({ length: 4 }, () => INCIDENT_CYCLE.join('\n\n')).join('\n\n');
        const result = collapseRepeatedRuns(text);
        // 20 paragraphs in, one 5-paragraph copy out → 15 removed
        expect(result.collapsed).toBe(15);
        expect(result.text).toContain('5-part cycle repeated 4×');
        expect(result.text).toContain(INCIDENT_CYCLE[0]);
        // Each paragraph of the cycle survives exactly once
        expect(result.text.split(INCIDENT_CYCLE[2]!).length - 1).toBe(1);
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

describe('stripRepeatedTail', () => {
    const PREFIX =
        'I installed vite and the module specifier now resolves, so the dev server is serving the game on port 3001.\n\n' +
        'The start overlay disappears on the first key press and the countdown begins.';

    test('cuts a multi-paragraph cycle and keeps the healthy prefix', () => {
        const text = `${PREFIX}\n\n${Array.from({ length: 5 }, () => INCIDENT_CYCLE.join('\n\n')).join('\n\n')}`;
        const stripped = stripRepeatedTail(text);
        expect(stripped).toBe(PREFIX);
        expect(stripped).not.toContain('browser_evaluate');
    });

    test('cuts a plain repeated-paragraph run', () => {
        const unit = "I'll try to use `std.os.args` but I'll check if it's `std.os.args`.";
        const text = `${PREFIX}\n\n${Array.from({ length: 12 }, () => unit).join('\n\n')}`;
        expect(stripRepeatedTail(text)).toBe(PREFIX);
    });

    test('cuts a newline-free char-level loop', () => {
        const text = `${PREFIX} ${"I'm sorry. ".repeat(80)}`;
        const stripped = stripRepeatedTail(text);
        expect(stripped.startsWith(PREFIX)).toBe(true);
        expect(stripped.length).toBeLessThan(PREFIX.length + 24);
    });

    test('leaves healthy output untouched', () => {
        const text = `${PREFIX}\n\nThe score increments when the player reaches a gem, and the win overlay renders at 50 points.`;
        expect(stripRepeatedTail(text)).toBe(text);
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

    test('drops length-truncated tool calls with malformed arguments and carries finish_reason', async () => {
        const originalWarn = console.warn;
        console.warn = mock(() => undefined) as unknown as typeof console.warn;

        globalThis.fetch = mock(async (input: string | URL | Request) => {
            if (String(input).includes('/models')) {
                return new Response(JSON.stringify({ object: 'list', data: [] }), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            }
            // A tool call cut mid-arguments by the output cap: finish 'length'
            const sse =
                sseChunk({ tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'write_file', arguments: '{"path":"x.zig","content":"const s' } }] }) +
                `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n` +
                'data: [DONE]\n\n';
            return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }) as unknown as typeof globalThis.fetch;

        try {
            const client = new OpenAICompatibleClient({
                model: 'truncated-tool',
                url: 'http://localhost:8010/v1',
                apiType: AIModelApiType.OpenAI,
            });
            const gen = client.chatStream([{ role: 'user', content: 'hi' }], {
                tools: [{
                    type: 'function',
                    function: { name: 'write_file', description: 'w', parameters: { type: 'object', properties: {} } },
                }],
            });
            let result: IteratorResult<unknown, unknown>;
            while (!(result = await gen.next()).done) { /* consume */ }

            const response = result.value as { finishReason?: string; message?: { tool_calls?: unknown[] } };
            // Partial JSON args must never surface for execution or history
            expect(response?.message?.tool_calls ?? undefined).toBeUndefined();
            expect(response?.finishReason).toBe('length');
        } finally {
            console.warn = originalWarn;
        }
    });

    test('sanitizes malformed tool-call arguments in OUTBOUND history frames', async () => {
        let chatBody: { messages?: Array<{ tool_calls?: Array<{ function: { arguments: string } }> }> } | null = null;
        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).includes('/models')) {
                return new Response(JSON.stringify({ object: 'list', data: [] }), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            }
            chatBody = JSON.parse(String(init?.body ?? '{}'));
            return new Response(
                JSON.stringify({
                    id: 'x', object: 'chat.completion', created: 1, model: 'm',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }) as unknown as typeof globalThis.fetch;

        const client = new OpenAICompatibleClient({
            model: 'm',
            url: 'http://localhost:8010/v1',
            apiType: AIModelApiType.OpenAI,
        });
        await client.chat([
            { role: 'user', content: 'do it' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    { id: 'ok', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
                    { id: 'bad', type: 'function', function: { name: 'b', arguments: '{"path":"x.zig","content":"const s' } },
                ],
            },
            { role: 'tool', content: '{}', tool_call_id: 'ok' },
            { role: 'tool', content: '{}', tool_call_id: 'bad' },
        ]);

        const frame = chatBody!.messages!.find((m) => m.tool_calls);
        expect(frame).toBeDefined();
        const args = frame!.tool_calls!.map((tc) => tc.function.arguments);
        expect(args[0]).toBe('{"x":1}');
        // Malformed args replaced with a valid-JSON stub — vLLM json.loads-
        // validates every frame and 400s the whole request otherwise.
        expect(() => JSON.parse(args[1]!)).not.toThrow();
        expect(args[1]).toContain('_invalid');
    });
});
