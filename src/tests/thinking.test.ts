/**
 * Unit tests for the unified thinking resolver and per-provider budget maps.
 */
import { describe, test, expect } from 'bun:test';
import {
    resolveThinking,
    isOpenAIReasoningModel,
    isOllamaEndpoint,
    ollamaThinkValue,
    geminiThinkingBudget,
    anthropicThinkingBudget,
} from '../thinking.js';

describe('resolveThinking', () => {
    test('returns undefined when neither per-call nor config is set', () => {
        expect(resolveThinking(undefined, undefined)).toBeUndefined();
    });

    test('boolean true/false map to enabled', () => {
        expect(resolveThinking(undefined, true)).toEqual({ enabled: true });
        expect(resolveThinking(undefined, false)).toEqual({ enabled: false });
    });

    test('a level enables thinking and carries the level', () => {
        expect(resolveThinking('high', undefined)).toEqual({ enabled: true, level: 'high' });
        expect(resolveThinking(undefined, 'low')).toEqual({ enabled: true, level: 'low' });
    });

    test('per-call overrides config', () => {
        expect(resolveThinking(false, true)).toEqual({ enabled: false });
        expect(resolveThinking('medium', false)).toEqual({ enabled: true, level: 'medium' });
    });

    test('ignores unknown strings defensively', () => {
        expect(resolveThinking('ultra' as never, undefined)).toBeUndefined();
    });
});

describe('isOpenAIReasoningModel', () => {
    test('matches o-series and gpt-5 families', () => {
        for (const m of ['o1', 'o3', 'o4-mini', 'gpt-5', 'gpt-5-mini', 'GPT-5']) {
            expect(isOpenAIReasoningModel(m)).toBe(true);
        }
    });
    test('does not match chat / vLLM model names', () => {
        for (const m of ['gpt-4o', 'qwen3.6-nvfp4', 'gemini-3.5-flash', 'claude-sonnet-4-5']) {
            expect(isOpenAIReasoningModel(m)).toBe(false);
        }
    });
});

describe('isOllamaEndpoint', () => {
    test('matches local listeners and ollama.com', () => {
        expect(isOllamaEndpoint('http://z690-ex-glacial-win:11434')).toBe(true);
        expect(isOllamaEndpoint('http://127.0.0.1:11434/v1')).toBe(true);
        expect(isOllamaEndpoint('https://ollama.com')).toBe(true);
        expect(isOllamaEndpoint('http://localhost:8010/v1')).toBe(false);
        expect(isOllamaEndpoint(undefined)).toBe(false);
    });
});

describe('ollamaThinkValue', () => {
    test('unset defaults to true (historical Ollama default)', () => {
        expect(ollamaThinkValue(undefined)).toBe(true);
    });
    test('maps unified levels onto Ollama-legal think values', () => {
        expect(ollamaThinkValue({ enabled: false })).toBe(false);
        expect(ollamaThinkValue({ enabled: true })).toBe(true);
        expect(ollamaThinkValue({ enabled: true, level: 'minimal' })).toBe('low');
        expect(ollamaThinkValue({ enabled: true, level: 'low' })).toBe('low');
        expect(ollamaThinkValue({ enabled: true, level: 'medium' })).toBe('medium');
        expect(ollamaThinkValue({ enabled: true, level: 'high' })).toBe('high');
        expect(ollamaThinkValue({ enabled: true, level: 'xhigh' })).toBe(true);
    });
});

describe('budget maps', () => {
    test('gemini 2.5 budget by level (0/-1 semantics)', () => {
        expect(geminiThinkingBudget('minimal')).toBe(512);
        expect(geminiThinkingBudget('low')).toBe(2048);
        expect(geminiThinkingBudget('medium')).toBe(8192);
        expect(geminiThinkingBudget('high')).toBe(24576);
        expect(geminiThinkingBudget(undefined)).toBe(-1); // dynamic
    });

    test('anthropic budget stays >= 1024 and < max_tokens', () => {
        expect(anthropicThinkingBudget('high', 32000)).toBe(16384);
        expect(anthropicThinkingBudget('high', 4096)).toBe(3072); // clamped to max-1024
        expect(anthropicThinkingBudget(undefined, 4096)).toBe(2048); // bare true
        expect(anthropicThinkingBudget('low', 4096)).toBe(1024);
    });
});
