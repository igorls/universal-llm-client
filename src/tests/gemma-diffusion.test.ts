/**
 * Tests for the DiffusionGemma native-protocol adapter.
 * Wire-format samples are taken verbatim from live vLLM responses
 * (skip_special_tokens: false) captured June 2026.
 */

import { describe, expect, it } from 'bun:test';
import {
    gemmaArgsToJson,
    isGemmaDiffusionModel,
    parseGemmaDiffusionOutput,
} from '../gemma-diffusion.js';

describe('isGemmaDiffusionModel', () => {
    it('detects the served model id', () => {
        expect(isGemmaDiffusionModel('RedHatAI/diffusiongemma-26B-A4B-it-NVFP4')).toBe(true);
        expect(isGemmaDiffusionModel('nvidia/DiffusionGemma-26B')).toBe(true);
        expect(isGemmaDiffusionModel('diffusion_gemma-mini')).toBe(true);
    });

    it('ignores other models', () => {
        expect(isGemmaDiffusionModel('gemma-4-27b-it')).toBe(false);
        expect(isGemmaDiffusionModel('gpt-4o')).toBe(false);
        expect(isGemmaDiffusionModel('stable-diffusion-xl')).toBe(false);
    });
});

describe('gemmaArgsToJson', () => {
    it('converts quoted strings and bare keys', () => {
        const json = gemmaArgsToJson('city:<|"|>Paris<|"|>,unit:<|"|>celsius<|"|>');
        expect(JSON.parse(json)).toEqual({ city: 'Paris', unit: 'celsius' });
    });

    it('handles numbers, booleans and null', () => {
        const json = gemmaArgsToJson('count:3,ratio:-2.5e2,on:true,off:false,nothing:null');
        expect(JSON.parse(json)).toEqual({ count: 3, ratio: -250, on: true, off: false, nothing: null });
    });

    it('preserves JSON-hostile characters inside quoted strings', () => {
        const json = gemmaArgsToJson('q:<|"|>a, b: {c} [d] "e"<|"|>');
        expect(JSON.parse(json)).toEqual({ q: 'a, b: {c} [d] "e"' });
    });

    it('handles nested objects and arrays', () => {
        const json = gemmaArgsToJson('filter:{city:<|"|>Rio<|"|>,limit:2},tags:[<|"|>a<|"|>,<|"|>b<|"|>,1]');
        expect(JSON.parse(json)).toEqual({ filter: { city: 'Rio', limit: 2 }, tags: ['a', 'b', 1] });
    });

    it('treats unquoted bare words as strings (model deviation)', () => {
        const json = gemmaArgsToJson('unit:celsius,city:Paris');
        expect(JSON.parse(json)).toEqual({ unit: 'celsius', city: 'Paris' });
    });

    it('accepts normal quoted strings (model deviation)', () => {
        const json = gemmaArgsToJson('module: "@core/memory",query:"testes"');
        expect(JSON.parse(json)).toEqual({ module: '@core/memory', query: 'testes' });
    });

    it('handles empty arguments', () => {
        expect(JSON.parse(gemmaArgsToJson(''))).toEqual({});
    });
});

describe('parseGemmaDiffusionOutput', () => {
    it('parses the live tool-call wire format', () => {
        const raw =
            '<|channel>thought\nThe user is asking for the weather. I should use the `get_weather` tool.<channel|>' +
            '<|tool_call>call:get_weather{city:<|"|>Paris<|"|>,unit:<|"|>celsius<|"|>}<tool_call|>';
        const parsed = parseGemmaDiffusionOutput(raw);
        expect(parsed.reasoning).toContain('get_weather');
        expect(parsed.content).toBe('');
        expect(parsed.toolCalls).toHaveLength(1);
        expect(parsed.toolCalls[0]!.name).toBe('get_weather');
        expect(JSON.parse(parsed.toolCalls[0]!.argumentsJson)).toEqual({ city: 'Paris', unit: 'celsius' });
    });

    it('separates reasoning from answer (the live 42 sample)', () => {
        const raw =
            '<|channel>thought\n*   Question: What is 17 + 25?\n    *   30 + 12 = 42\n\n    *   The answer is 42.<channel|>42';
        const parsed = parseGemmaDiffusionOutput(raw);
        expect(parsed.content).toBe('42');
        expect(parsed.reasoning).toContain('30 + 12 = 42');
        expect(parsed.toolCalls).toHaveLength(0);
    });

    it('handles answer text after a tool result turn (no thought)', () => {
        const parsed = parseGemmaDiffusionOutput('The current weather in Paris is 18°C and partly cloudy.');
        expect(parsed.content).toBe('The current weather in Paris is 18°C and partly cloudy.');
        expect(parsed.reasoning).toBe('');
        expect(parsed.toolCalls).toHaveLength(0);
    });

    it('captures a dangling unterminated thought channel (max_tokens cutoff)', () => {
        const parsed = parseGemmaDiffusionOutput('<|channel>thought\nStill reasoning about');
        expect(parsed.content).toBe('');
        expect(parsed.reasoning).toBe('Still reasoning about');
    });

    it('parses the parenthesized textual call form (live poisoned-history sample, July 2026)', () => {
        // Captured verbatim from a vLLM gemma-4 session whose history taught
        // the model the `call:name({json})` style; the old grammar silently
        // swallowed this call.
        const raw = '<|channel>thought\n<channel|><|tool_call>call:sessions({action: "list"})<tool_call|>';
        const parsed = parseGemmaDiffusionOutput(raw);
        expect(parsed.toolCalls).toHaveLength(1);
        expect(parsed.toolCalls[0]!.name).toBe('sessions');
        expect(JSON.parse(parsed.toolCalls[0]!.argumentsJson)).toEqual({ action: 'list' });
        expect(parsed.content).toBe('');
    });

    it('parses parenthesized calls with strict-JSON argument bodies', () => {
        const raw = '<|tool_call>call:activate_tools({"module": "@core/shell"})<tool_call|>';
        const parsed = parseGemmaDiffusionOutput(raw);
        expect(parsed.toolCalls).toHaveLength(1);
        expect(parsed.toolCalls[0]!.name).toBe('activate_tools');
        expect(JSON.parse(parsed.toolCalls[0]!.argumentsJson)).toEqual({ module: '@core/shell' });
    });

    it('parses multiple tool calls in one turn', () => {
        const raw =
            '<|tool_call>call:get_weather{city:<|"|>Paris<|"|>}<tool_call|>' +
            '<|tool_call>call:get_weather{city:<|"|>London<|"|>}<tool_call|>';
        const parsed = parseGemmaDiffusionOutput(raw);
        expect(parsed.toolCalls.map(t => JSON.parse(t.argumentsJson)['city'])).toEqual(['Paris', 'London']);
    });

    it('strips residual control tokens from text', () => {
        const parsed = parseGemmaDiffusionOutput('Hello there.<turn|>');
        expect(parsed.content).toBe('Hello there.');
    });

    it('strips stray unbalanced channel markers (live run 1 sample)', () => {
        const raw =
            '<|channel>thought\nThe current weather is 18C.<channel|>' +
            '<channel|>The weather in Paris is currently 18°C and partly cloudy.';
        const parsed = parseGemmaDiffusionOutput(raw);
        expect(parsed.content).toBe('The weather in Paris is currently 18°C and partly cloudy.');
        expect(parsed.reasoning).toBe('The current weather is 18C.');
    });
});
