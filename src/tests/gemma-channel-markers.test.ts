/**
 * Leaked gemma channel-marker stripping — the live incident showed
 * `<|channel|>' think'` rendered verbatim at the head of the Canvas
 * thinking display.
 */

import { describe, test, expect } from 'bun:test';
import { stripGemmaChannelMarkers, extractGemmaThoughtChannels } from '../gemma-channel.js';

describe('stripGemmaChannelMarkers', () => {
    test('strips the exact observed leak variant', () => {
        const text = "<|channel|>' think'\nYou're absolutely right. Writing a single-file script is fine.";
        const cleaned = stripGemmaChannelMarkers(text);
        expect(cleaned).not.toContain('<|channel');
        expect(cleaned).toContain("You're absolutely right");
    });

    test('strips canonical and bare markers', () => {
        expect(stripGemmaChannelMarkers('<|channel>thought\nplan here')).toBe('plan here');
        expect(stripGemmaChannelMarkers('body\n<|channel|>\n')).toBe('body\n');
        expect(stripGemmaChannelMarkers('<channel|>\ntail')).toBe('tail');
    });

    test('leaves ordinary prose about channels untouched', () => {
        const text = 'The Telegram channel forwards updates.\nUse channel_send for that.';
        expect(stripGemmaChannelMarkers(text)).toBe(text);
    });

    test('leaves code snippets with pipes untouched', () => {
        const text = 'const x = a | b;\nif (x > 0) return;';
        expect(stripGemmaChannelMarkers(text)).toBe(text);
    });
});

describe('extractGemmaThoughtChannels lenient opener', () => {
    test("matches the quoted `' think'` variant in a full block", () => {
        const input = "<|channel|>' think'\ninner reasoning here\n<channel|>final answer";
        const result = extractGemmaThoughtChannels(input);
        expect(result.found).toBe(true);
        expect(result.reasoning).toContain('inner reasoning here');
        expect(result.content).toContain('final answer');
        expect(result.content).not.toContain('<|channel');
    });
});
