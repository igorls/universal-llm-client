/**
 * Non-stream chat must split Gemma thought channels out of content when the
 * server has no --reasoning-parser (content embeds <|channel>thought…).
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OpenAICompatibleClient } from '../../providers/openai.js';
import { AIModelApiType } from '../../interfaces.js';

describe('OpenAICompatibleClient gemma thought channel split (non-stream)', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function mockCompletion(content: string): void {
        globalThis.fetch = mock(async () => {
            return new Response(
                JSON.stringify({
                    id: 'x',
                    object: 'chat.completion',
                    choices: [
                        {
                            index: 0,
                            message: { role: 'assistant', content },
                            finish_reason: 'stop',
                        },
                    ],
                    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }) as unknown as typeof globalThis.fetch;
    }

    test('splits closed thought channel into reasoning + clean content', async () => {
        mockCompletion('<|channel>thought\nNeed the digits.\n<channel|>4827');
        const client = new OpenAICompatibleClient({
            model: 'gemma-4-26b-a4b-nvfp4',
            url: 'http://localhost:8010/v1',
            apiType: AIModelApiType.OpenAI,
            thinking: true,
        });
        const res = await client.chat([{ role: 'user', content: 'hi' }]);
        expect(res.message.content).toBe('4827');
        expect(res.reasoning).toContain('Need the digits');
        expect(String(res.message.content)).not.toContain('<|channel');
    });

    test('moves unclosed truncated thought out of user-visible content', async () => {
        mockCompletion("<|channel>thought\nThe user is asking what you see here");
        const client = new OpenAICompatibleClient({
            model: 'gemma-4-26b-a4b-nvfp4',
            url: 'http://localhost:8010/v1',
            apiType: AIModelApiType.OpenAI,
            thinking: true,
        });
        const res = await client.chat([{ role: 'user', content: 'hi' }]);
        expect(String(res.message.content)).not.toContain('<|channel');
        expect(res.reasoning ?? '').toContain('what you see');
    });

    test('empty thought channel leaves the answer only', async () => {
        mockCompletion('<|channel>thought\n<channel|>323');
        const client = new OpenAICompatibleClient({
            model: 'gemma-4-26b-a4b-nvfp4',
            url: 'http://localhost:8010/v1',
            apiType: AIModelApiType.OpenAI,
        });
        const res = await client.chat([{ role: 'user', content: 'hi' }]);
        expect(res.message.content).toBe('323');
    });
});
