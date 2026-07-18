/**
 * Tests for tool-arg-coercion.ts — small-model tool-argument coercion + the
 * self-correcting validation error. Domain-agnostic: every assertion is driven
 * by a declared JSON schema, never a per-tool key map.
 */
import { describe, it, expect } from 'bun:test';
import {
    coerceAndValidateToolArgs,
    parseToolArguments,
    type ToolParameterSchema,
} from '../tool-arg-coercion.js';

const directiveSchema: ToolParameterSchema = {
    type: 'object',
    properties: {
        action: { type: 'string', enum: ['add', 'edit', 'remove'] },
        directiveId: { type: 'string' },
        text: { type: 'string' },
        reason: { type: 'string' },
    },
    required: ['action', 'reason'],
};

describe('parseToolArguments', () => {
    it('passes an object through', () => {
        expect(parseToolArguments({ a: 1 })).toEqual({ a: 1 });
    });
    it('parses a JSON string (double-encoded args)', () => {
        expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    });
    it('returns {} for blank / non-JSON / array', () => {
        expect(parseToolArguments('')).toEqual({});
        expect(parseToolArguments('not json')).toEqual({});
        expect(parseToolArguments('[1,2]')).toEqual({});
        expect(parseToolArguments(null)).toEqual({});
    });
});

describe('coercion (schema-driven, loss-free)', () => {
    const schema: ToolParameterSchema = {
        type: 'object',
        properties: {
            count: { type: 'number' },
            n: { type: 'integer' },
            enabled: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' } },
            meta: { type: 'object' },
            name: { type: 'string' },
        },
    };

    it('coerces a numeric string to number', () => {
        const r = coerceAndValidateToolArgs({ count: '5' }, schema, 't');
        expect(r.error).toBeUndefined();
        expect(r.args.count).toBe(5);
        expect(r.corrected).toBe(true);
    });
    it('truncates a string to integer for an integer-only field', () => {
        expect(coerceAndValidateToolArgs({ n: '3.9' }, schema, 't').args.n).toBe(3);
    });
    it('coerces stringified booleans and 0/1', () => {
        expect(coerceAndValidateToolArgs({ enabled: 'true' }, schema, 't').args.enabled).toBe(true);
        expect(coerceAndValidateToolArgs({ enabled: 0 }, schema, 't').args.enabled).toBe(false);
    });
    it('wraps a lone scalar into an array', () => {
        expect(coerceAndValidateToolArgs({ tags: 'urgent' }, schema, 't').args.tags).toEqual(['urgent']);
    });
    it('parses a JSON-string array', () => {
        expect(coerceAndValidateToolArgs({ tags: '["a","b"]' }, schema, 't').args.tags).toEqual(['a', 'b']);
    });
    it('parses a JSON-string object', () => {
        expect(coerceAndValidateToolArgs({ meta: '{"k":1}' }, schema, 't').args.meta).toEqual({ k: 1 });
    });
    it('stringifies a scalar for a string field', () => {
        expect(coerceAndValidateToolArgs({ name: 42 }, schema, 't').args.name).toBe('42');
    });
    it('leaves an already-valid call untouched (corrected=false)', () => {
        const r = coerceAndValidateToolArgs({ count: 5, enabled: true }, schema, 't');
        expect(r.corrected).toBe(false);
        expect(r.error).toBeUndefined();
    });
});

describe('validation → self-correcting error', () => {
    it('reports the exact directive/KB collision (wrong keys, missing required)', () => {
        // The real incident: 12b sent kb_upsert-shaped {topic, content}.
        const r = coerceAndValidateToolArgs({ topic: 'x', content: 'y' }, directiveSchema, 'propose_directive_update');
        expect(r.error).toBeDefined();
        expect(r.error).toContain('propose_directive_update');
        expect(r.error).toContain('action');
        expect(r.error).toContain('reason');
        expect(r.error).toContain('add|edit|remove');
        expect(r.error).toContain('topic');
        expect(r.error).toContain('content');
    });
    it('flags an enum violation', () => {
        const r = coerceAndValidateToolArgs({ action: 'delete', reason: 'x' }, directiveSchema, 't');
        expect(r.error).toContain('one of add|edit|remove');
    });
    it('flags an un-coercible type', () => {
        const schema: ToolParameterSchema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] };
        const r = coerceAndValidateToolArgs({ count: 'not-a-number' }, schema, 't');
        expect(r.error).toContain('count must be number');
    });
    it('emits a did-you-mean hint for a near-miss key', () => {
        const r = coerceAndValidateToolArgs({ actoin: 'add', reason: 'x' }, directiveSchema, 't');
        expect(r.error).toContain('Did you mean');
        expect(r.error).toContain('"actoin"');
    });
    it('accepts a valid call with an optional field omitted', () => {
        const r = coerceAndValidateToolArgs({ action: 'add', text: 'Be concise', reason: 'clarity' }, directiveSchema, 't');
        expect(r.error).toBeUndefined();
    });
});

describe('fail-open (never false-block)', () => {
    it('passes through when there is no schema', () => {
        const r = coerceAndValidateToolArgs({ anything: 1 }, undefined, 't');
        expect(r.error).toBeUndefined();
        expect(r.args).toEqual({ anything: 1 });
    });
    it('does not block a property with no declared type', () => {
        const schema: ToolParameterSchema = { type: 'object', properties: { free: {} }, required: ['free'] };
        const r = coerceAndValidateToolArgs({ free: { nested: true } }, schema, 't');
        expect(r.error).toBeUndefined();
    });
    it('ignores harness-injected _-prefixed keys (not in schema, not required)', () => {
        const r = coerceAndValidateToolArgs(
            { action: 'add', reason: 'x', _agentId: 'a1', _sessionId: 's1' },
            directiveSchema,
            't',
        );
        expect(r.error).toBeUndefined();
        expect(r.args._agentId).toBe('a1');
    });
});
