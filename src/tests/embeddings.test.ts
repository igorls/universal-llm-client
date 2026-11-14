/**
 * Embeddings: prompt formats, `embedMany()` batching and truncation, and the
 * request each protocol sends.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
    EMBEDDING_PROMPT_FORMATS,
    formatEmbeddingInput,
    normalizeEmbedding,
    resolveEmbeddingPromptFormat,
    truncateEmbedding,
} from '../embeddings.js';
import { OllamaClient } from '../providers/ollama.js';
import { OpenAICompatibleClient } from '../providers/openai.js';
import { GoogleClient } from '../providers/google.js';
import { AIModelApiType, type LLMClientOptions } from '../interfaces.js';
import { AIModel } from '../ai-model.js';

interface Captured {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
}

let originalFetch: typeof globalThis.fetch;
let calls: Captured[];

/** Replace fetch with a handler that sees each request's URL and JSON body. */
function serve(handler: (call: Captured) => Response | Promise<Response>): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const call = {
            url: String(input),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        };
        calls.push(call);
        return handler(call);
    }) as typeof fetch;
}

const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

/** One distinct vector per input, so order can be checked. */
const vectorsFor = (count: number, size = 4) =>
    Array.from({ length: count }, (_, index) => Array.from({ length: size }, (_, d) => (d === 0 ? index + 1 : 0.5)));

function options(apiType: AIModelApiType, overrides: Partial<LLMClientOptions> = {}): LLMClientOptions {
    return { model: 'embed-model', url: 'http://embed.test', apiType, ...overrides };
}

beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('prompt formats', () => {
    const gemma = EMBEDDING_PROMPT_FORMATS.embeddinggemma;

    test('a query and a document take their own templates', () => {
        expect(formatEmbeddingInput({ text: 'how to cancel' }, 'query', gemma)).toBe(
            'task: search result | query: how to cancel',
        );
        expect(formatEmbeddingInput({ text: 'Open Plan.', title: 'Billing' }, 'document', gemma)).toBe(
            'title: Billing | text: Open Plan.',
        );
    });

    test('a document without a title uses the format placeholder', () => {
        expect(formatEmbeddingInput({ text: 'Open Plan.' }, 'document', gemma)).toBe('title: none | text: Open Plan.');
    });

    test('no task, or a task the format has no template for, sends the text unchanged', () => {
        expect(formatEmbeddingInput({ text: 'raw' }, undefined, gemma)).toBe('raw');
        expect(formatEmbeddingInput({ text: 'raw' }, 'document', EMBEDDING_PROMPT_FORMATS.mxbai)).toBe('raw');
    });

    test('placeholders are replaced in one pass', () => {
        expect(formatEmbeddingInput({ text: 'a {title} b', title: '{text}' }, 'document', gemma)).toBe(
            'title: {text} | text: a {title} b',
        );
    });

    test('unknown format names throw', () => {
        expect(() => resolveEmbeddingPromptFormat('no-such-format')).toThrow(/Unknown embedding prompt format/);
        expect(resolveEmbeddingPromptFormat(undefined).id).toBe('none');
    });
});

describe('vector helpers', () => {
    test('truncation keeps the leading values and re-normalizes', () => {
        const cut = truncateEmbedding([3, 4, 12], 2);
        expect(cut).toHaveLength(2);
        expect(cut[0]).toBeCloseTo(0.6);
        expect(cut[1]).toBeCloseTo(0.8);
    });

    test('a vector at or below the size, and a zero vector, are unchanged', () => {
        expect(truncateEmbedding([1, 2], 4)).toEqual([1, 2]);
        expect(normalizeEmbedding([0, 0])).toEqual([0, 0]);
    });
});

describe('Ollama /api/embed', () => {
    test('embedMany sends one batch with the formatted inputs and reports the result', async () => {
        serve(call =>
            json({
                model: 'embed-model:latest',
                embeddings: vectorsFor((call.body.input as string[]).length),
                prompt_eval_count: 12,
            }),
        );
        const client = new OllamaClient(options(AIModelApiType.Ollama, { embeddingPromptFormat: 'embeddinggemma' }));

        const result = await client.embedMany(['one', 'two'], { task: 'query', dimensions: 4, keepAlive: -1 });

        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('http://embed.test/api/embed');
        expect(calls[0]!.body).toEqual({
            model: 'embed-model',
            input: ['task: search result | query: one', 'task: search result | query: two'],
            dimensions: 4,
            keep_alive: -1,
        });
        expect(result.embeddings.map(vector => vector[0])).toEqual([1, 2]);
        expect(result).toMatchObject({
            model: 'embed-model:latest',
            dimensions: 4,
            promptFormat: 'embeddinggemma',
            task: 'query',
            inputTokens: 12,
        });
    });

    test('without a task, inputs go as plain text even with a client format', async () => {
        serve(() => json({ embeddings: vectorsFor(1) }));
        const client = new OllamaClient(options(AIModelApiType.Ollama, { embeddingPromptFormat: 'embeddinggemma' }));

        const result = await client.embedMany(['plain']);

        expect(calls[0]!.body.input).toBe('plain');
        expect(result.promptFormat).toBe('none');
    });

    test('inputs are split into batches and come back in order', async () => {
        serve(call => {
            const input = ([] as string[]).concat(call.body.input as string | string[]);
            return json({ embeddings: input.map(text => [Number(text), 1]) });
        });
        const client = new OllamaClient(options(AIModelApiType.Ollama));

        const result = await client.embedMany(['1', '2', '3', '4', '5'], { batchSize: 2 });

        expect(calls.map(call => call.body.input)).toEqual([['1', '2'], ['3', '4'], '5']);
        expect(result.embeddings.map(vector => vector[0])).toEqual([1, 2, 3, 4, 5]);
    });

    test('a longer vector than asked for is cut and re-normalized', async () => {
        serve(() => json({ embeddings: [[3, 4, 12, 0]] }));
        const client = new OllamaClient(options(AIModelApiType.Ollama));

        const result = await client.embedMany(['x'], { dimensions: 2 });

        expect(result.dimensions).toBe(2);
        expect(result.embeddings[0]![0]).toBeCloseTo(0.6);
    });

    test('a context overflow is retried once with shorter inputs', async () => {
        const long = 'x'.repeat(1000);
        serve(call =>
            (call.body.input as string).length > 700
                ? json({ error: 'the input length exceeds the context length' }, 400)
                : json({ embeddings: vectorsFor(1) }),
        );
        const client = new OllamaClient(options(AIModelApiType.Ollama));

        await client.embedMany([long]);

        expect(calls).toHaveLength(2);
        expect((calls[1]!.body.input as string).length).toBe(650);
    });

    test('a server without /api/embed falls back to /api/embeddings per input', async () => {
        serve(call => {
            if (call.url.endsWith('/api/embed')) return new Response('404 page not found', { status: 404 });
            if (call.url.endsWith('/api/show')) return json({ capabilities: ['embedding'] });
            return json({ embedding: [Number(call.body.prompt === 'b') + 1, 0] });
        });
        const client = new OllamaClient(options(AIModelApiType.Ollama));

        const vectors = await client.embedArray(['a', 'b']);

        expect(vectors.map(vector => vector[0])).toEqual([1, 2]);
        expect(calls.filter(call => call.url.endsWith('/api/embeddings'))).toHaveLength(2);
    });

    test('a 404 for a missing model is not mistaken for an old server', async () => {
        serve(call =>
            call.url.endsWith('/api/show')
                ? json({ error: 'model not found' }, 404)
                : json({ error: 'model "embed-model" not found' }, 404),
        );
        const client = new OllamaClient(options(AIModelApiType.Ollama));

        await expect(client.embed('a')).rejects.toThrow(/404/);
        expect(calls.some(call => call.url.endsWith('/api/embeddings'))).toBe(false);
    });

    test('a vector count that does not match the inputs fails the call', async () => {
        serve(() => json({ embeddings: vectorsFor(1) }));
        const client = new OllamaClient(options(AIModelApiType.Ollama));

        await expect(client.embedMany(['a', 'b'])).rejects.toThrow(/1 vectors for 2 inputs/);
    });
});

describe('OpenAI-compatible /embeddings', () => {
    test('one request for the batch, vectors put back in input order by index', async () => {
        serve(() =>
            json({
                model: 'served-name',
                data: [
                    { index: 1, embedding: [2, 0] },
                    { index: 0, embedding: [1, 0] },
                ],
                usage: { prompt_tokens: 7 },
            }),
        );
        const client = new OpenAICompatibleClient(
            options(AIModelApiType.OpenAI, { url: 'http://embed.test/v1', embeddingPromptFormat: 'nomic' }),
        );

        const result = await client.embedMany([{ text: 'a' }, { text: 'b' }], { task: 'document', dimensions: 2 });

        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('http://embed.test/v1/embeddings');
        expect(calls[0]!.body).toEqual({
            model: 'embed-model',
            input: ['search_document: a', 'search_document: b'],
            encoding_format: 'float',
            dimensions: 2,
        });
        expect(result.embeddings).toEqual([
            [1, 0],
            [2, 0],
        ]);
        expect(result).toMatchObject({ model: 'served-name', promptFormat: 'nomic', inputTokens: 7 });
    });

    test('a single input goes as a string and dimensions are left out unless asked', async () => {
        serve(() => json({ data: [{ embedding: [1, 2, 3] }] }));
        const client = new OpenAICompatibleClient(options(AIModelApiType.OpenAI, { url: 'http://embed.test/v1' }));

        expect(await client.embed('solo')).toEqual([1, 2, 3]);
        expect(calls[0]!.body).toEqual({ model: 'embed-model', input: 'solo', encoding_format: 'float' });
    });

    test('embedArray is one request, not one per text', async () => {
        serve(call => json({ data: (call.body.input as string[]).map((_, index) => ({ index, embedding: [index] })) }));
        const client = new OpenAICompatibleClient(options(AIModelApiType.OpenAI, { url: 'http://embed.test/v1' }));

        expect(await client.embedArray(['a', 'b', 'c'])).toEqual([[0], [1], [2]]);
        expect(calls).toHaveLength(1);
    });

    test('a response missing a vector fails the call', async () => {
        serve(() => json({ data: [{ index: 0, embedding: [1] }] }));
        const client = new OpenAICompatibleClient(options(AIModelApiType.OpenAI, { url: 'http://embed.test/v1' }));

        await expect(client.embedArray(['a', 'b'])).rejects.toThrow(/missing vectors/);
    });
});

describe('AIModel.embedMany', () => {
    test('a provider prompt format reaches the client, and the router fails over', async () => {
        serve(call =>
            call.url.startsWith('http://down.test')
                ? new Response('unavailable', { status: 503 })
                : json({ embeddings: vectorsFor(1) }),
        );
        const model = new AIModel({
            model: 'embed-model',
            retries: 0,
            providers: [
                { type: 'ollama', url: 'http://down.test', embeddingPromptFormat: 'nomic' },
                { type: 'ollama', url: 'http://embed.test', embeddingPromptFormat: 'nomic' },
            ],
        });

        const result = await model.embedMany(['find me'], { task: 'query' });

        const served = calls.filter(call => call.url === 'http://embed.test/api/embed');
        expect(served[0]!.body.input).toBe('search_query: find me');
        expect(result.promptFormat).toBe('nomic');
    });
});

describe('Gemini batchEmbedContents', () => {
    test('the task goes as taskType, with the title and outputDimensionality, and no prompt format', async () => {
        serve(() => json({ embeddings: [{ values: [1, 0] }, { values: [0, 1] }] }));
        const client = new GoogleClient(
            options(AIModelApiType.Google, { apiKey: 'test-key', embeddingPromptFormat: 'embeddinggemma' }),
        );

        const result = await client.embedMany([{ text: 'doc one', title: 'Billing' }, 'doc two'], {
            task: 'document',
            dimensions: 2,
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toEndWith('/models/embed-model:batchEmbedContents');
        expect(calls[0]!.headers['x-goog-api-key']).toBe('test-key');
        expect(calls[0]!.body).toEqual({
            requests: [
                {
                    model: 'models/embed-model',
                    content: { parts: [{ text: 'doc one' }] },
                    taskType: 'RETRIEVAL_DOCUMENT',
                    title: 'Billing',
                    outputDimensionality: 2,
                },
                {
                    model: 'models/embed-model',
                    content: { parts: [{ text: 'doc two' }] },
                    taskType: 'RETRIEVAL_DOCUMENT',
                    outputDimensionality: 2,
                },
            ],
        });
        expect(result.promptFormat).toBe('none');
        expect(result.embeddings).toHaveLength(2);
    });

    test('a query carries no title', async () => {
        serve(() => json({ embeddings: [{ values: [1] }] }));
        const client = new GoogleClient(options(AIModelApiType.Google, { apiKey: 'test-key' }));

        await client.embedMany([{ text: 'q', title: 'ignored' }], { task: 'query' });

        const request = (calls[0]!.body.requests as Array<Record<string, unknown>>)[0]!;
        expect(request.taskType).toBe('RETRIEVAL_QUERY');
        expect(request.title).toBeUndefined();
    });
});
