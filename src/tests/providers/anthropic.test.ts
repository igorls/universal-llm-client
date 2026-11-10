/**
 * Anthropic Provider — unified thinking flag, model info and model listing.
 *
 * Validates that the model-level `thinking` config and per-call
 * `ChatOptions.thinking` map to the shape the model card lists: adaptive
 * thinking with `output_config.effort`, or else extended thinking
 * (`thinking: { type: 'enabled', budget_tokens }`), with the API's
 * constraints handled (budget < max_tokens; temperature omitted when on).
 * `false` sends the card's off switch. A `temperature` the model rejects is
 * dropped, the request sent again, and left out of later requests. Signed
 * thinking goes back in front of its tool call in tool loops, with
 * `drop_block` and the beta header.
 *
 * Model info is declared, read from the endpoint's model card, or assumed,
 * never read from the model name, and a failed listing rejects instead of
 * returning made-up ids.
 */

import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { AnthropicClient } from '../../providers/anthropic.js';
import type { LLMChatMessage, LLMChatResponse, LLMClientOptions } from '../../interfaces.js';
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

    test('the card is looked up once per model, and not at all when thinking is unset', async () => {
        const server = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive'], ALL_EFFORTS) });
        const client = createClient();
        await chat(client, { thinking: true });
        await chat(client, { thinking: 'high' });
        await chat(client, { thinking: false });
        expect(server.cardRequests()).toHaveLength(1);

        const quiet = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive'], ALL_EFFORTS) });
        await chat(createClient(), { temperature: 0.5 });
        expect(quiet.cardRequests()).toEqual([]);
        expect(quiet.messageBody()['thinking']).toBeUndefined();
        expect(quiet.messageBody()['temperature']).toBe(0.5);
    });

    test('thinking: false sends disabled where the card lists it, and keeps temperature', async () => {
        const server = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive', 'disabled'], ALL_EFFORTS) });
        await chat(createClient({ thinking: true }), { thinking: false, temperature: 0.5 });
        const body = server.messageBody();
        expect(body['thinking']).toEqual({ type: 'disabled' });
        expect(body['temperature']).toBe(0.5);
        expect(body['output_config']).toBeUndefined();
    });

    test('thinking: false sends between_tools where the card lists only that', async () => {
        const server = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive', 'between_tools'], ALL_EFFORTS) });
        await chat(createClient(), { thinking: false });
        expect(server.messageBody()['thinking']).toEqual({ type: 'between_tools' });
    });

    test('thinking: false sends nothing to a model that always thinks', async () => {
        const server = serveThinking({ [MODEL]: thinkingModelCard(MODEL, ['adaptive'], ALL_EFFORTS) });
        await chat(createClient(), { thinking: false });
        expect(server.messageBody()['thinking']).toBeUndefined();
    });

    test('thinking: false sends nothing without a card', async () => {
        const server = serveThinking({});
        await chat(createClient(), { thinking: false });
        expect(server.messageBody()['thinking']).toBeUndefined();
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

/** The API's answers for a temperature, verbatim. */
const TEMPERATURE_DEPRECATED = { type: 'error', error: { type: 'invalid_request_error', message: '`temperature` is deprecated for this model.' } };
const TEMPERATURE_OUT_OF_RANGE = { type: 'error', error: { type: 'invalid_request_error', message: 'temperature: range: 0..1' } };

/**
 * Serve `POST /v1/messages`: a request to one of `rejecting` that carries
 * `temperature` gets `rejection` (HTTP 400); anything else succeeds (SSE when
 * it asks to stream). Returns the bodies of the message requests, in order.
 */
function serveTemperature(rejecting: string[], rejection: unknown = TEMPERATURE_DEPRECATED) {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string) as Record<string, unknown>;
        bodies.push(body);
        if (rejecting.includes(body['model'] as string) && body['temperature'] !== undefined) {
            return new Response(JSON.stringify(rejection), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        if (body['stream']) {
            return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
            });
        }
        return new Response(JSON.stringify(ANTHROPIC_RESPONSE), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    return bodies;
}

describe('AnthropicClient temperature a model rejects', () => {
    let originalFetch: typeof globalThis.fetch;
    let warn: ReturnType<typeof spyOn>;
    beforeEach(() => {
        originalFetch = globalThis.fetch;
        warn = spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        warn.mockRestore();
    });

    const MODEL = 'claude-sonnet-4-5';
    const hi = [{ role: 'user' as const, content: 'hi' }];

    test('is dropped and the request sent again, then left out of later requests', async () => {
        const bodies = serveTemperature([MODEL]);
        const client = createClient();

        const first = await client.chat(hi, { temperature: 0.5 });
        expect(first.message.content).toBe('Hi there.');
        expect(bodies.map((b) => b['temperature'])).toEqual([0.5, undefined]);

        await client.chat(hi, { temperature: 0.5 });
        expect(bodies).toHaveLength(3);
        expect(bodies[2]!['temperature']).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    test('an out-of-range value is not retried', async () => {
        const bodies = serveTemperature([MODEL], TEMPERATURE_OUT_OF_RANGE);
        await expect(createClient().chat(hi, { temperature: 1.5 })).rejects.toThrow('range');
        expect(bodies).toHaveLength(1);
        expect(warn).not.toHaveBeenCalled();
    });

    test('other models keep their temperature', async () => {
        const bodies = serveTemperature([MODEL]);
        const client = createClient();
        await client.chat(hi, { temperature: 0.5 });
        await client.chat(hi, { model: 'model-b', temperature: 0.5 });
        expect(bodies.at(-1)).toMatchObject({ model: 'model-b', temperature: 0.5 });
    });

    test('streaming drops it and streams again', async () => {
        const bodies = serveTemperature([MODEL]);
        const client = createClient();
        for await (const _event of client.chatStream(hi, { temperature: 0.5 })) { /* drain */ }
        expect(bodies.map((b) => b['temperature'])).toEqual([0.5, undefined]);
        expect(bodies.every((b) => b['stream'] === true)).toBe(true);

        for await (const _event of client.chatStream(hi, { temperature: 0.5 })) { /* drain */ }
        expect(bodies).toHaveLength(3);
        expect(bodies[2]!['temperature']).toBeUndefined();
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

// ============================================================================
// Thinking replay in tool loops
// ============================================================================

/** A message response with these content blocks. */
function messageResponse(content: unknown[], stopReason = 'tool_use'): Record<string, unknown> {
    return { ...ANTHROPIC_RESPONSE, content, stop_reason: stopReason };
}

/** SSE for a streamed response with these content blocks. */
function sseResponse(content: Array<Record<string, unknown>>): string {
    const events: unknown[] = [{
        type: 'message_start',
        message: { id: 'msg_s', type: 'message', role: 'assistant', content: [], model: 'm', stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } },
    }];
    content.forEach((block, index) => {
        if (block['type'] === 'thinking') {
            events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
            events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block['thinking'] } });
            events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block['signature'] } });
        } else if (block['type'] === 'tool_use') {
            events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block['id'], name: block['name'], input: {} } });
            events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block['input']) } });
        } else {
            events.push({ type: 'content_block_start', index, content_block: block });
        }
        events.push({ type: 'content_block_stop', index });
    });
    events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } });
    events.push({ type: 'message_stop' });
    return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/**
 * Serve model cards (adaptive thinking for every id) and answer each
 * `POST /v1/messages` with the next scripted reply: a message body or an SSE
 * string. `reject` may answer a request with an HTTP 400 body instead.
 */
function serveScript(
    replies: unknown[],
    reject?: (body: Record<string, unknown>, headers: Record<string, string>) => unknown,
) {
    const requests: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const path = new URL(url).pathname;
        if (path.startsWith('/v1/models/')) {
            return json(thinkingModelCard(decodeURIComponent(path.slice('/v1/models/'.length)), ['adaptive'], ALL_EFFORTS));
        }
        const body = JSON.parse(init!.body as string) as Record<string, unknown>;
        const headers = init!.headers as Record<string, string>;
        requests.push({ body, headers });
        const rejection = reject?.(body, headers);
        if (rejection) return json(rejection, 400);
        const reply = replies.shift() ?? messageResponse([{ type: 'text', text: 'done' }], 'end_turn');
        if (typeof reply === 'string') {
            return new Response(reply, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return json(reply);
    }) as unknown as typeof fetch;
    return requests;
}

describe('AnthropicClient thinking replay in tool loops', () => {
    let originalFetch: typeof globalThis.fetch;
    let warn: ReturnType<typeof spyOn>;
    beforeEach(() => {
        originalFetch = globalThis.fetch;
        warn = spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        warn.mockRestore();
    });

    const THINKING = { type: 'thinking', thinking: 'I should multiply.', signature: 'sig-1' };
    const TOOL = { type: 'tool_use', id: 'toolu_1', name: 'multiply', input: { a: 2, b: 3 } };
    const user: LLMChatMessage = { role: 'user', content: 'What is 2*3?' };
    const toolResult: LLMChatMessage = { role: 'tool', content: '6', tool_call_id: 'toolu_1' };
    type SentMessages = Array<{ role: string; content: unknown[] }>;

    /** Ask, then send the tool result back with the assistant turn the client returned. */
    async function loop(client: AnthropicClient, options: Parameters<AnthropicClient['chat']>[1]) {
        const first = await client.chat([user], options);
        await client.chat([user, first.message, toolResult], options);
        return first;
    }

    test('sends the thinking back in front of its tool call, with drop_block and the beta header', async () => {
        const requests = serveScript([messageResponse([THINKING, { type: 'text', text: 'Let me check.' }, TOOL])]);
        await loop(createClient(), { thinking: true });

        const [first, second] = requests;
        expect(first!.headers['anthropic-beta']).toBeUndefined();
        expect((first!.body['thinking'] as Record<string, unknown>)['block_binding']).toBeUndefined();

        expect(second!.headers['anthropic-beta']).toBe('thinking-binding-controls-2026-08-01');
        expect(second!.body['thinking']).toEqual({
            type: 'adaptive',
            display: 'summarized',
            block_binding: { prefix_mismatch_behavior: 'drop_block' },
        });
        const messages = second!.body['messages'] as SentMessages;
        expect(messages[1]!.content).toEqual([THINKING, { type: 'text', text: 'Let me check.' }, TOOL]);
    });

    test('interleaved thinking goes back right before its own tool call', async () => {
        const later = { type: 'thinking', thinking: 'Now the next one.', signature: 'sig-2' };
        const tool2 = { type: 'tool_use', id: 'toolu_2', name: 'multiply', input: { a: 4, b: 5 } };
        const requests = serveScript([messageResponse([THINKING, TOOL, later, tool2])]);
        const client = createClient();
        const first = await client.chat([user], { thinking: true });
        await client.chat(
            [user, first.message, toolResult, { role: 'tool', content: '20', tool_call_id: 'toolu_2' }],
            { thinking: true },
        );

        const messages = requests[1]!.body['messages'] as SentMessages;
        expect(messages[1]!.content).toEqual([THINKING, TOOL, later, tool2]);
    });

    test('redacted thinking is sent back verbatim; unsigned thinking is not kept', async () => {
        const redacted = { type: 'redacted_thinking', data: 'opaque' };
        const unsigned = { type: 'thinking', thinking: 'no signature', signature: '' };
        const requests = serveScript([messageResponse([unsigned, redacted, TOOL])]);
        await loop(createClient(), { thinking: true });

        const messages = requests[1]!.body['messages'] as SentMessages;
        expect(messages[1]!.content).toEqual([redacted, TOOL]);
    });

    test('a caller that rebuilds history from its own log still gets the blocks', async () => {
        const requests = serveScript([messageResponse([THINKING, TOOL])]);
        const client = createClient();
        const first = await client.chat([user], { thinking: true });
        const rebuilt: LLMChatMessage = {
            role: 'assistant',
            content: '',
            tool_calls: first.message.tool_calls!.map((call) => ({ ...call, function: { ...call.function } })),
        };
        await client.chat([user, rebuilt, toolResult], { thinking: true });

        const messages = requests[1]!.body['messages'] as SentMessages;
        expect(messages[1]!.content).toEqual([THINKING, TOOL]);
    });

    test('nothing is sent back when the request does not turn thinking on', async () => {
        const requests = serveScript([messageResponse([THINKING, TOOL])]);
        const client = createClient();
        const first = await client.chat([user], { thinking: true });
        await client.chat([user, first.message, toolResult], {});
        await client.chat([user, first.message, toolResult], { thinking: false });

        for (const request of requests.slice(1)) {
            expect(request.headers['anthropic-beta']).toBeUndefined();
            expect((request.body['messages'] as SentMessages)[1]!.content).toEqual([TOOL]);
        }
    });

    test('the budget shape carries block_binding too', async () => {
        const requests = serveScript([messageResponse([THINKING, TOOL])]);
        const scripted = globalThis.fetch;
        globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            // No card: the client sends extended thinking with budget_tokens.
            if (new URL(url).pathname.startsWith('/v1/models/')) return new Response('{}', { status: 404 });
            return scripted(input, init);
        }) as unknown as typeof fetch;
        await loop(createClient(), { thinking: 'low', maxTokens: 4096 });

        expect(requests[1]!.body['thinking']).toEqual({
            type: 'enabled',
            budget_tokens: 1024,
            block_binding: { prefix_mismatch_behavior: 'drop_block' },
        });
    });

    test('an endpoint that rejects replay gets the request again without it, then no more replay', async () => {
        const requests = serveScript(
            [messageResponse([THINKING, TOOL])],
            (_body, headers) =>
                headers['anthropic-beta']
                    ? { type: 'error', error: { type: 'invalid_request_error', message: 'unknown field' } }
                    : undefined,
        );
        const client = createClient();
        await loop(client, { thinking: true });
        expect(requests).toHaveLength(3);
        expect(requests[1]!.headers['anthropic-beta']).toBeDefined();
        expect(requests[2]!.headers['anthropic-beta']).toBeUndefined();
        expect((requests[2]!.body['messages'] as SentMessages)[1]!.content).toEqual([TOOL]);
        expect(warn).toHaveBeenCalledTimes(1);

        const first = await client.chat([user], { thinking: true });
        await client.chat([user, first.message, toolResult], { thinking: true });
        expect(requests.slice(3).every((r) => r.headers['anthropic-beta'] === undefined)).toBe(true);
    });

    test('an error that recurs without replay is thrown, and replay stays on', async () => {
        let failing = true;
        const requests = serveScript(
            [messageResponse([THINKING, TOOL])],
            (body) =>
                failing && (body['messages'] as unknown[]).length > 1
                    ? { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } }
                    : undefined,
        );
        const client = createClient();
        const first = await client.chat([user], { thinking: true });
        await expect(client.chat([user, first.message, toolResult], { thinking: true })).rejects.toThrow('prompt is too long');
        expect(requests).toHaveLength(3);

        failing = false;
        await client.chat([user, first.message, toolResult], { thinking: true });
        expect(requests.at(-1)!.headers['anthropic-beta']).toBe('thinking-binding-controls-2026-08-01');
        expect(warn).not.toHaveBeenCalled();
    });

    test('thinking from a streamed response is kept for replay', async () => {
        const requests = serveScript([sseResponse([THINKING, TOOL])]);
        const client = createClient();
        const stream = client.chatStream([user], { thinking: true });
        let step = await stream.next();
        while (!step.done) step = await stream.next();
        const assistant = (step.value as LLMChatResponse).message;

        await client.chat([user, assistant, toolResult], { thinking: true });
        const messages = requests[1]!.body['messages'] as SentMessages;
        expect(messages[1]!.content).toEqual([THINKING, TOOL]);
    });

    test('chatWithTools sends the thinking back between iterations', async () => {
        const requests = serveScript([messageResponse([THINKING, TOOL])]);
        const client = createClient();
        client.registerTool(
            'multiply',
            'Multiply two integers.',
            { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] },
            async (args) => String((args as { a: number; b: number }).a * (args as { a: number; b: number }).b),
        );
        const response = await client.chatWithTools([user], { thinking: true });

        expect(response.message.content).toBe('done');
        const messages = requests[1]!.body['messages'] as SentMessages;
        expect(messages[1]!.content).toEqual([THINKING, TOOL]);
        expect(messages[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: '6' }]);
    });
});
