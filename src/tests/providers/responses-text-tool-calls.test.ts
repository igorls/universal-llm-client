/**
 * Tool calls written as message text on the Responses transport.
 *
 * Reproduces a ChatGPT-backend turn where the model put the Harmony recipient
 * in the message body instead of the header, so the server streamed the
 * attempted `progress` call as ordinary assistant text, then made the real
 * call. Pins that the leak never reaches the visible stream or the message
 * content, that genuine reasoning and prose still stream, and that a
 * well-formed leak becomes the real call only when the model made none.
 */

import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { ResponsesClient } from '../../providers/openai-responses.js';
import { classifyHeldText } from '../../providers/responses-text-tool-calls.js';
import { AIModelApiType, type LLMChatResponse, type LLMToolDefinition } from '../../interfaces.js';
import type { DecodedEvent } from '../../stream-decoder.js';

// ============================================================================
// Helpers
// ============================================================================

function mockSSE(events: Array<Record<string, unknown>>): void {
    const payload = events.map(e => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    globalThis.fetch = mock(async () => new Response(payload, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch;
}

function createClient(): ResponsesClient {
    return new ResponsesClient({
        apiType: AIModelApiType.OpenAI,
        model: 'gpt-6-luna:medium',
        url: 'https://chatgpt.com/backend-api/codex',
        authResolver: async () => ({ accessToken: 'tok_123', accountId: 'acct_abc' }),
        originator: 'codex_cli_rs',
    });
}

async function drain(
    stream: AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>,
): Promise<{ events: DecodedEvent[]; result: LLMChatResponse }> {
    const events: DecodedEvent[] = [];
    let next = await stream.next();
    while (!next.done) {
        events.push(next.value);
        next = await stream.next();
    }
    if (!next.value) throw new Error('stream returned no response');
    return { events, result: next.value };
}

const TOOLS: LLMToolDefinition[] = ['progress', 'write_file'].map(name => ({
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties: {} } },
}));

const STATUS = 'The brief calls for a framework-free single page. The folder currently contains only README.md, '
    + 'so I’m creating the site as plain HTML/CSS/JS with an original roast-bag illustration.';
const STATUS_ARGS = JSON.stringify({ status: STATUS });

/** The exact text the model streamed instead of calling `progress`. */
const LEAKED_TEXT = `${STATUS_ARGS} for functions.progress\n`
    + `${STATUS_ARGS} is not valid? tool target is commentary actual functions.progress`;

/** One assistant message item, its text split into deltas the way the backend chunks it. */
function messageItem(id: string, index: number, chunks: string[]): Array<Record<string, unknown>> {
    const full = chunks.join('');
    return [
        {
            type: 'response.output_item.added',
            output_index: index,
            item: { id, type: 'message', role: 'assistant', status: 'in_progress', content: [], phase: 'commentary' },
        },
        {
            type: 'response.content_part.added',
            item_id: id, output_index: index, content_index: 0, part: { type: 'output_text', text: '' },
        },
        ...chunks.map(delta => ({
            type: 'response.output_text.delta', item_id: id, output_index: index, content_index: 0, delta,
        })),
        { type: 'response.output_text.done', item_id: id, output_index: index, content_index: 0, text: full },
        {
            type: 'response.output_item.done',
            output_index: index,
            item: {
                id, type: 'message', role: 'assistant', status: 'completed',
                content: [{ type: 'output_text', text: full }], phase: 'commentary',
            },
        },
    ];
}

function reasoningItem(index: number, summary: string): Array<Record<string, unknown>> {
    return [
        { type: 'response.reasoning_summary_text.delta', item_id: `rs_${index}`, output_index: index, delta: summary },
        {
            type: 'response.output_item.done',
            output_index: index,
            item: { id: `rs_${index}`, type: 'reasoning', encrypted_content: 'ENC', summary: [] },
        },
    ];
}

function functionCallItem(index: number, callId: string, name: string, args: string): Array<Record<string, unknown>> {
    return [
        {
            type: 'response.output_item.added',
            output_index: index,
            item: { id: `fc_${index}`, type: 'function_call', call_id: callId, name, arguments: '' },
        },
        { type: 'response.function_call_arguments.delta', item_id: `fc_${index}`, output_index: index, delta: args },
        {
            type: 'response.output_item.done',
            output_index: index,
            item: { id: `fc_${index}`, type: 'function_call', call_id: callId, name, arguments: args },
        },
    ];
}

/** Split text into fixed-size deltas, like a token stream. */
function chunk(text: string, size = 7): string[] {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
}

const COMPLETED = { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } };

function visibleText(events: DecodedEvent[]): string {
    return events.map(e => (e.type === 'text' || e.type === 'thinking' ? e.content : '')).join('');
}

// ============================================================================
// Tests
// ============================================================================

describe('tool calls written as message text', () => {
    let originalFetch: typeof globalThis.fetch;
    let debugSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        debugSpy = spyOn(console, 'debug').mockImplementation(() => {});
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        debugSpy.mockRestore();
    });

    test('the observed leak never reaches thinking, text, or message content', async () => {
        mockSSE([
            ...reasoningItem(0, '**Preparing site files**'),
            ...messageItem('msg_1', 1, chunk(LEAKED_TEXT)),
            ...functionCallItem(2, 'call_real', 'progress', STATUS_ARGS),
            COMPLETED,
        ]);
        const { events, result } = await drain(createClient().chatStream(
            [{ role: 'user', content: 'Build the site' }],
            { tools: TOOLS },
        ));

        // Genuine reasoning still streams as thinking.
        expect(events.filter(e => e.type === 'thinking')).toEqual([
            { type: 'thinking', content: '**Preparing site files**' },
        ]);
        expect(events.some(e => e.type === 'text')).toBe(false);
        expect(visibleText(events)).not.toContain('functions.progress');
        expect(result.message.content).toBe('');

        // Only the real call runs; the leaked attempt is not replayed as a second one.
        expect(result.message.tool_calls).toEqual([
            { id: 'call_real', type: 'function', function: { name: 'progress', arguments: STATUS_ARGS } },
        ]);
        expect(result.finishReason).toBe('tool_calls');
        expect(debugSpy).toHaveBeenCalled();
    });

    test('a well-formed leak becomes the real call when the model made none', async () => {
        mockSSE([
            ...messageItem('msg_1', 0, chunk(`${STATUS_ARGS} for functions.progress`)),
            COMPLETED,
        ]);
        const { events, result } = await drain(createClient().chatStream(
            [{ role: 'user', content: 'Build the site' }],
            { tools: TOOLS },
        ));

        expect(events.some(e => e.type === 'text')).toBe(false);
        const calls = events.flatMap(e => (e.type === 'tool_call' ? e.calls : []));
        expect(calls).toHaveLength(1);
        expect(calls[0]?.function).toEqual({ name: 'progress', arguments: STATUS_ARGS });
        expect(result.message.content).toBe('');
        expect(result.message.tool_calls).toEqual(calls);
        expect(result.finishReason).toBe('tool_calls');
    });

    test('a raw Harmony header leak is recovered too', async () => {
        mockSSE([
            ...messageItem('msg_1', 0, chunk('to=functions.write_file <|constrain|>json<|message|>{"path":"index.html"}')),
            COMPLETED,
        ]);
        const { events, result } = await drain(createClient().chatStream(
            [{ role: 'user', content: 'go' }],
            { tools: TOOLS },
        ));

        expect(events.some(e => e.type === 'text')).toBe(false);
        expect(result.message.tool_calls?.[0]?.function).toEqual({ name: 'write_file', arguments: '{"path":"index.html"}' });
    });

    test('prose still streams delta by delta, even when it names a tool', async () => {
        const prose = 'I will post an update with functions.progress once the files exist.';
        const deltas = chunk(prose);
        mockSSE([...messageItem('msg_1', 0, deltas), COMPLETED]);
        const { events, result } = await drain(createClient().chatStream(
            [{ role: 'user', content: 'go' }],
            { tools: TOOLS },
        ));

        expect(events).toEqual(deltas.map(content => ({ type: 'text', content })));
        expect(result.message.content).toBe(prose);
        expect(result.message.tool_calls).toBeUndefined();
    });

    test('a JSON answer with no recipient is released intact', async () => {
        const answer = '{"name":"Northwind","plans":["Basic","Pro"]}';
        mockSSE([...messageItem('msg_1', 0, chunk(answer)), COMPLETED]);
        const { events, result } = await drain(createClient().chatStream(
            [{ role: 'user', content: 'Give me the JSON' }],
            { tools: TOOLS },
        ));

        expect(visibleText(events)).toBe(answer);
        expect(result.message.content).toBe(answer);
        expect(result.message.tool_calls).toBeUndefined();
    });

    test('without offered tools nothing is held back', async () => {
        const deltas = chunk(`${STATUS_ARGS} for functions.progress`);
        mockSSE([...messageItem('msg_1', 0, deltas), COMPLETED]);
        const { events } = await drain(createClient().chatStream([{ role: 'user', content: 'go' }]));

        expect(events).toEqual(deltas.map(content => ({ type: 'text', content })));
    });
});

describe('classifyHeldText', () => {
    const tools = new Set(['progress', 'write_file']);

    test('a recipient for a tool that was not offered is not a leak', () => {
        expect(classifyHeldText('{"a":1} for functions.unknown_tool', tools)).toEqual({
            kind: 'release',
            text: '{"a":1} for functions.unknown_tool',
        });
    });

    test('a recipient only inside the JSON object is not a leak', () => {
        const text = '{"note":"see functions.progress"}';
        expect(classifyHeldText(text, tools)).toEqual({ kind: 'release', text });
    });

    test('a leak with narration around it is dropped, not recovered', () => {
        const text = `${STATUS_ARGS} is not valid? tool target is commentary actual functions.progress`;
        expect(classifyHeldText(text, tools)).toEqual({ kind: 'leak', leak: { text } });
    });
});
