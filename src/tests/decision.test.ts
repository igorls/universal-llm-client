/**
 * Decisions (the System One protocol): request shape per protocol, answer
 * validation, failover across tiers and the context-limit rule.
 *
 * Every test runs against a fetch double; no model is contacted, so these
 * prove the contract, not any model's accuracy.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { AIModel } from '../ai-model.js';
import { classifyFailure, LLMHttpError } from '../errors.js';
import {
    DecisionContextLimitError,
    DecisionResponseError,
    DecisionUnsupportedError,
    isDecisionContextLimit,
    parseDecisionResponse,
} from '../decision.js';

const QUESTIONS = {
    team: {
        type: 'choice',
        instructions: 'Which team should handle this ticket?',
        criteria: { billing: 'Payments and refunds', technical: 'Bugs and integrations', other: null },
    },
    refund: { type: 'noul', instructions: 'Does the customer explicitly ask for a refund?' },
    urgency: { type: 'score', instructions: 'How urgent is this ticket?', criteria: ['Routine', 'Soon', 'Urgent'] },
} as const;

const TEAM = {
    type: 'choice',
    choice: 'billing',
    confidence: 0.9,
    probabilities: { billing: 0.9, technical: 0.06, other: 0.04 },
} as const;
const URGENCY = {
    type: 'score',
    score: 1.5,
    confidence: 0.4,
    legend: { 0: 'Routine', 1: 'Soon', 2: 'Urgent' },
    probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 },
} as const;

function body(overrides: Record<string, unknown> = {}, model = 'decider') {
    return {
        model,
        answers: { team: TEAM, refund: { type: 'noul', noul: 0.97 }, urgency: URGENCY, ...overrides },
        usage: { input_tokens: 250, output_tokens: 0 },
    };
}

interface Call {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

/**
 * Replies per host for `/systemone`. A number is that HTTP status with an
 * empty body; a `Response` is sent as is; anything else is a JSON 200. Every
 * other path (the router's liveness probe) gets an empty JSON object.
 */
function hosts(replies: Record<string, unknown>): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes('/systemone')) return Response.json({});
        calls.push({
            url,
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: JSON.parse(String(init?.body)),
        });
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        const reply = replies[new URL(url).host];
        if (typeof reply === 'number') return new Response('', { status: reply });
        if (reply instanceof Response) return reply.clone();
        return Response.json(reply);
    }) as typeof fetch;
    return calls;
}

function model(providers: ConstructorParameters<typeof AIModel>[0]['providers']): AIModel {
    return new AIModel({ model: 'decider', retries: 0, providers });
}

describe('request shape', () => {
    test('the Ollama protocol posts to /v1/systemone with the protocol fields only', async () => {
        const calls = hosts({ 'ollama.test:11434': body() });
        const ai = new AIModel({
            model: 'decider:9b',
            retries: 0,
            defaultParameters: { keep_alive: '10m' },
            providers: [{ type: 'ollama', url: 'http://ollama.test:11434/' }],
        });
        await ai.decide({ ticket: 'I was charged twice.' }, QUESTIONS, {
            images: ['aGVsbG8='],
            extraBody: { temperature: 2 },
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('http://ollama.test:11434/v1/systemone');
        expect(calls[0]!.body).toEqual({
            model: 'decider:9b',
            state: { ticket: 'I was charged twice.' },
            questions: QUESTIONS,
            images: ['aGVsbG8='],
            keep_alive: '10m',
        });
    });

    test('the OpenAI-compatible protocol posts beside its other routes, with auth and extra fields', async () => {
        const calls = hosts({ 'server.test': body() });
        const ai = model([{ type: 'openai', url: 'http://server.test', apiKey: 'k' }]);
        await ai.decide('I was charged twice.', QUESTIONS, {
            model: 'other',
            extraBody: { temperature: 2, model: 'ignored', state: 'ignored' },
        });
        expect(calls[0]!.url).toBe('http://server.test/v1/systemone');
        expect(calls[0]!.headers['authorization']).toBe('Bearer k');
        expect(calls[0]!.body).toEqual({
            temperature: 2,
            model: 'other',
            state: 'I was charged twice.',
            questions: QUESTIONS,
        });
    });

    test.each([
        ['no question', {}],
        ['a choice without options', { q: { type: 'choice', instructions: '?', criteria: {} } }],
        ['a score without levels', { q: { type: 'score', instructions: '?', criteria: [] } }],
        [
            'more levels than the protocol allows',
            { q: { type: 'score', instructions: '?', criteria: Array.from({ length: 11 }, (_, i) => `L${i}`) } },
        ],
    ])('%s is rejected before anything is sent', async (_name, questions) => {
        const calls = hosts({ 'server.test': body() });
        const ai = model([{ type: 'openai', url: 'http://server.test' }]);
        await expect(ai.decide('state', questions as never)).rejects.toThrow(/needs (1 to|at least)/);
        expect(calls).toHaveLength(0);
    });
});

describe('answers', () => {
    test('each question type keeps its own answer shape, model, endpoint and usage', async () => {
        hosts({ 'server.test': body() });
        const result = await model([{ type: 'openai', url: 'http://server.test' }]).decide('state', QUESTIONS);
        expect(result.answers.team).toEqual({
            type: 'choice',
            choice: 'billing',
            confidence: 0.9,
            probabilities: { billing: 0.9, technical: 0.06, other: 0.04 },
        });
        expect(result.answers.refund).toBe(0.97);
        expect(result.answers.urgency).toEqual({
            type: 'score',
            score: 1.5,
            confidence: 0.4,
            probabilities: [0.1, 0.3, 0.6],
        });
        expect(result.model).toBe('decider');
        expect(result.url).toBe('http://server.test/v1');
        expect(result.usage).toEqual({ inputTokens: 250, details: { input_tokens: 250, output_tokens: 0 } });
        // Compile-time contract: only the declared option ids exist.
        const winner: 'billing' | 'technical' | 'other' = result.answers.team.choice;
        const yes: number = result.answers.refund;
        expect([winner, yes]).toEqual(['billing', 0.97]);
        // @ts-expect-error not a declared option
        void result.answers.team.probabilities.sales;
    });

    test('a response without model or usage reports null and no usage', () => {
        const result = parseDecisionResponse(
            { refund: QUESTIONS.refund },
            { answers: { refund: { noul: 0.5 } } },
            'http://server.test',
        );
        expect(result.model).toBeNull();
        expect(Object.hasOwn(result, 'usage')).toBe(false);
    });

    test('Ollama probabilities rounded to four decimals are renormalised; elsewhere they are rejected', async () => {
        const rounded = { ...TEAM, probabilities: { billing: 0.6667, technical: 0.3333, other: 0.0001 } };
        hosts({ 'ollama.test:11434': body({ team: rounded }), 'server.test': body({ team: rounded }) });
        const viaOllama = await model([{ type: 'ollama', url: 'http://ollama.test:11434' }]).decide('s', QUESTIONS);
        const { probabilities } = viaOllama.answers.team;
        expect(probabilities.billing + probabilities.technical + probabilities.other).toBeCloseTo(1, 12);
        expect(probabilities.billing).toBeCloseTo(0.6667 / 1.0001, 12);
        await expect(
            model([{ type: 'openai', url: 'http://server.test' }]).decide('s', QUESTIONS),
        ).rejects.toBeInstanceOf(DecisionResponseError);
    });

    test.each([
        ['a missing answer', { team: undefined }],
        ['the wrong type', { team: { ...TEAM, type: 'noul' } }],
        ['a winner outside the options', { team: { ...TEAM, choice: 'sales' } }],
        ['a winner that is not the maximum', { team: { ...TEAM, choice: 'technical' } }],
        ['a missing option', { team: { ...TEAM, probabilities: { billing: 0.9, technical: 0.1 } } }],
        ['an extra option', { team: { ...TEAM, probabilities: { ...TEAM.probabilities, sales: 0 } } }],
        ['a negative probability', { team: { ...TEAM, probabilities: { billing: 1, technical: 0.1, other: -0.1 } } }],
        ['a distribution that does not sum to one', { team: { ...TEAM, probabilities: { billing: 0.6, technical: 0.3, other: 0.3 } } }],
        ['a confidence above one', { team: { ...TEAM, confidence: 1.1 } }],
        ['a yes/no answer that is not a probability', { refund: { type: 'noul', noul: 1.2 } }],
        ['a score outside its levels', { urgency: { ...URGENCY, score: 2.5 } }],
        ['a score with a missing level', { urgency: { ...URGENCY, probabilities: { 0: 0.4, 1: 0.6 } } }],
    ])('%s rejects the whole response', async (_name, overrides) => {
        hosts({ 'ollama.test:11434': body(overrides), 'server.test': body(overrides) });
        for (const provider of [
            { type: 'ollama', url: 'http://ollama.test:11434' },
            { type: 'openai', url: 'http://server.test' },
        ] as const) {
            await expect(model([provider]).decide('s', QUESTIONS)).rejects.toBeInstanceOf(DecisionResponseError);
        }
    });

    test('a malformed answer names the type of the question it belonged to', async () => {
        const kinds: string[] = [];
        for (const overrides of [
            { team: { ...TEAM, choice: 'sales' } },
            { urgency: { ...URGENCY, score: 9 } },
            { refund: { type: 'noul' } },
        ]) {
            hosts({ 'server.test': body(overrides) });
            const failure = await model([{ type: 'openai', url: 'http://server.test' }])
                .decide('s', QUESTIONS)
                .catch(error => error);
            kinds.push((failure as DecisionResponseError).answer);
        }
        expect(kinds).toEqual(['choice', 'score', 'noul']);
    });

    test('a call can bring its own transport', async () => {
        const calls = hosts({});
        const seen: string[] = [];
        const result = await model([{ type: 'openai', url: 'http://server.test' }]).decide('s', QUESTIONS, {
            fetch: (async (input: string | URL | Request) => {
                seen.push(String(input));
                return Response.json(body());
            }) as typeof fetch,
        });
        expect(result.answers.refund).toBe(0.97);
        expect(seen).toEqual(['http://server.test/v1/systemone']);
        expect(calls).toHaveLength(0);
    });

    test('a tie is returned as the server sent it', async () => {
        const tie = { ...TEAM, confidence: 0.25, probabilities: { billing: 0.5, technical: 0.5, other: 0 } };
        hosts({ 'server.test': body({ team: tie }) });
        const result = await model([{ type: 'openai', url: 'http://server.test' }]).decide('s', QUESTIONS);
        expect(result.answers.team.choice).toBe('billing');
        expect(result.answers.team.probabilities.technical).toBe(0.5);
    });
});

describe('failover', () => {
    const TIERS = [
        { type: 'openai', url: 'http://primary.test', priority: 0 },
        { type: 'ollama', url: 'http://standby.test:11434', model: 'small:9b', priority: 1 },
    ] as const;

    test('a lower tier is not asked while the tier above answers', async () => {
        const calls = hosts({ 'primary.test': body(), 'standby.test:11434': body({}, 'small:9b') });
        const ai = model([...TIERS]);
        for (let i = 0; i < 3; i++) expect((await ai.decide('s', QUESTIONS)).url).toBe('http://primary.test/v1');
        expect(calls.map(call => new URL(call.url).host)).toEqual(['primary.test', 'primary.test', 'primary.test']);
    });

    test('the lower tier answers an outage, with its own model, and the result says which endpoint it was', async () => {
        const calls = hosts({ 'primary.test': 503, 'standby.test:11434': body({}, 'small:9b') });
        const result = await model([...TIERS]).decide('s', QUESTIONS, { extraBody: { temperature: 2 } });
        expect(result.url).toBe('http://standby.test:11434');
        expect(result.model).toBe('small:9b');
        expect(calls.map(call => call.body['model'])).toEqual(['decider', 'small:9b']);
        expect(Object.hasOwn(calls[1]!.body, 'temperature')).toBe(false);
    });

    test('an invalid answer moves to the next provider and leaves the first one healthy', async () => {
        hosts({ 'primary.test': body({ team: { ...TEAM, choice: 'sales' } }), 'standby.test:11434': body() });
        const ai = model([...TIERS]);
        expect((await ai.decide('s', QUESTIONS)).url).toBe('http://standby.test:11434');
        expect(ai.getProviderStatus().map(status => status.healthy)).toEqual([true, true]);
    });

    test('a provider whose protocol has no decision endpoint is passed over without a call', async () => {
        const calls = hosts({ 'server.test': body() });
        const ai = model([
            { type: 'anthropic', url: 'http://messages.test', apiKey: 'k', priority: 0 },
            { type: 'openai', url: 'http://server.test', priority: 1 },
        ]);
        expect((await ai.decide('s', QUESTIONS)).url).toBe('http://server.test/v1');
        expect(calls).toHaveLength(1);
        expect(ai.getProviderStatus()[0]!.healthy).toBe(true);
        await expect(
            model([{ type: 'anthropic', url: 'http://messages.test', apiKey: 'k' }]).decide('s', QUESTIONS),
        ).rejects.toBeInstanceOf(DecisionUnsupportedError);
    });

    test('an aborted call rejects without trying another provider', async () => {
        const calls = hosts({ 'primary.test': body(), 'standby.test:11434': body() });
        const controller = new AbortController();
        controller.abort();
        const ai = model([...TIERS]);
        await expect(ai.decide('s', QUESTIONS, { signal: controller.signal })).rejects.toThrow();
        expect(calls.length).toBeLessThanOrEqual(1);
        expect(ai.getProviderStatus().map(status => status.consecutiveFailures)).toEqual([0, 0]);
    });
});

describe('context limit', () => {
    const tooLarge = () =>
        Response.json({ detail: { error_type: 'max_tokens_exceeded' } }, { status: 400 });
    const PROVIDERS = [
        { type: 'openai', url: 'http://a.test', priority: 0 },
        { type: 'ollama', url: 'http://b.test:11434', priority: 1 },
    ] as const;

    test('a request one provider finds too large still goes to the next', async () => {
        const calls = hosts({ 'a.test': tooLarge(), 'b.test:11434': body() });
        expect((await model([...PROVIDERS]).decide('s', QUESTIONS)).url).toBe('http://b.test:11434');
        expect(calls).toHaveLength(2);
    });

    test('refused for size by every provider is the context-limit error', async () => {
        hosts({
            'a.test': tooLarge(),
            'b.test:11434': Response.json(
                { error: 'request (11683 tokens) exceeds the available context size (8448 tokens), try increasing it' },
                { status: 400 },
            ),
        });
        const ai = model([...PROVIDERS]);
        // More refusals than the consecutive-failure threshold: a run of long documents.
        for (let i = 0; i < 4; i++) {
            await expect(ai.decide('s', QUESTIONS)).rejects.toBeInstanceOf(DecisionContextLimitError);
        }
        expect(ai.getProviderStatus().map(status => [status.healthy, status.consecutiveFailures])).toEqual([
            [true, 0],
            [true, 0],
        ]);
    });

    test('an outage among the refusals is reported as the outage, whatever the order', async () => {
        for (const replies of [
            { 'a.test': tooLarge(), 'b.test:11434': 503 },
            { 'a.test': 503, 'b.test:11434': tooLarge() },
        ]) {
            hosts(replies);
            const failure = await model([...PROVIDERS]).decide('s', QUESTIONS).catch(error => error);
            expect(failure).toBeInstanceOf(LLMHttpError);
            expect(failure).not.toBeInstanceOf(DecisionContextLimitError);
            expect((failure as LLMHttpError).status).toBe(503);
        }
    });

    test.each([
        [413, '', true],
        [400, '{"detail":{"error_type":"max_tokens_exceeded"}}', true],
        [400, '{"error":{"type":"max_tokens_exceeded","message":"too long"}}', true],
        [400, '{"error":"request (9000 tokens) exceeds the available context size (8448 tokens)"}', true],
        [400, '{"error":"the question and its options (791 tokens) are too large to process"}', false],
        [400, '{"error":"model does not support decisions"}', false],
        [400, 'not json', false],
        [500, '{"detail":{"error_type":"max_tokens_exceeded"}}', false],
    ])('HTTP %i %s → context limit: %p', (status, payload, expected) => {
        expect(isDecisionContextLimit(new LLMHttpError(status, payload))).toBe(expected);
    });
});

describe('failure disposition', () => {
    test('an error that states its disposition is classified by it', () => {
        expect(classifyFailure(new DecisionResponseError('bad'))).toEqual({ retry: false, cooldown: false });
        expect(classifyFailure(new DecisionUnsupportedError('anthropic'))).toEqual({
            retry: false,
            cooldown: false,
            blameless: true,
        });
        expect(classifyFailure(new DecisionContextLimitError(413, ''))).toEqual({
            retry: false,
            cooldown: false,
            blameless: true,
        });
        expect(classifyFailure(Object.assign(new Error('x'), { failover: { retry: true, cooldown: true } }))).toEqual({
            retry: true,
            cooldown: true,
        });
        // A malformed statement is ignored: the historical classification applies.
        expect(classifyFailure(Object.assign(new Error('x'), { failover: { retry: 'yes' } }))).toEqual({
            retry: true,
            cooldown: false,
        });
    });
});
