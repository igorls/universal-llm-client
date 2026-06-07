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

    it('creates interleaved-reasoning decoder', () => {
        const decoder = createDecoder('interleaved-reasoning', () => {});
        expect(decoder).toBeInstanceOf(InterleavedReasoningDecoder);
    });

    it('throws for unknown type', () => {
        expect(() => createDecoder('unknown' as never, () => {})).toThrow('Unknown decoder type');
    });
});
