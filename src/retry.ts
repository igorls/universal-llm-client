/**
 * Universal LLM Client — transient-failure classification and backoff.
 *
 * One place that answers "is this failure worth another try, what kind is
 * it, and how long should we wait?" for every caller: the Router's
 * per-provider retries, provider-level retries (Google Flex), and hosts that
 * retry a whole message themselves.
 *
 * Structured fields decide: HTTP status (`LLMHttpError`, or a status-bearing
 * `LLMProviderError`), the provider's error type, `LLMTimeoutError`, and the
 * transport error code (`code` / `cause.code`). Message text is a narrow last
 * resort for errors built by older copies of this library: an `HTTP NNN:`
 * prefix, the timeout wording, a transport code token, or a socket/fetch
 * failure phrase. A bare 3-digit number ("500 tokens") never matches.
 *
 * Zero dependencies — pure TypeScript.
 */

import {
    LLMHttpError,
    LLMProviderError,
    LLMTimeoutError,
    parseRetryAfter,
    retryAfterFromHeaders,
} from './errors.js';

export { parseRetryAfter } from './errors.js';

// ============================================================================
// Classification
// ============================================================================

/**
 * - `rate_limited`: the caller is over a quota or rate (HTTP 429, `rate_limit_error`).
 * - `provider_error`: the provider failed or is overloaded (408, 5xx except 501/505,
 *   529, `overloaded_error`, `api_error`).
 * - `connection_lost`: nothing answered, the connection dropped, or a timeout.
 * - `terminal`: retrying the same request cannot help (other 4xx, 501, auth,
 *   validation, an abort).
 */
export type TransientKind = 'rate_limited' | 'provider_error' | 'connection_lost' | 'terminal';

export interface TransientClassification {
    /** Worth another attempt of the same request. */
    readonly retry: boolean;
    readonly kind: TransientKind;
    /** HTTP status, when the error carried or named one. */
    readonly status?: number;
    /** Transport error code, when one was found. */
    readonly code?: string;
    /** Provider error type, when one was found (e.g. `overloaded_error`). */
    readonly errorType?: string;
    /** The wait the provider asked for, in ms, when it said (see {@link retryAfterFrom}). */
    readonly retryAfterMs?: number;
}

const RATE_LIMIT_STATUSES = new Set([429]);
const PROVIDER_STATUSES = new Set([408, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

const CONNECTION_CODES = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ECONNABORTED',
    'EPIPE',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'CONNECTIONREFUSED',
    'CONNECTIONCLOSED',
    'CONNECTIONERROR',
    'FAILEDTOOPENSOCKET',
    'LLM_TIMEOUT',
]);

const RATE_LIMIT_TYPES = new Set(['rate_limit_error', 'rate_limit_exceeded', 'too_many_requests']);
const PROVIDER_TYPES = new Set(['overloaded_error', 'overloaded', 'api_error', 'internal_error', 'server_error']);

const HTTP_PREFIX = /^HTTP (\d{3}):/;
const OWN_TIMEOUT = /^(?:stream idle|stream|request) timeout after \d+ms(?::\s*\S.*)?$/i;
const CODE_TOKEN = new RegExp(`\\b(${[...CONNECTION_CODES].filter(c => c.startsWith('E') || c.startsWith('UND_')).join('|')})\\b`);
const SOCKET_OR_FETCH =
    /socket connection was closed|socket hang up|other side closed|connection reset|\bfetch failed\b|\bfailed to fetch\b|\bunable to connect\b/i;
/** `Anthropic stream error: overloaded_error — …` from library versions before typed provider errors. */
const ANTHROPIC_STREAM_TYPE = /^Anthropic stream error: ([a-z_]+) —/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object';
}

function codeOf(error: unknown): string | undefined {
    if (!isRecord(error)) return undefined;
    const own = error['code'];
    if (typeof own === 'string' && own) return own.toUpperCase();
    const cause = error['cause'];
    if (isRecord(cause) && typeof cause['code'] === 'string' && cause['code']) return cause['code'].toUpperCase();
    return undefined;
}

/** Status from this library's errors, or a structurally identical copy (`name` + numeric `status`). */
function statusOf(error: unknown): number | undefined {
    if (error instanceof LLMHttpError) return error.status;
    if (error instanceof LLMProviderError) return error.status;
    if (isRecord(error) && typeof error['status'] === 'number' && Number.isInteger(error['status'])) {
        const name = error['name'];
        if (name === 'LLMHttpError' || name === 'LLMProviderError') return error['status'];
    }
    return undefined;
}

function errorTypeOf(error: unknown): string | undefined {
    if (error instanceof LLMProviderError && error.errorType) return error.errorType;
    if (isRecord(error)) {
        if (typeof error['errorType'] === 'string') return error['errorType'];
        const nested = error['error'];
        if (isRecord(nested) && typeof nested['type'] === 'string') return nested['type'];
    }
    return undefined;
}

function messageOf(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    if (isRecord(error) && typeof error['message'] === 'string') return error['message'];
    return '';
}

function kindForStatus(status: number): TransientKind {
    if (RATE_LIMIT_STATUSES.has(status)) return 'rate_limited';
    if (PROVIDER_STATUSES.has(status)) return 'provider_error';
    return 'terminal';
}

function kindForType(type: string): TransientKind | undefined {
    const t = type.toLowerCase();
    if (RATE_LIMIT_TYPES.has(t)) return 'rate_limited';
    if (PROVIDER_TYPES.has(t)) return 'provider_error';
    return undefined;
}

function result(kind: TransientKind, error: unknown, extra: Partial<TransientClassification> = {}): TransientClassification {
    const retryAfterMs = kind === 'terminal' ? undefined : retryAfterFrom(error);
    return {
        retry: kind !== 'terminal',
        kind,
        ...extra,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
}

/**
 * Classify a failure for a same-request retry.
 *
 * This answers "would sending the same request again plausibly work?". It is
 * not {@link classifyFailure}, which decides between retrying the same node and
 * failing over to another one (a 429 there means "cool this node down").
 * An `AbortError` is always terminal: the caller cancelled, or something
 * upstream did on purpose.
 */
export function classifyTransient(error: unknown): TransientClassification {
    if (isRecord(error) && error['name'] === 'AbortError') return { retry: false, kind: 'terminal' };

    if (error instanceof LLMTimeoutError) return result('connection_lost', error, { code: error.code });

    const status = statusOf(error);
    const errorType = errorTypeOf(error);
    if (status !== undefined) {
        return result(kindForStatus(status), error, { status, ...(errorType ? { errorType } : {}) });
    }
    if (errorType) {
        const kind = kindForType(errorType);
        if (kind) return result(kind, error, { errorType });
    }
    if (error instanceof LLMProviderError) {
        return result(error.retryable ? 'provider_error' : 'terminal', error, errorType ? { errorType } : {});
    }

    const code = codeOf(error);
    if (code && CONNECTION_CODES.has(code)) return result('connection_lost', error, { code });

    // Text fallback — narrow on purpose.
    const message = messageOf(error).trim();
    const http = HTTP_PREFIX.exec(message);
    if (http) {
        const fromText = Number(http[1]);
        return result(kindForStatus(fromText), error, { status: fromText });
    }
    const anthropic = ANTHROPIC_STREAM_TYPE.exec(message);
    if (anthropic) {
        const kind = kindForType(anthropic[1]!) ?? 'terminal';
        return result(kind, error, { errorType: anthropic[1]! });
    }
    if (OWN_TIMEOUT.test(message)) return result('connection_lost', error);
    const token = CODE_TOKEN.exec(message);
    if (token) return result('connection_lost', error, { code: token[1]! });
    if (SOCKET_OR_FETCH.test(message)) return result('connection_lost', error);

    return { retry: false, kind: 'terminal', ...(code ? { code } : {}) };
}

// ============================================================================
// Retry-After
// ============================================================================

function headerValue(headers: unknown, name: string): string | undefined {
    if (!isRecord(headers)) return undefined;
    if (typeof (headers as { get?: unknown }).get === 'function') {
        const value = (headers as { get: (n: string) => unknown }).get(name);
        return typeof value === 'string' ? value : undefined;
    }
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === name && typeof value === 'string') return value;
    }
    return undefined;
}

/**
 * The wait (ms) a provider asked for before another try, when it said:
 * 1. `retryAfterMs` on the error ({@link LLMHttpError} parses it from headers);
 * 2. `retry-after-ms` / `Retry-After` on `error.headers` (a `Headers` or a plain record);
 * 3. the body: Gemini's `"retryDelay": "17s"`, then "try again in 1.2s" / "retry after 20ms".
 * Undefined when nothing says. The value is not capped here — see {@link retryDelay}.
 */
export function retryAfterFrom(error: unknown, now: number = Date.now()): number | undefined {
    if (isRecord(error)) {
        const explicit = error['retryAfterMs'];
        if (typeof explicit === 'number' && Number.isFinite(explicit)) return Math.max(0, explicit);
        const headers = error['headers'];
        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
            const fromHeaders = retryAfterFromHeaders(headers, now);
            if (fromHeaders !== undefined) return fromHeaders;
        } else {
            const ms = headerValue(headers, 'retry-after-ms');
            if (ms !== undefined && /^\s*\d+(?:\.\d+)?\s*$/.test(ms)) return Math.round(Number(ms));
            const value = headerValue(headers, 'retry-after');
            if (value !== undefined) {
                const parsed = parseRetryAfter(value, now);
                if (parsed !== undefined) return parsed;
            }
        }
    }
    const body = isRecord(error) && typeof error['body'] === 'string' ? error['body'] : messageOf(error);
    const gemini = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
    if (gemini) return Math.round(Number(gemini[1]) * 1000);
    const phrase = /(?:try again|retry)(?: after| in)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i.exec(body);
    if (phrase) return Math.round(Number(phrase[1]) * (/^m/i.test(phrase[2] ?? '') ? 1 : 1000));
    return undefined;
}

// ============================================================================
// Backoff
// ============================================================================

export interface BackoffOptions {
    /** Unit of the exponential ceiling, ms (default 500). */
    readonly baseMs?: number;
    /** Upper bound of the ceiling, ms (default 10000). */
    readonly capMs?: number;
    /** Source of randomness in [0, 1) (default `Math.random`). */
    readonly random?: () => number;
}

export const DEFAULT_RETRY_BASE_MS = 500;
export const DEFAULT_RETRY_CAP_MS = 10_000;
export const DEFAULT_RETRY_AFTER_CAP_MS = 60_000;
export const DEFAULT_RETRY_AFTER_MIN_MS = 1_000;

/**
 * Full-jitter exponential backoff: `round(random() * min(capMs, baseMs * 2^attempt))`.
 * `attempt` is 0 for the first retry, 1 for the second, and so on.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
    const base = Math.max(0, options.baseMs ?? DEFAULT_RETRY_BASE_MS);
    const cap = Math.max(0, options.capMs ?? DEFAULT_RETRY_CAP_MS);
    const random = options.random ?? Math.random;
    const ceiling = Math.min(cap, base * 2 ** Math.max(0, Math.floor(attempt)));
    const r = Math.min(Math.max(random(), 0), 1);
    return Math.round(r * ceiling);
}

/** Retry knobs shared by the Router and any caller that wants the same behaviour. */
export interface RetryPolicy extends BackoffOptions {
    /**
     * Longest provider-requested wait (`Retry-After`, `retryDelay`) honoured,
     * ms (default 60000). A longer request is not waited out and not retried
     * early: the attempt gives up instead.
     */
    readonly retryAfterCapMs?: number;
    /** Floor for a provider-requested wait of 0 or a date already past, ms (default 1000). */
    readonly retryAfterMinMs?: number;
    /** Called before each wait, after the delay is chosen. Errors thrown here are ignored. */
    readonly onRetry?: (event: RetryEvent) => void;
}

export interface RetryEvent {
    /** 1 for the first retry, 2 for the second, … */
    readonly attempt: number;
    /** How long the caller will wait before that attempt, ms. */
    readonly delayMs: number;
    /** True when `delayMs` came from the provider (`Retry-After`, `retryDelay`). */
    readonly providerRequested: boolean;
    readonly kind: TransientKind;
    readonly error: Error;
    /** Router provider id and model, when the Router is retrying. */
    readonly provider?: string;
    readonly model?: string;
    /** Router call context (`chat`, `stream`, …). */
    readonly context?: string;
    /** True for a stream retried before any event reached the consumer. */
    readonly stream: boolean;
    /** Always true for Router stream retries: the Router never re-streams after the first event. */
    readonly beforeFirstEvent: boolean;
}

export type RetryDelay =
    | { readonly retry: true; readonly delayMs: number; readonly providerRequested: boolean }
    | { readonly retry: false; readonly reason: 'retry_after_exceeds_cap'; readonly retryAfterMs: number };

/**
 * The wait before retry number `attempt + 1` (`attempt` 0-based, as in
 * {@link backoffDelay}). A provider-requested wait wins when present, raised
 * to `retryAfterMinMs`; past `retryAfterCapMs` the answer is "do not retry".
 * Otherwise full-jitter backoff.
 */
export function retryDelay(error: unknown, attempt: number, policy: RetryPolicy = {}, now: number = Date.now()): RetryDelay {
    const asked = retryAfterFrom(error, now);
    if (asked !== undefined) {
        const cap = policy.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS;
        if (asked > cap) return { retry: false, reason: 'retry_after_exceeds_cap', retryAfterMs: asked };
        return { retry: true, delayMs: Math.max(asked, policy.retryAfterMinMs ?? DEFAULT_RETRY_AFTER_MIN_MS), providerRequested: true };
    }
    return { retry: true, delayMs: backoffDelay(attempt, policy), providerRequested: false };
}

// ============================================================================
// Sleep
// ============================================================================

function abortReason(signal: AbortSignal): unknown {
    if (signal.reason !== undefined) return signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

/**
 * Wait `ms`. Rejects with the signal's reason (an `AbortError` by default) as
 * soon as `signal` aborts, including when it is already aborted.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(abortReason(signal!));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, Math.max(0, ms));
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
