/**
 * Anthropic Provider — unified thinking flag, model info and model listing.
 *
 * Validates that the model-level `thinking` config and per-call
 * `ChatOptions.thinking` map to the shape the model card lists: adaptive
 * thinking with `output_config.effort`, or else extended thinking
 * (`thinking: { type: 'enabled', budget_tokens }`), with the API's
 * constraints handled (budget < max_tokens; temperature omitted when on).
 *
 * Model info is declared, read from the endpoint's model card, or assumed,
 * never read from the model name, and a failed listing rejects instead of
 * returning made-up ids.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { AnthropicClient } from '../../providers/anthropic.js';
import type { LLMClientOptions } from '../../interfaces.js';
import { AIModelApiType } from '../../interfaces.js';

function createClient(overrides?: Partial<LLMClientOptions>): AnthropicClient {
    return new AnthropicClient({
        model: 'claude-sonnet-4-5',
        apiKey: 'test-api-key',
        apiType: AIModelApiType.Anthropic,
        ...overrides,
    });
}

const ANTHROPIC_RESPONSE = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hi there.' }],
    model: 'claude-sonnet-4-5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 },
};

describe('AnthropicClient thinking flag', () => {
    // This mock answers the model card lookup with a message, a card that lists
    // no thinking types, so these cover the extended-thinking (budget) shape.
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    function mockFetchAndCapture(response: unknown = ANTHROPIC_RESPONSE, status = 200) {
        let capturedBody: Record<string, unknown> | null = null;
        globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
            if (init?.body) capturedBody = JSON.parse(init.body as string);
            return new Response(JSON.stringify(response), {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
        }) as typeof fetch;
        return () => capturedBody;
    }

    test('enables extended thinking when thinking:true (budget < max_tokens, temperature omitted)', async () => {
        const getBody = mockFetchAndCapture();
        const client = createClient();

        await client.chat([{ role: 'user', content: 'hi' }], { thinking: true, maxTokens: 4096, temperature: 0.7 });

        const body = getBody()!;
        const thinking = body['thinking'] as Record<string, unknown> | undefined;
        expect(thinking).toBeDefined();
        expect(thinking!['type']).toBe('enabled');
        expect(thinking!['budget_tokens']).toBe(2048);
        expect(thinking!['budget_tokens'] as number).toBeLessThan(body['max_tokens'] as number);
        // The API forbids a custom temperature while thinking is on — must be omitted.
        expect(body['temperature']).toBeUndefined();
    });

    test('does not request thinking when flag is unset (temperature preserved)', async () => {
        const getBody = mockFetchAndCapture();
        const client = createClient();

        await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0.5 });

        const body = getBody()!;
        expect(body['thinking']).toBeUndefined();
        expect(body['temperature']).toBe(0.5);
    });

    test('does not request thinking when thinking:false (overrides client config)', async () => {
        const getBody = mockFetchAndCapture();
        const client = createClient({ thinking: true });

        await client.chat([{ role: 'user', content: 'hi' }], { thinking: false });

        expect(getBody()!['thinking']).toBeUndefined();
    });

    test('per-call thinking:true overrides unset client config', async () => {
        const getBody = mockFetchAndCapture();
        const client = createClient();

        await client.chat([{ role: 'user', content: 'hi' }], { thinking: true });

        expect((getBody()!['thinking'] as Record<string, unknown>)['type']).toBe('enabled');
    });

    test('maps a thinking level to budget_tokens (high, clamped < max_tokens)', async () => {
        const getBody = mockFetchAndCapture();
        const client = createClient();

        await client.chat([{ role: 'user', content: 'hi' }], { thinking: 'high', maxTokens: 32000 });

        const thinking = getBody()!['thinking'] as Record<string, unknown>;
        expect(thinking['type']).toBe('enabled');
        expect(thinking['budget_tokens']).toBe(16384);
    });

    test('bumps max_tokens so budget_tokens stays below it when maxTokens is small', async () => {
        const getBody = mockFetchAndCapture();
        const client = createClient();

        await client.chat([{ role: 'user', content: 'hi' }], { thinking: 'low', maxTokens: 1024 });

        const body = getBody()!;
        const budget = (body['thinking'] as Record<string, unknown>)['budget_tokens'] as number;
        expect(budget).toBeGreaterThanOrEqual(1024);
        expect(budget).toBeLessThan(body['max_tokens'] as number);
    });
});

/** A card listing these thinking types and effort levels, as the API reports them. */
function thinkingModelCard(id: string, types: string[], efforts: string[] = []): Record<string, unknown> {
    const allTypes = ['enabled', 'adaptive', 'disabled', 'between_tools'];
    const allEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    return modelCard(id, {
        max_input_tokens: 1_000_000,
        capabilities: {
            thinking: {
                supported: true,
                types: Object.fromEntries(allTypes.map((t) => [t, { supported: types.includes(t) }])),
            },
            effort: {
                supported: efforts.length > 0,
                ...Object.fromEntries(allEfforts.map((e) => [e, { supported: efforts.includes(e) }])),
            },
        },
    });
}

const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Serve model cards and `POST /v1/messages` (a message, or SSE when the body
 * asks to stream). Records each request with its parsed body.
 */
function serveThinking(cards: Record<string, Record<string, unknown>>) {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
        calls.push({ url, body });
        const path = new URL(url).pathname;
        if (path === '/v1/messages') {
            if (body?.['stream']) {
                return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' },
                });
            }
            return respond(ANTHROPIC_RESPONSE);
        }
        const card = cards[decodeURIComponent(path.slice('/v1/models/'.length))];
        return card
            ? respond(card)
            : respond({ type: 'error', error: { type: 'not_found_error', message: 'model not found' } }, 404);
    }) as unknown as typeof fetch;
    return {
        messageBody: () => calls.filter((c) => c.body).at(-1)!.body!,
        cardRequests: () => calls.filter((c) => new URL(c.url).pathname.startsWith('/v1/models/')).map((c) => c.url),
    };
}

describe('AnthropicClient thinking shape from the model card', () => {
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    const MODEL = 'claude-sonnet-4-5';
    const chat = (client: AnthropicClient, options: Parameters<AnthropicClient['chat']>[1]) =>
        client.chat([{ role: 'user', content: 'hi' }], options);

    test('a model that takes only adaptive thinking gets it, with a summarized display', async () => {
        const server = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive'], ALL_EFFORTS) });
        await chat(createClient(), { thinking: true, temperature: 0.7 });
        const body = server.messageBody();
        expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
        // A bare `true` leaves the model's default effort.
        expect(body['output_config']).toBeUndefined();
        expect(body['temperature']).toBeUndefined();
    });

    test('a thinking level becomes output_config.effort', async () => {
        const client = createClient();
        for (const level of ['low', 'medium', 'high', 'xhigh'] as const) {
            const server = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive'], ALL_EFFORTS) });
            await chat(client, { thinking: level });
            expect(server.messageBody()['output_config']).toEqual({ effort: level });
        }
    });

    test('minimal asks for low effort', async () => {
        const server = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive'], ALL_EFFORTS) });
        await chat(createClient(), { thinking: 'minimal' });
        expect(server.messageBody()['output_config']).toEqual({ effort: 'low' });
    });

    test('adaptive is preferred when the model takes both shapes', async () => {
        const server = serveThinking({
            [MODEL]: thinkingModelCard(MODEL, ['enabled', 'adaptive', 'disabled'], ['low', 'medium', 'high', 'max']),
        });
        await chat(createClient(), { thinking: 'high' });
        const body = server.messageBody();
        expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(body['output_config']).toEqual({ effort: 'high' });
    });

    test('a level the model does not list falls to the nearest one, the lower on a tie', async () => {
        const server = serveThinking({
            [MODEL]: thinkingModelCard(MODEL, ['adaptive'], ['low', 'medium', 'high', 'max']),
        });
        await chat(createClient(), { thinking: 'xhigh' });
        expect(server.messageBody()['output_config']).toEqual({ effort: 'high' });
    });

    test('no effort is sent when the card lists none', async () => {
        const server = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive']) });
        await chat(createClient(), { thinking: 'high' });
        const body = server.messageBody();
        expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(body['output_config']).toBeUndefined();
    });

    test('a model without adaptive thinking keeps budget_tokens', async () => {
        const server = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['enabled', 'disabled'], ['low', 'medium', 'high']) });
        await chat(createClient(), { thinking: 'high', maxTokens: 32000 });
        const body = server.messageBody();
        expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 16384 });
        expect(body['output_config']).toBeUndefined();
    });

    test('without a card, extended thinking is sent as before', async () => {
        const server = serveThinking({});
        await chat(createClient(), { thinking: true });
        expect(server.messageBody()['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 });
    });

    test('adaptive thinking keeps the max_tokens headroom extended thinking had', async () => {
        const server = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive'], ALL_EFFORTS) });
        await chat(createClient(), { thinking: 'low', maxTokens: 1024 });
        expect(server.messageBody()['max_tokens']).toBe(2048);
    });

    test('the card is looked up once per model, and not at all without thinking', async () => {
        const server = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive'], ALL_EFFORTS) });
        const client = createClient();
        await chat(client, { thinking: true });
        await chat(client, { thinking: 'high' });
        expect(server.cardRequests()).toHaveLength(1);

        const quiet = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive'], ALL_EFFORTS) });
        const unset = createClient();
        await chat(unset, { temperature: 0.5 });
        await chat(createClient({ thinking: true }), { thinking: false, temperature: 0.5 });
        expect(quiet.cardRequests()).toEqual([]);
        expect(quiet.messageBody()['thinking']).toBeUndefined();
        expect(quiet.messageBody()['temperature']).toBe(0.5);
    });

    test('a per-call model uses that model\'s card', async () => {
        const server = serveThinking({
            [MODEL]: thinkingModelCard(MODEL, ['enabled', 'disabled']),
            'model-b': thinkingModelCard('model-b', ['adaptive'], ALL_EFFORTS),
        });
        await chat(createClient(), { model: 'model-b', thinking: true });
        expect(server.cardRequests()).toEqual(['https://api.anthropic.com/v1/models/model-b']);
        expect(server.messageBody()['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
    });

    test('model-level thinking config uses the card too', async () => {
        const server = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive'], ALL_EFFORTS) });
        await chat(createClient({ thinking: 'medium' }), {});
        expect(server.messageBody()['output_config']).toEqual({ effort: 'medium' });
    });

    test('streaming sends the same shape', async () => {
        const server = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive'], ALL_EFFORTS) });
        const stream = createClient().chatStream([{ role: 'user', content: 'hi' }], { thinking: 'high' });
        for await (const _event of stream) { /* drain */ }
        const body = server.messageBody();
        expect(body['stream']).toBe(true);
        expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(body['output_config']).toEqual({ effort: 'high' });
    });
});

/** A `/v1/models` card as the endpoint returns it. */
function modelCard(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z', ...extra };
}

/** The fields a current Anthropic card carries, trimmed to what matters here. */
const FULL_CARD = {
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: {
        image_input: { supported: true },
        thinking: { supported: true },
        structured_outputs: { supported: true },
    },
};

/**
 * Serve `GET /v1/models` (all cards) and `GET /v1/models/{id}` (one card, or
 * the API's 404 body). Returns the URLs requested, in order.
 */
function serveCards(cards: Record<string, Record<string, unknown>>): string[] {
    const urls: string[] = [];
    const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        urls.push(url);
        const path = new URL(url).pathname;
        if (path === '/v1/models') return respond({ data: Object.values(cards), has_more: false });
        const card = cards[decodeURIComponent(path.slice('/v1/models/'.length))];
        return card
            ? respond(card)
            : respond({ type: 'error', error: { type: 'not_found_error', message: 'model not found' } }, 404);
    }) as unknown as typeof fetch;
    return urls;
}

describe('AnthropicClient getModelInfo', () => {
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    test('reads the window and capabilities from the endpoint model card', async () => {
        const urls = serveCards({ 'claude-sonnet-4-5': modelCard('claude-sonnet-4-5', FULL_CARD) });
        const info = await createClient().getModelInfo();
        expect(info).toEqual({
            model: 'claude-sonnet-4-5',
            contextLength: 1_000_000,
            contextLengthSource: 'endpoint',
            capabilities: ['tools', 'vision', 'thinking'],
            capabilitiesSource: 'endpoint',
        });
        expect(urls).toEqual(['https://api.anthropic.com/v1/models/claude-sonnet-4-5']);
    });

    test('lists only what the card says the model supports', async () => {
        serveCards({
            'claude-sonnet-4-5': modelCard('claude-sonnet-4-5', {
                max_input_tokens: 200_000,
                capabilities: { image_input: { supported: false }, thinking: { supported: false } },
            }),
        });
        const info = await createClient().getModelInfo();
        expect(info.contextLength).toBe(200_000);
        expect(info.capabilities).toEqual(['tools']);
        expect(info.capabilitiesSource).toBe('endpoint');
    });

    test('a card without those fields leaves the assumed protocol values', async () => {
        serveCards({ 'model-id': modelCard('model-id') });
        const info = await createClient({ model: 'model-id' }).getModelInfo();
        expect(info).toEqual({
            model: 'model-id',
            contextLength: 200_000,
            contextLengthSource: 'assumed',
            capabilities: ['tools', 'vision'],
            capabilitiesSource: 'assumed',
        });
    });

    test('does not read the model name', async () => {
        serveCards({});
        const named = await createClient({ model: 'claude-opus-4-1' }).getModelInfo();
        const unnamed = await createClient({ model: 'model-id' }).getModelInfo();
        expect({ ...named, model: undefined }).toEqual({ ...unnamed, model: undefined });
        expect(named.capabilities).not.toContain('thinking');
        expect(named.contextLengthSource).toBe('assumed');
    });

    test('URL-encodes the model id', async () => {
        const urls = serveCards({ 'org/model:tag': modelCard('org/model:tag', FULL_CARD) });
        const info = await createClient({ model: 'org/model:tag' }).getModelInfo();
        expect(urls).toEqual(['https://api.anthropic.com/v1/models/org%2Fmodel%3Atag']);
        expect(info.contextLengthSource).toBe('endpoint');
    });

    test('asks for a card once', async () => {
        const urls = serveCards({ 'claude-sonnet-4-5': modelCard('claude-sonnet-4-5', FULL_CARD) });
        const client = createClient();
        await client.getModelInfo();
        await client.getModelInfo();
        expect(urls).toHaveLength(1);
    });

    test('uses the cards getModels() already fetched', async () => {
        const urls = serveCards({
            'claude-sonnet-4-5': modelCard('claude-sonnet-4-5', FULL_CARD),
            'claude-haiku-4-5': modelCard('claude-haiku-4-5', { max_input_tokens: 200_000 }),
        });
        const client = createClient();
        await client.getModels();
        expect((await client.getModelInfo()).contextLength).toBe(1_000_000);
        expect((await client.getModelInfo('claude-haiku-4-5')).contextLength).toBe(200_000);
        expect(urls).toEqual(['https://api.anthropic.com/v1/models']);
    });

    test('remembers a card the endpoint does not have', async () => {
        const urls = serveCards({});
        const client = createClient();
        expect((await client.getModelInfo()).contextLengthSource).toBe('assumed');
        await client.getModelInfo();
        expect(urls).toHaveLength(1);
    });

    test('a failed lookup reports the assumed values and is tried again', async () => {
        let calls = 0;
        globalThis.fetch = mock(async () => {
            calls++;
            throw new Error('connection refused');
        }) as unknown as typeof fetch;
        const client = createClient();
        const info = await client.getModelInfo();
        expect(info.contextLengthSource).toBe('assumed');
        expect(info.capabilitiesSource).toBe('assumed');
        const before = calls;
        await client.getModelInfo();
        expect(calls).toBeGreaterThan(before);
    });

    test('a declared contextLength wins over the card', async () => {
        serveCards({ 'claude-sonnet-4-5': modelCard('claude-sonnet-4-5', FULL_CARD) });
        const info = await createClient({ contextLength: 64_000 }).getModelInfo();
        expect(info.contextLength).toBe(64_000);
        expect(info.contextLengthSource).toBe('declared');
        expect(info.capabilities).toEqual(['tools', 'vision', 'thinking']);
        expect(info.capabilitiesSource).toBe('endpoint');
    });

    test('declared capabilities replace the card', async () => {
        serveCards({ 'claude-sonnet-4-5': modelCard('claude-sonnet-4-5', FULL_CARD) });
        const info = await createClient({ capabilities: ['tools'] }).getModelInfo();
        expect(info.capabilities).toEqual(['tools']);
        expect(info.capabilitiesSource).toBe('declared');
        expect(info.contextLength).toBe(1_000_000);
        expect(info.contextLengthSource).toBe('endpoint');
    });

    test('asks nothing when both values are declared', async () => {
        const urls = serveCards({ 'claude-sonnet-4-5': modelCard('claude-sonnet-4-5', FULL_CARD) });
        const info = await createClient({ contextLength: 64_000, capabilities: ['tools'] }).getModelInfo();
        expect(info).toMatchObject({
            contextLength: 64_000,
            contextLengthSource: 'declared',
            capabilities: ['tools'],
            capabilitiesSource: 'declared',
        });
        expect(urls).toEqual([]);
    });

    test('declared values do not describe another model', async () => {
        serveCards({ 'some-other-model': modelCard('some-other-model', FULL_CARD) });
        const client = createClient({ contextLength: 64_000, capabilities: ['tools'] });
        const info = await client.getModelInfo('some-other-model');
        expect(info).toMatchObject({
            model: 'some-other-model',
            contextLength: 1_000_000,
            contextLengthSource: 'endpoint',
            capabilities: ['tools', 'vision', 'thinking'],
            capabilitiesSource: 'endpoint',
        });
    });
});

describe('AnthropicClient getModels', () => {
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    test('returns the ids the endpoint lists', async () => {
        globalThis.fetch = mock(async () => new Response(JSON.stringify({
            data: [{ id: 'model-a', display_name: 'A', created_at: '2026-01-01', type: 'model' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

        expect(await createClient().getModels()).toEqual(['model-a']);
    });

    test('an HTTP error rejects instead of returning made-up ids', async () => {
        globalThis.fetch = mock(async () => new Response(
            JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
        )) as unknown as typeof fetch;

        await expect(createClient().getModels()).rejects.toThrow();
    });

    test('a network failure rejects', async () => {
        globalThis.fetch = mock(async () => {
            throw new Error('connection refused');
        }) as unknown as typeof fetch;

        await expect(createClient().getModels()).rejects.toThrow('connection refused');
    });
});
