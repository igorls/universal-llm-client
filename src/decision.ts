/**
 * Universal LLM Client — Decisions (the System One protocol)
 *
 * A decision model answers typed questions about a state in one forward pass
 * and returns probabilities instead of text. The wire protocol is
 * `POST /v1/systemone` with `{ model, state, questions }`; three question types
 * exist: `noul` (yes/no), `choice` (one of a closed set) and `score` (a graded
 * level). Acceptance thresholds and abstention belong to the caller: every
 * probability is relative to the options supplied, so even a state with no
 * evidence produces a winner.
 *
 * Zero dependencies — pure TypeScript.
 */

import { LLMHttpError, type FailureDisposition } from './errors.js';

// ============================================================================
// Questions
// ============================================================================

/** A yes/no question. `criteria` may say what yes and no look like. */
export interface DecisionNoulQuestion {
    readonly type: 'noul';
    readonly instructions: string;
    readonly criteria?: { readonly true: string; readonly false: string };
}

/** One of a closed set: option id → description (`null` lets the id describe itself). */
export interface DecisionChoiceQuestion {
    readonly type: 'choice';
    readonly instructions: string;
    readonly criteria: Readonly<Record<string, string | null>>;
}

/** A graded question: `criteria` describes each level, lowest first. */
export interface DecisionScoreQuestion {
    readonly type: 'score';
    readonly instructions: string;
    readonly criteria: readonly string[];
}

export type DecisionQuestion = DecisionNoulQuestion | DecisionChoiceQuestion | DecisionScoreQuestion;

/** Named questions, all asked about the same state in one request. */
export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>;

/** The state a decision is made about: text, or a JSON object or array. */
export type DecisionState = string | Readonly<Record<string, unknown>> | readonly unknown[];

// ============================================================================
// Answers
// ============================================================================

export interface DecisionChoiceAnswer<Option extends string = string> {
    readonly type: 'choice';
    /** The most probable option. A tie follows the order the options were declared in. */
    readonly choice: Option;
    /**
     * How concentrated the distribution is, 0 to 1, as the server reports it.
     * Servers compute it differently, and it is not the chance the answer is right.
     */
    readonly confidence: number;
    /** One probability per declared option; they sum to one. */
    readonly probabilities: Readonly<Record<Option, number>>;
}

export interface DecisionScoreAnswer {
    readonly type: 'score';
    /** Expected level index, from 0 to the last level; fractional. */
    readonly score: number;
    /** As for a choice: server-defined, 0 to 1. */
    readonly confidence: number;
    /** One probability per level, in the order the question declared them. */
    readonly probabilities: readonly number[];
}

/** A `noul` answers with P(yes); a `choice` and a `score` with their distribution. */
export type DecisionAnswer<Question extends DecisionQuestion> = Question extends DecisionChoiceQuestion
    ? DecisionChoiceAnswer<Extract<keyof Question['criteria'], string>>
    : Question extends DecisionScoreQuestion
        ? DecisionScoreAnswer
        : number;

export type DecisionAnswers<Questions extends DecisionQuestions> = {
    readonly [Id in keyof Questions]: DecisionAnswer<Questions[Id]>;
};

export interface DecisionUsage {
    readonly inputTokens: number;
    /** The server's usage block as sent, for fields beyond the protocol. */
    readonly details: Readonly<Record<string, unknown>>;
}

export interface DecisionResult<Questions extends DecisionQuestions = DecisionQuestions> {
    readonly answers: DecisionAnswers<Questions>;
    /** The model the answering server named; null when it named none. */
    readonly model: string | null;
    /** Base URL of the endpoint that answered. With several providers, this tells them apart. */
    readonly url: string;
    /** Absent when the server reported no usable usage block. */
    readonly usage?: DecisionUsage;
}

export interface DecideOptions {
    /** Base64 images (no data URLs), shared by every question. Vision decision models only. */
    readonly images?: readonly string[];
    /** Model for this call, instead of the configured one. */
    readonly model?: string;
    /** Per-call timeout in ms, instead of the configured one. */
    readonly timeout?: number;
    readonly signal?: AbortSignal;
    /** Affinity key: within a pool, keep hitting the same node (see `ChatOptions.sessionKey`). */
    readonly sessionKey?: string;
    /**
     * Request fields a server defines beyond the protocol, merged into the body.
     * Sent on the OpenAI-compatible protocol only; the Ollama protocol has none.
     */
    readonly extraBody?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * A decision failure that states its own failover disposition. None of these
 * mean the node is down, so none cools it down for other calls.
 */
export class DecisionError extends Error {
    /** Read by `classifyFailure`: move to the next provider without retrying this one. */
    readonly failover: FailureDisposition = { retry: false, cooldown: false };

    constructor(message: string) {
        super(message);
        this.name = 'DecisionError';
    }
}

/** The provider's protocol has no decision endpoint. */
export class DecisionUnsupportedError extends DecisionError {
    override readonly failover: FailureDisposition = { retry: false, cooldown: false, blameless: true };

    constructor(protocol: string) {
        super(`The ${protocol} protocol has no decision endpoint`);
        this.name = 'DecisionUnsupportedError';
    }
}

/** The server answered, but not with a valid answer to every question asked. */
export class DecisionResponseError extends DecisionError {
    constructor(message: string) {
        super(message);
        this.name = 'DecisionResponseError';
    }
}

/**
 * The server refused the request as larger than its context. Another provider
 * may have room, so the router still tries the rest; when every provider that
 * answered refused it for size, this is the error the caller gets.
 */
export class DecisionContextLimitError extends LLMHttpError {
    /** The node is fine; a run of long documents must not mark it unhealthy. */
    readonly failover: FailureDisposition = { retry: false, cooldown: false, blameless: true };

    constructor(status: number, body: string, url?: string) {
        super(status, body, url);
        this.name = 'DecisionContextLimitError';
    }
}

// ============================================================================
// Request validation
// ============================================================================

export const MAX_DECISION_QUESTIONS = 64;
export const MAX_DECISION_OPTIONS = 255;
export const MAX_DECISION_LEVELS = 10;

/** Reject a request no server accepts, before anything is sent. */
export function assertDecisionQuestions(questions: DecisionQuestions): void {
    const ids = Object.keys(questions);
    if (ids.length < 1 || ids.length > MAX_DECISION_QUESTIONS) {
        throw new Error(`A decision needs 1 to ${MAX_DECISION_QUESTIONS} questions`);
    }
    for (const id of ids) {
        const question = questions[id]!;
        if (question.type === 'choice') {
            const count = Object.keys(question.criteria).length;
            if (count < 1 || count > MAX_DECISION_OPTIONS) {
                throw new Error(`A choice needs 1 to ${MAX_DECISION_OPTIONS} options`);
            }
        }
        if (question.type === 'score') {
            const levels = question.criteria.length;
            if (levels < 1 || levels > MAX_DECISION_LEVELS) {
                throw new Error(`A score needs 1 to ${MAX_DECISION_LEVELS} levels`);
            }
        }
    }
}

// ============================================================================
// Response parsing
// ============================================================================

export interface ParseDecisionOptions {
    /**
     * Accept probabilities rounded to four decimals and renormalise them. Off,
     * a distribution must sum to one within 1e-6.
     */
    readonly roundedProbabilities?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Sum check; returns the divisor that makes the values sum to one, or null when they are not a distribution. */
function normaliser(values: readonly number[], rounded: boolean): number | null {
    const total = values.reduce((sum, value) => sum + value, 0);
    const allowed = rounded ? values.length * 5e-5 + 1e-6 : 1e-6;
    if (Math.abs(total - 1) > allowed) return null;
    return rounded ? total : 1;
}

function choiceAnswer(question: DecisionChoiceQuestion, answer: unknown, rounded: boolean): DecisionChoiceAnswer {
    const invalid = (): never => {
        throw new DecisionResponseError('The server returned an invalid choice answer');
    };
    if (!isRecord(answer) || answer['type'] !== 'choice') return invalid();
    const choice = answer['choice'];
    const confidence = answer['confidence'];
    const probabilities = answer['probabilities'];
    const options = Object.keys(question.criteria);
    if (
        typeof choice !== 'string'
        || !Object.hasOwn(question.criteria, choice)
        || !isProbability(confidence)
        || !isRecord(probabilities)
        || Object.keys(probabilities).length !== options.length
    ) return invalid();
    const values: number[] = [];
    for (const option of options) {
        const probability = probabilities[option];
        if (!Object.hasOwn(probabilities, option) || !isProbability(probability)) return invalid();
        values.push(probability);
    }
    const winner = probabilities[choice] as number;
    const divisor = normaliser(values, rounded);
    if (divisor === null || values.some(value => value > winner)) return invalid();
    return {
        type: 'choice',
        choice,
        confidence,
        probabilities: Object.fromEntries(options.map((option, i) => [option, values[i]! / divisor])),
    };
}

function scoreAnswer(question: DecisionScoreQuestion, answer: unknown, rounded: boolean): DecisionScoreAnswer {
    const invalid = (): never => {
        throw new DecisionResponseError('The server returned an invalid score answer');
    };
    if (!isRecord(answer) || answer['type'] !== 'score') return invalid();
    const score = answer['score'];
    const confidence = answer['confidence'];
    const byLevel = answer['probabilities'];
    const levels = question.criteria.length;
    if (
        typeof score !== 'number'
        || !Number.isFinite(score)
        || score < 0
        || score > levels - 1
        || !isProbability(confidence)
        || !isRecord(byLevel)
        || Object.keys(byLevel).length !== levels
    ) return invalid();
    // The wire keys levels by index ("0", "1", ...); callers get them as an ordered list.
    const values: number[] = [];
    for (let level = 0; level < levels; level++) {
        const probability = byLevel[String(level)];
        if (!isProbability(probability)) return invalid();
        values.push(probability);
    }
    const divisor = normaliser(values, rounded);
    if (divisor === null) return invalid();
    return { type: 'score', score, confidence, probabilities: values.map(value => value / divisor) };
}

function noulAnswer(answer: unknown): number {
    if (
        !isRecord(answer)
        || (answer['type'] !== undefined && answer['type'] !== 'noul')
        || !isProbability(answer['noul'])
    ) throw new DecisionResponseError('The server returned no answer to a yes/no question');
    return answer['noul'];
}

/**
 * Validate a `/v1/systemone` response against the questions asked. Every
 * question must have a well-formed answer, or the whole response is rejected:
 * a decision is never half-returned.
 */
export function parseDecisionResponse<const Questions extends DecisionQuestions>(
    questions: Questions,
    body: unknown,
    url: string,
    options: ParseDecisionOptions = {},
): DecisionResult<Questions> {
    const rounded = options.roundedProbabilities ?? false;
    const answers = isRecord(body) && isRecord(body['answers']) ? body['answers'] : {};
    const entries = Object.entries(questions).map(([id, question]) => {
        const answer = Object.hasOwn(answers, id) ? answers[id] : undefined;
        if (question.type === 'choice') return [id, choiceAnswer(question, answer, rounded)] as const;
        if (question.type === 'score') return [id, scoreAnswer(question, answer, rounded)] as const;
        return [id, noulAnswer(answer)] as const;
    });
    const usage = isRecord(body) ? body['usage'] : undefined;
    return {
        answers: Object.fromEntries(entries) as DecisionAnswers<Questions>,
        model: isRecord(body) && typeof body['model'] === 'string' ? body['model'] : null,
        url,
        ...(isRecord(usage) && typeof usage['input_tokens'] === 'number'
            ? { usage: { inputTokens: usage['input_tokens'], details: usage } }
            : {}),
    };
}

/**
 * True when a non-2xx reply says the request does not fit the server's
 * context: HTTP 413, a 400 whose body names the `max_tokens_exceeded` error
 * type, or a 400 whose message is about the context size.
 */
export function isDecisionContextLimit(error: LLMHttpError): boolean {
    if (error.status === 413) return true;
    if (error.status !== 400) return false;
    let payload: unknown;
    try {
        payload = JSON.parse(error.body);
    } catch {
        return false;
    }
    if (!isRecord(payload)) return false;
    for (const key of ['detail', 'error'] as const) {
        const block = payload[key];
        if (isRecord(block) && (block['error_type'] === 'max_tokens_exceeded' || block['type'] === 'max_tokens_exceeded' || block['code'] === 'max_tokens_exceeded')) {
            return true;
        }
    }
    const message = typeof payload['error'] === 'string' ? payload['error'] : '';
    return /context (size|length|window)/i.test(message);
}
