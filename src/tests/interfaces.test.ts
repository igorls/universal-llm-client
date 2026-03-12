/**
 * Tests for interfaces.ts — Helper functions and type utilities
 */
import { describe, it, expect } from 'bun:test';
import {
    textContent,
    imageContent,
    multimodalMessage,
    extractTextContent,
    hasImages,
    AIModelApiType,
    AIModelType,
} from '../interfaces.js';

describe('Helper Functions', () => {
    describe('textContent', () => {
        it('creates a text content part', () => {
            const result = textContent('Hello');
            expect(result).toEqual({ type: 'text', text: 'Hello' });
        });
    });

    describe('imageContent', () => {
        it('creates an image content part from base64', () => {
            const result = imageContent('abc123');
            expect(result.type).toBe('image_url');
            expect(result.image_url.url).toBe('data:image/jpeg;base64,abc123');
        });

        it('creates an image content part from URL', () => {
            const result = imageContent('https://example.com/image.jpg');
            expect(result.image_url.url).toBe('https://example.com/image.jpg');
        });

        it('creates an image content part from data URI', () => {
            const result = imageContent('data:image/png;base64,abc');
            expect(result.image_url.url).toBe('data:image/png;base64,abc');
        });

        it('respects custom mimeType', () => {
            const result = imageContent('abc123', 'image/png');
            expect(result.image_url.url).toBe('data:image/png;base64,abc123');
        });

        it('includes detail parameter', () => {
            const result = imageContent('https://example.com/img.jpg', 'image/jpeg', 'low');
            expect(result.image_url.detail).toBe('low');
        });
    });

    describe('multimodalMessage', () => {
        it('creates a user message with text and images', () => {
            const msg = multimodalMessage('Describe this', ['base64img']);
            expect(msg.role).toBe('user');
            expect(Array.isArray(msg.content)).toBe(true);
            const parts = msg.content as Array<{ type: string }>;
            expect(parts).toHaveLength(2);
            expect(parts[0]!.type).toBe('text');
            expect(parts[1]!.type).toBe('image_url');
        });

        it('handles multiple images', () => {
            const msg = multimodalMessage('Compare', ['img1', 'img2', 'img3']);
            const parts = msg.content as Array<{ type: string }>;
            expect(parts).toHaveLength(4); // 1 text + 3 images
        });
    });

    describe('extractTextContent', () => {
        it('extracts text from string content', () => {
            expect(extractTextContent('Hello')).toBe('Hello');
        });

        it('extracts text from content parts array', () => {
            const content = [
                textContent('Hello'),
                imageContent('img'),
                textContent(' World'),
            ];
            expect(extractTextContent(content)).toBe('Hello World');
        });

        it('returns empty string from image-only content', () => {
            const content = [imageContent('img')];
            expect(extractTextContent(content)).toBe('');
        });
    });

    describe('hasImages', () => {
        it('returns false for string content', () => {
            expect(hasImages('Hello')).toBe(false);
        });

        it('returns false for text-only content parts', () => {
            expect(hasImages([textContent('Hello')])).toBe(false);
        });

        it('returns true for content with images', () => {
            expect(hasImages([textContent('Hello'), imageContent('img')])).toBe(true);
        });
    });
});

describe('Enums', () => {
    it('AIModelApiType has expected values', () => {
        expect(AIModelApiType.Ollama).toBe('ollama');
        expect(AIModelApiType.OpenAI).toBe('openai');
        expect(AIModelApiType.Google).toBe('google');
        expect(AIModelApiType.Vertex).toBe('vertex');
        expect(AIModelApiType.LlamaCpp).toBe('llamacpp');
    });

    it('AIModelType has expected values', () => {
        expect(AIModelType.Chat).toBe('chat');
        expect(AIModelType.Embedding).toBe('embedding');
    });
});
