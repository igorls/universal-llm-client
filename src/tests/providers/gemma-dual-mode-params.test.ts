/**
 * Gemma dual-mode request params (reasoning ON vs OFF) for OpenAI-compat / vLLM.
 *
 * Pins enable_thinking + Google sampling + mild repetition_penalty so both
 * modes work without freestyle "thought"×N degeneration.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
    OpenAICompatibleClient,
    applyGemmaDualModeRequestDefaults,
    isGemmaModelId,
} from '../../providers/openai.js';
import type { LLMClientOptions } from '../../interfaces.js';
import { AIModelApiType } from '../../interfaces.js';

const VLLM_URL = 'http://localhost:8010/v1';

function createClient(overrides?: Partial<LLMClientOptions>): OpenAICompatibleClient {
    return new OpenAICompatibleClient({
        model: 'gemma-4-26b-a4b-nvfp4',
        url: VLLM_URL,
        apiType: AIModelApiType.OpenAI,
        ...overrides,
    });
}

describe('isGemmaModelId', () => {
    test('matches common served ids', () => {
        expect(isGemmaModelId('gemma-4-26b-a4b-nvfp4')).toBe(true);
        expect(isGemmaModelId('gemma4:26b-a4b-it-qat')).toBe(true);
        expect(isGemmaModelId('google/gemma-4-31B-it')).toBe(true);
        expect(isGemmaModelId('minimax-m3')).toBe(false);
    });
});

describe('applyGemmaDualModeRequestDefaults', () => {
    test('reasoning OFF: pins enable_thinking false + stronger repetition_penalty', () => {
        const body: Record<string, unknown> = {};
        applyGemmaDualModeRequestDefaults({
            model: 'gemma-4-26b-a4b-nvfp4',
            url: VLLM_URL,
            body,
            thinking: { enabled: false },
        });
        expect(body['temperature']).toBe(1.0);
        expect(body['top_p']).toBe(0.95);
        expect(body['top_k']).toBe(64);
        expect(body['repetition_penalty']).toBe(1.1);
        expect((body['chat_template_kwargs'] as { enable_thinking: boolean }).enable_thinking).toBe(false);
    });

    test('reasoning ON: pins enable_thinking true + gentler repetition_penalty', () => {
        const body: Record<string, unknown> = {};
        applyGemmaDualModeRequestDefaults({
            model: 'gemma-4-26b-a4b-nvfp4',
            url: VLLM_URL,
            body,
            thinking: { enabled: true, level: 'medium' },
        });
        expect(body['temperature']).toBe(1.0);
        expect(body['repetition_penalty']).toBe(1.05);
        expect((body['chat_template_kwargs'] as { enable_thinking: boolean }).enable_thinking).toBe(true);
    });

    test('unset thinking defaults to enable_thinking false (safe pin)', () => {
        const body: Record<string, unknown> = {};
        applyGemmaDualModeRequestDefaults({
            model: 'gemma-4-26b-a4b-nvfp4',
            url: VLLM_URL,
            body,
        });
        expect((body['chat_template_kwargs'] as { enable_thinking: boolean }).enable_thinking).toBe(false);
        expect(body['repetition_penalty']).toBe(1.1);
    });

    test('does not overwrite caller-supplied sampling or enable_thinking', () => {
        const body: Record<string, unknown> = {
            temperature: 0.2,
            top_p: 0.5,
            top_k: 10,
            repetition_penalty: 1.5,
            chat_template_kwargs: { enable_thinking: true, other: 1 },
        };
        applyGemmaDualModeRequestDefaults({
            model: 'gemma-4-26b-a4b-nvfp4',
            url: VLLM_URL,
            body,
            thinking: { enabled: false },
        });
        expect(body['temperature']).toBe(0.2);
        expect(body['top_p']).toBe(0.5);
        expect(body['top_k']).toBe(10);
        expect(body['repetition_penalty']).toBe(1.5);
        expect(body['chat_template_kwargs']).toEqual({ enable_thinking: true, other: 1 });
    });

    test('skips Cerebras (reasoning_effort path)', () => {
        const body: Record<string, unknown> = {};
        applyGemmaDualModeRequestDefaults({
            model: 'gemma-4-31b',
            url: 'https://api.cerebras.ai/v1',
            body,
            thinking: { enabled: true },
        });
        expect(body['chat_template_kwargs']).toBeUndefined();
        expect(body['temperature']).toBeUndefined();
    });

    test('no-ops for non-Gemma models', () => {
        const body: Record<string, unknown> = {};
        applyGemmaDualModeRequestDefaults({
            model: 'qwen3',
            url: VLLM_URL,
            body,
            thinking: { enabled: true },
        });
        expect(body['chat_template_kwargs']).toBeUndefined();
    });
});

describe('OpenAICompatibleClient gemma dual-mode wire body', () => {
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

    test('gemma + thinking unset → enable_thinking false on the wire', async () => {
        const client = createClient();
        await client.chat([{ role: 'user', content: 'hi' }]);
        expect(lastBody).not.toBeNull();
        expect(lastBody!['__resolvedThinking']).toBeUndefined();
        expect((lastBody!['chat_template_kwargs'] as { enable_thinking: boolean }).enable_thinking).toBe(false);
        expect(lastBody!['temperature']).toBe(1.0);
        expect(lastBody!['repetition_penalty']).toBe(1.1);
    });

    test('gemma + thinking true → enable_thinking true on the wire', async () => {
        const client = createClient({ thinking: true });
        await client.chat([{ role: 'user', content: 'hi' }]);
        expect((lastBody!['chat_template_kwargs'] as { enable_thinking: boolean }).enable_thinking).toBe(true);
        expect(lastBody!['repetition_penalty']).toBe(1.05);
    });

    test('gemma + per-call thinking false overrides client thinking true', async () => {
        const client = createClient({ thinking: true });
        await client.chat([{ role: 'user', content: 'hi' }], { thinking: false });
        expect((lastBody!['chat_template_kwargs'] as { enable_thinking: boolean }).enable_thinking).toBe(false);
        expect(lastBody!['repetition_penalty']).toBe(1.1);
    });

    test('non-gemma still omits chat_template_kwargs when thinking unset', async () => {
        const client = createClient({ model: 'minimax-m3' });
        await client.chat([{ role: 'user', content: 'hi' }]);
        expect(lastBody!['chat_template_kwargs']).toBeUndefined();
        expect(lastBody!['repetition_penalty']).toBeUndefined();
    });
});
