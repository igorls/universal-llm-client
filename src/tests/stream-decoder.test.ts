/**
 * Tests for stream-decoder.ts — Pluggable reasoning strategies
 */
import { describe, it, expect } from 'bun:test';
import {
    PassthroughDecoder,
    StandardChatDecoder,
    InterleavedReasoningDecoder,
    createDecoder,
    type DecodedEvent,
} from '../stream-decoder.js';

describe('PassthroughDecoder', () => {
    it('emits all tokens as text events', () => {
        const events: DecodedEvent[] = [];
        const decoder = new PassthroughDecoder(e => events.push(e));

        decoder.push('Hello');
        decoder.push(' world');
        decoder.flush();

        expect(events).toHaveLength(2);
        expect(events[0]).toEqual({ type: 'text', content: 'Hello' });
        expect(events[1]).toEqual({ type: 'text', content: ' world' });
    });

    it('returns clean content', () => {
        const decoder = new PassthroughDecoder(() => {});
        decoder.push('Hello ');
        decoder.push('world');
        decoder.flush();
        expect(decoder.getCleanContent()).toBe('Hello world');
    });

    it('returns no reasoning', () => {
        const decoder = new PassthroughDecoder(() => {});
        decoder.push('test');
        expect(decoder.getReasoning()).toBeUndefined();
    });
});

describe('StandardChatDecoder', () => {
    it('emits text events', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e));

        decoder.push('Hello');
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ type: 'text', content: 'Hello' });
    });

    it('emits reasoning events', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e));

        decoder.pushReasoning('Thinking...');
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ type: 'thinking', content: 'Thinking...' });
    });

    it('emits tool call events', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e));

        const calls = [{
            id: 'call_1',
            type: 'function' as const,
            function: { name: 'get_time', arguments: '{}' },
        }];
        decoder.pushToolCalls(calls);

        expect(events).toHaveLength(1);
        expect(events[0]!.type).toBe('tool_call');
    });

    it('recovers adjacent bare call syntax without leaking visible text', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e), {
            knownToolNames: new Set(['list_directory', 'shell_execute']),
        });

        decoder.push('call:list_directory({"path":"."})call:shell_execute({"command":"set"})');
        decoder.flush();

        const calls = events
            .filter(e => e.type === 'tool_call')
            .flatMap(e => (e as Extract<DecodedEvent, { type: 'tool_call' }>).calls);
        const text = events
            .filter(e => e.type === 'text')
            .map(e => (e as Extract<DecodedEvent, { type: 'text' }>).content)
            .join('');

        expect(text).toBe('');
        expect(calls.map(call => call.function.name)).toEqual(['list_directory', 'shell_execute']);
        expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ path: '.' });
        expect(JSON.parse(calls[1]!.function.arguments)).toEqual({ command: 'set' });
        expect(decoder.getCleanContent()).toBe('');
    });

    it('recovers bare call syntax split across chunks', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e), {
            knownToolNames: new Set(['list_directory']),
        });

        decoder.push('call:list_dir');
        decoder.push('ectory({"path":"."})');
        decoder.flush();

        const calls = events
            .filter(e => e.type === 'tool_call')
            .flatMap(e => (e as Extract<DecodedEvent, { type: 'tool_call' }>).calls);
        const text = events
            .filter(e => e.type === 'text')
            .map(e => (e as Extract<DecodedEvent, { type: 'text' }>).content)
            .join('');

        expect(text).toBe('');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.function.name).toBe('list_directory');
        expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ path: '.' });
    });

    it('recovers bare call syntax from native reasoning without leaking thinking text', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e), {
            knownToolNames: new Set(['shell_execute']),
        });

        decoder.pushReasoning('call:shell_execute({"command":"set"})');
        decoder.flush();

        const calls = events
            .filter(e => e.type === 'tool_call')
            .flatMap(e => (e as Extract<DecodedEvent, { type: 'tool_call' }>).calls);

        expect(events.filter(e => e.type === 'thinking')).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.function.name).toBe('shell_execute');
        expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ command: 'set' });
        expect(decoder.getReasoning()).toBeUndefined();
    });

    it('recovers loose brace call syntax from native reasoning', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e), {
            knownToolNames: new Set(['memory_search']),
        });

        decoder.pushReasoning('call:memory_search{query:testes}');
        decoder.flush();

        const calls = events
            .filter(e => e.type === 'tool_call')
            .flatMap(e => (e as Extract<DecodedEvent, { type: 'tool_call' }>).calls);

        expect(events.filter(e => e.type === 'thinking')).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.function.name).toBe('memory_search');
        expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ query: 'testes' });
        expect(decoder.getReasoning()).toBeUndefined();
    });

    it('recovers malformed mixed-delimiter call syntax from native reasoning', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e), {
            knownToolNames: new Set(['activate_tools']),
        });

        decoder.pushReasoning('call:activate_tools(module: "@core/memory"}');
        decoder.flush();

        const calls = events
            .filter(e => e.type === 'tool_call')
            .flatMap(e => (e as Extract<DecodedEvent, { type: 'tool_call' }>).calls);

        expect(events.filter(e => e.type === 'thinking')).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.function.name).toBe('activate_tools');
        expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ module: '@core/memory' });
        expect(decoder.getReasoning()).toBeUndefined();
    });

    it('tracks both content and reasoning', () => {
        const decoder = new StandardChatDecoder(() => {});
        decoder.push('Text');
        decoder.pushReasoning('Reason');
        decoder.flush();

        expect(decoder.getCleanContent()).toBe('Text');
        expect(decoder.getReasoning()).toBe('Reason');
    });

    it('parses Gemma thought channel into reasoning', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e));

        decoder.push('<|channel>thought\nNeed Portuguese.<channel|>Olá!');
        decoder.flush();

        expect(events.filter(e => e.type === 'thinking')).toEqual([
            { type: 'thinking', content: 'Need Portuguese.' },
        ]);
        expect(events.filter(e => e.type === 'text').map(e => e.content).join('')).toBe('Olá!');
        expect(decoder.getCleanContent()).toBe('Olá!');
        expect(decoder.getReasoning()).toBe('Need Portuguese.');
    });

    it('parses Gemma thought channel split across chunks', () => {
        const decoder = new StandardChatDecoder(() => {});

        decoder.push('<|chan');
        decoder.push('nel>thought\nNeed');
        decoder.push(' Portuguese.<chan');
        decoder.push('nel|>Olá!');
        decoder.flush();

        expect(decoder.getCleanContent()).toBe('Olá!');
        expect(decoder.getReasoning()).toBe('Need Portuguese.');
    });

    it('strips compact empty Gemma thought marker', () => {
        const decoder = new StandardChatDecoder(() => {});

        decoder.push('<|thought\n|>Olá!');
        decoder.flush();

        expect(decoder.getCleanContent()).toBe('Olá!');
        expect(decoder.getReasoning()).toBeUndefined();
    });

    it('strips tool_call and tool_response tags', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e));

        decoder.push('<tool_call|><|tool_response>');
        decoder.flush();

        expect(events.filter(e => e.type === 'tool_call')).toHaveLength(0);
        expect(decoder.getCleanContent()).toBe('');
    });

    it('parses tool_call containing JSON content', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e));

        decoder.push("<tool_call|>{'name': 'get_weather', 'arguments': {'city': 'Tokyo'}}<|tool_response>");
        decoder.flush();

        const toolCalls = events.filter(e => e.type === 'tool_call');
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0]).toEqual({
            type: 'tool_call',
            calls: [
                {
                    id: expect.any(String),
                    type: 'function',
                    function: {
                        name: 'get_weather',
                        arguments: JSON.stringify({ city: 'Tokyo' }),
                    },
                },
            ],
        });
        expect(decoder.getCleanContent()).toBe('');
    });

    it('strips stray tool_response tags', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e));

        decoder.push('Hello<|tool_response> World');
        decoder.flush();

        expect(decoder.getCleanContent()).toBe('Hello World');
    });
});

describe('StandardChatDecoder — reasoning tags + DiffusionGemma native protocol', () => {
    it('parses <think> tags into reasoning', () => {
        const decoder = new StandardChatDecoder(() => {});
        decoder.push("<think>Let's find the answer</think>The answer is 42.");
        decoder.flush();
        expect(decoder.getReasoning()).toBe("Let's find the answer");
        expect(decoder.getCleanContent()).toBe('The answer is 42.');
    });

    it('parses <thinking> tags into reasoning', () => {
        const decoder = new StandardChatDecoder(() => {});
        decoder.push('<thinking>Let\'s check facts</thinking>Correct.');
        decoder.flush();
        expect(decoder.getReasoning()).toBe("Let's check facts");
        expect(decoder.getCleanContent()).toBe('Correct.');
    });

    it('parses Gemma thought channel with whitespace variants into reasoning', () => {
        const decoder = new StandardChatDecoder(() => {});
        decoder.push('<|channel>   thought\nNeed Portuguese.<channel|>Olá!');
        decoder.flush();
        expect(decoder.getReasoning()).toBe('Need Portuguese.');
        expect(decoder.getCleanContent()).toBe('Olá!');
    });

    it('parses a native DiffusionGemma tool call in one chunk', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e));
        decoder.push('<|tool_call>call:get_weather{city:<|"|>Paris<|"|>,unit:<|"|>celsius<|"|>}<tool_call|>');
        decoder.flush();
        const calls = events.filter(e => e.type === 'tool_call');
        expect(calls).toHaveLength(1);
        const call = (calls[0] as { calls: Array<{ function: { name: string; arguments: string } }> }).calls[0]!;
        expect(call.function.name).toBe('get_weather');
        expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Paris', unit: 'celsius' });
        expect(decoder.getCleanContent()).toBe('');
    });

    it('parses a native DiffusionGemma tool call split across chunks', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e));
        decoder.push('<|tool_');
        decoder.push('call>call:shell_exec{com');
        decoder.push('mand:<|"|>ls -la<|"|>}<tool_');
        decoder.push('call|>Done.');
        decoder.flush();
        const calls = events.filter(e => e.type === 'tool_call');
        expect(calls).toHaveLength(1);
        const call = (calls[0] as { calls: Array<{ function: { name: string; arguments: string } }> }).calls[0]!;
        expect(call.function.name).toBe('shell_exec');
        expect(JSON.parse(call.function.arguments)).toEqual({ command: 'ls -la' });
        expect(decoder.getCleanContent()).toBe('Done.');
    });

    it('handles thought channel + native tool call in one stream', () => {
        const events: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(e => events.push(e));
        decoder.push('<|channel>thought\nNeed the weather tool.<channel|>');
        decoder.push('<|tool_call>call:get_weather{city:<|"|>Rio<|"|>}<tool_call|>');
        decoder.flush();
        expect(decoder.getReasoning()).toBe('Need the weather tool.');
        expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
        expect(decoder.getCleanContent()).toBe('');
    });

    it('discards stray channel and turn markers', () => {
        const decoder = new StandardChatDecoder(() => {});
        decoder.push('<channel|>The answer is 42.<turn|>');
        decoder.flush();
        expect(decoder.getCleanContent()).toBe('The answer is 42.');
    });
});

describe('InterleavedReasoningDecoder', () => {
    it('extracts think tags from text', () => {
        const events: DecodedEvent[] = [];
        const decoder = new InterleavedReasoningDecoder(e => events.push(e));

        decoder.push('<think>I should analyze this</think>The answer is 42');
        decoder.flush();

        const thinkEvents = events.filter(e => e.type === 'thinking');
        const textEvents = events.filter(e => e.type === 'text');

        expect(thinkEvents.length).toBeGreaterThan(0);
        expect(textEvents.length).toBeGreaterThan(0);
        expect(decoder.getReasoning()).toBe('I should analyze this');
        expect(decoder.getCleanContent()).toBe('The answer is 42');
    });

    it('handles think tags split across chunks', () => {
        const events: DecodedEvent[] = [];
        const decoder = new InterleavedReasoningDecoder(e => events.push(e));

        decoder.push('<thi');
        decoder.push('nk>Split reasoning</th');
        decoder.push('ink>Done');
        decoder.flush();

        expect(decoder.getReasoning()).toBe('Split reasoning');
        expect(decoder.getCleanContent()).toBe('Done');
    });

    it('handles progress tags', () => {
        const events: DecodedEvent[] = [];
        const decoder = new InterleavedReasoningDecoder(e => events.push(e));

        decoder.push('<progress>Loading data</progress>Complete');
        decoder.flush();

        const progressEvents = events.filter(e => e.type === 'progress');
        expect(progressEvents.length).toBeGreaterThan(0);
        expect(decoder.getCleanContent()).toBe('Complete');
    });

    it('handles plain text with no tags', () => {
        const events: DecodedEvent[] = [];
        const decoder = new InterleavedReasoningDecoder(e => events.push(e));

        decoder.push('Just plain text');
        decoder.flush();

        expect(decoder.getCleanContent()).toBe('Just plain text');
        expect(decoder.getReasoning()).toBeUndefined();
    });

    it('handles empty reasoning', () => {
        const decoder = new InterleavedReasoningDecoder(() => {});
        decoder.push('<think></think>Content');
        decoder.flush();

        expect(decoder.getCleanContent()).toBe('Content');
        expect(decoder.getReasoning()).toBeUndefined();
    });

    it('handles multiple think blocks', () => {
        const decoder = new InterleavedReasoningDecoder(() => {});

        decoder.push('<think>First thought</think>Text<think>Second thought</think>More text');
        decoder.flush();

        expect(decoder.getReasoning()).toBe('First thoughtSecond thought');
        expect(decoder.getCleanContent()).toBe('TextMore text');
    });
});

describe('createDecoder', () => {
    it('creates passthrough decoder', () => {
        const decoder = createDecoder('passthrough', () => {});
        expect(decoder).toBeInstanceOf(PassthroughDecoder);
    });

    it('creates standard-chat decoder', () => {
        const decoder = createDecoder('standard-chat', () => {});
        expect(decoder).toBeInstanceOf(StandardChatDecoder);
    });

    it('passes known tool names to standard-chat decoder', () => {
        const events: DecodedEvent[] = [];
        const decoder = createDecoder('standard-chat', e => events.push(e), {
            knownToolNames: new Set(['list_directory']),
        });

        decoder.push('call:list_directory({"path":"."})');
        decoder.flush();

        expect(events.filter(e => e.type === 'text')).toEqual([]);
        expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
    });

    it('creates interleaved-reasoning decoder', () => {
        const decoder = createDecoder('interleaved-reasoning', () => {});
        expect(decoder).toBeInstanceOf(InterleavedReasoningDecoder);
    });

    it('throws for unknown type', () => {
        expect(() => createDecoder('unknown' as never, () => {})).toThrow('Unknown decoder type');
    });
});
