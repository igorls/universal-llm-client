/**
 * Qwen3 / 3.8 request defaults for OpenAI-compat / vLLM.
 *
 * Pins enable_thinking + official sampling so visitor turns don't inherit
 * the thinking-checkpoint default (CoT on) or Gemma's 1.0 / 0.95 recipe.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
    OpenAICompatibleClient,
    applyQwenRequestDefaults,
    isQwen3ModelId,
    isQwen36PlusModelId,
} from '../../providers/openai.js';
import type { LLMClientOptions } from '../../interfaces.js';
import { AIModelApiType } from '../../interfaces.js';

const VLLM_URL = 'http://localhost:8015/v1';

function createClient(overrides?: Partial<LLMClientOptions>): OpenAICompatibleClient {
    return new OpenAICompatibleClient({
        model: 'qwen3.8-27b-nvfp4',
        url: VLLM_URL,
        apiType: AIModelApiType.OpenAI,
        ...overrides,
    });
}

describe('isQwen3ModelId / isQwen36PlusModelId', () => {
    test('matches served ids', () => {
        expect(isQwen3ModelId('qwen3.8-27b-nvfp4')).toBe(true);
        expect(isQwen3ModelId('Qwen/Qwen3-32B')).toBe(true);
        expect(isQwen3ModelId('qwen3:4b')).toBe(true);
        expect(isQwen3ModelId('gemma-4-26b-a4b-nvfp4')).toBe(false);
        expect(isQwen36PlusModelId('qwen3.8-27b-nvfp4')).toBe(true);
        expect(isQwen36PlusModelId('qwen3.6-nvfp4')).toBe(true);
        expect(isQwen36PlusModelId('qwen3.5:cloud')).toBe(true);
        expect(isQwen36PlusModelId('qwen3:4b')).toBe(false);
        expect(isQwen36PlusModelId('Qwen/Qwen3-32B')).toBe(false);
    });
});

describe('applyQwenRequestDefaults', () => {
    test('thinking OFF (3.8): official instruct recipe + enable_thinking false', () => {
        const body: Record<string, unknown> = {};
        applyQwenRequestDefaults({
            model: 'qwen3.8-27b-nvfp4',
            url: VLLM_URL,
            body,
            thinking: { enabled: false },
        });
        expect(body['temperature']).toBe(0.7);
        expect(body['top_p']).toBe(0.8);
        expect(body['top_k']).toBe(20);
        expect(body['presence_penalty']).toBe(1.5);
        expect((body['chat_template_kwargs'] as { enable_thinking: boolean }).enable_thinking).toBe(false);
    });

    test('thinking ON (3.8): official 3.6+ thinking recipe', () => {
        const body: Record<string, unknown> = {};
        applyQwenRequestDefaults({
            model: 'qwen3.8-27b-nvfp4',
            url: VLLM_URL,
            body,
            thinking: { enabled: true },
        });
        expect(body['temperature']).toBe(1.0);
        expect(body['top_p']).toBe(0.95);
        expect(body['top_k']).toBe(20);
        expect(body['presence_penalty']).toBe(0);
        expect((body['chat_template_kwargs'] as { enable_thinking: boolean }).enable_thinking).toBe(true);
    });

    test('thinking ON (original Qwen3): temp 0.6', () => {
        const body: Record<string, unknown> = {};
        applyQwenRequestDefaults({
            model: 'qwen3:4b',
            url: VLLM_URL,
            body,
            thinking: { enabled: true },
        });
        expect(body['temperature']).toBe(0.6);
        expect(body['top_p']).toBe(0.95);
        expect(body['presence_penalty']).toBeUndefined();
    });

    test('unset thinking defaults to enable_thinking false + instruct recipe', () => {
        const body: Record<string, unknown> = {};
        applyQwenRequestDefaults({
            model: 'qwen3.8-27b-nvfp4',
            url: VLLM_URL,
            body,
        });
        expect((body['chat_template_kwargs'] as { enable_thinking: boolean }).enable_thinking).toBe(false);
        expect(body['temperature']).toBe(0.7);
        expect(body['presence_penalty']).toBe(1.5);
    });

    test('does not overwrite caller-supplied sampling or enable_thinking', () => {
        const body: Record<string, unknown> = {
            temperature: 0.2,
            top_p: 0.5,
            top_k: 10,
            presence_penalty: 0.1,
            chat_template_kwargs: { enable_thinking: true, other: 1 },
        };
        applyQwenRequestDefaults({
            model: 'qwen3.8-27b-nvfp4',
            url: VLLM_URL,
            body,
            thinking: { enabled: false },
        });
        expect(body['temperature']).toBe(0.2);
        expect(body['top_p']).toBe(0.5);
        expect(body['top_k']).toBe(10);
        expect(body['presence_penalty']).toBe(0.1);
        expect(body['chat_template_kwargs']).toEqual({ enable_thinking: true, other: 1 });
    });

    test('no-ops for non-Qwen models', () => {
        const body: Record<string, unknown> = {};
        applyQwenRequestDefaults({
            model: 'gemma-4-26b-a4b-nvfp4',
            url: VLLM_URL,
            body,
            thinking: { enabled: true },
        });
        expect(body['chat_template_kwargs']).toBeUndefined();
        expect(body['temperature']).toBeUndefined();
    });
});

describe('OpenAICompatibleClient qwen3.8 wire body', () => {
    let originalFetch: typeof globalThis.fetch;
    let lastBody: Record<string, unknown> | null = null;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        lastBody = null;
        globalThis.fetch = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
            if (init?.body && typeof init.body === 'string') {
                lastBody = JSON.parse(init.body) as Record<string, unknown>;
            }
            return new Response(
                JSON.stringify({
                    id: 'x',
                    object: 'chat.completion',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }) as unknown as typeof globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('qwen3.8 + thinking unset → instruct recipe + enable_thinking false', async () => {
        const client = createClient();
        await client.chat([{ role: 'user', content: 'hi' }]);
        expect(lastBody).not.toBeNull();
        expect((lastBody!['chat_template_kwargs'] as { enable_thinking: boolean }).enable_thinking).toBe(false);
        expect(lastBody!['temperature']).toBe(0.7);
        expect(lastBody!['top_p']).toBe(0.8);
        expect(lastBody!['presence_penalty']).toBe(1.5);
    });

    test('qwen3.8 + thinking true → 3.6+ thinking recipe', async () => {
        const client = createClient({ thinking: true });
        await client.chat([{ role: 'user', content: 'hi' }]);
        expect((lastBody!['chat_template_kwargs'] as { enable_thinking: boolean }).enable_thinking).toBe(true);
        expect(lastBody!['temperature']).toBe(1.0);
        expect(lastBody!['top_p']).toBe(0.95);
    });

    test('caller defaultParameters win over family defaults', async () => {
        const client = createClient({
            defaultParameters: { temperature: 0.4, top_p: 0.9, presence_penalty: 0.2 },
        });
        await client.chat([{ role: 'user', content: 'hi' }]);
        expect(lastBody!['temperature']).toBe(0.4);
        expect(lastBody!['top_p']).toBe(0.9);
        expect(lastBody!['presence_penalty']).toBe(0.2);
    });
});
