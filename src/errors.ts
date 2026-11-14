/**
 * Universal LLM Client v3 — Typed Errors
 *
 * The Router's failover engine treats ANY throw as a provider failure, but typed
 * errors let it classify retryable-vs-terminal failures (see Gap 3) and let
 * callers surface a clean message instead of leaking a raw provider payload.
 *
 * Zero dependencies — pure TypeScript.
 */

function truncate(text: string, max = 500): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * A non-2xx HTTP response from a provider endpoint (transport-level failure).
 * Carries the status + raw body so the failover engine can classify it
 * (e.g. 429/quota → fail over immediately rather than retrying the same node).
 */
export class LLMHttpError extends Error {
    readonly status: number;
    readonly body: string;
    readonly url?: string;

    constructor(status: number, body: string, url?: string) {
        super(`HTTP ${status}: ${truncate(body)}`);
        this.name = 'LLMHttpError';
        this.status = status;
        this.body = body;
        this.url = url;
    }
}

/**
 * The endpoint answered (often HTTP 200) but the payload is a provider ERROR —
 * a quota/session limit, a rejected request, etc. — rather than a completion.
 *
 * Some providers, notably Ollama, return `{"error":"…"}` with a 200 status or as
 * a streaming NDJSON line. Without an explicit throw here that error would be
 * silently swallowed (empty completion), so the Router's failover would never
 * trigger and the bad payload could leak to the caller as if it were the reply.
 */
export class LLMProviderError extends Error {
    readonly provider: string;
    /** Hint for the failover engine: is retrying the SAME provider worthwhile? */
    readonly retryable: boolean;

    constructor(provider: string, message: string, opts?: { retryable?: boolean }) {
        super(message);
        this.name = 'LLMProviderError';
        this.provider = provider;
        this.retryable = opts?.retryable ?? false;
    }
}

/**
 * Pull an error message out of a provider payload that carries an `error` field.
 * Handles both the flat shape (Ollama `{"error":"…"}`) and the nested shape
 * several OpenAI-compatible gateways use (`{"error":{"message":"…"}}`).
 * Returns null when the payload is a normal response.
 */
export function extractProviderErrorMessage(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const err = (payload as { error?: unknown }).error;
    if (typeof err === 'string') return err.trim() ? err : null;
    if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
        const message = (err as { message: string }).message;
        return message.trim() ? message : null;
    }
    return null;
}

/**
 * True when a completion's text content is actually a bare `{"error":"…"}`
 * object relayed as the reply (a provider that answered 200 and put the error in
 * `content`). A safety net so such a payload is never surfaced as a model reply.
 */
export function looksLikeErrorPayload(content: string): boolean {
    const trimmed = content.trim();
    if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) return false;
    try {
        return extractProviderErrorMessage(JSON.parse(trimmed)) !== null;
    } catch {
        return false;
    }
}

export interface FailureDisposition {
    /** Retry the SAME provider (transient error) before failing over. */
    retry: boolean;
    /**
     * Mark the provider unhealthy + start its cooldown immediately — it is
     * unavailable (down, quota-exhausted, or unauthorized), not just a one-off —
     * so subsequent turns skip it instead of re-probing it every call.
     */
    cooldown: boolean;
    /**
     * The node did nothing wrong (it has no such endpoint, or the request does
     * not fit its context): fail over, but do not count this toward the
     * consecutive-failure threshold that marks a node unhealthy.
     */
    blameless?: boolean;
}

/**
 * Classify a failure so the failover engine can fail FAST: skip the wasted
 * per-provider retries on a terminally-broken node, and cool a down/exhausted
 * provider immediately rather than re-hitting it (with a full timeout) every turn
 * until it trips the consecutive-failure threshold. This is what turns the
 * "slow to fail" chain (retry × timeout down to a dead cloud fallback) into a
 * fast hop to the next healthy node.
 */
export function classifyFailure(error: unknown): FailureDisposition {
    // An error that states its own disposition (e.g. a decision the server
    // answered badly: move on, but the node is not down).
    const stated = (error as { failover?: unknown } | null)?.failover;
    if (stated && typeof stated === 'object'
        && typeof (stated as FailureDisposition).retry === 'boolean'
        && typeof (stated as FailureDisposition).cooldown === 'boolean') {
        return {
            retry: (stated as FailureDisposition).retry,
            cooldown: (stated as FailureDisposition).cooldown,
            ...((stated as FailureDisposition).blameless === true ? { blameless: true } : {}),
        };
    }
    if (error instanceof LLMHttpError) {
        // Server hiccup or a request-level timeout: worth one more try on the node.
        if (error.status >= 500 || error.status === 408) return { retry: true, cooldown: false };
        // Rate/quota, auth, or missing model/endpoint: the node can't serve this
        // right now — don't retry it, and cool it down so we stop probing it.
        if (error.status === 429 || error.status === 401 || error.status === 403 || error.status === 404) {
            return { retry: false, cooldown: true };
        }
        // Other 4xx (e.g. a malformed request): retrying the same node won't help,
        // but the node itself is fine — fail over without cooling it down.
        return { retry: false, cooldown: false };
    }
    if (error instanceof LLMProviderError) {
        // A provider error (e.g. Ollama quota-as-content): cool it down unless the
        // provider explicitly marked it retryable.
        return { retry: error.retryable, cooldown: !error.retryable };
    }
    // A hung/timed-out or unreachable node — don't re-hang on it; fail over + cooldown.
    if (isConnectivityFailure(error)) return { retry: false, cooldown: true };
    // Unknown error — preserve the historical retry-then-failover behavior.
    return { retry: true, cooldown: false };
}

/** Best-effort error code from an error or its `cause` (Node sets `.code`/`.cause.code`). */
function errorCode(error: unknown): string {
    if (error && typeof error === 'object') {
        const e = error as { code?: unknown; cause?: unknown };
        if (typeof e.code === 'string') return e.code;
        if (e.cause && typeof e.cause === 'object' && typeof (e.cause as { code?: unknown }).code === 'string') {
            return (e.cause as { code: string }).code;
        }
    }
    return '';
}

/**
 * True for transport-level connectivity failures (unreachable node, refused
 * connection, DNS failure, timeout). Matches across runtimes: Node throws a
 * TypeError('fetch failed') with `cause.code` = ECONNREFUSED/ENOTFOUND/…, while
 * Bun throws 'Unable to connect. Is the computer able to access the url?'.
 */
export function isConnectivityFailure(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (/timeout|fetch failed|failed to fetch|network|socket|unreachable|unable to connect|connection (refused|reset|closed|timed out|error)|econnrefused|econnreset|econnaborted|enotfound|ehostunreach|enetunreach|etimedout/.test(message)) {
        return true;
    }
    const code = errorCode(error).toUpperCase();
    return /^(ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|CONNECTIONREFUSED|CONNECTIONCLOSED|CONNECTIONERROR)$/.test(code);
}

/**
 * True when the endpoint itself could not be reached: refused, reset or
 * aborted connection, DNS failure, no route. Narrower than
 * {@link isConnectivityFailure}, because this is the signal shared between
 * every caller of a host:
 *
 * - Decided from the transport error code only (Bun sets `code`, Node sets
 *   `cause.code`), never from message text. Messages can carry text a server
 *   sent back, and one caller's endpoint must not be able to mark a host down
 *   for everyone by answering "connection refused".
 * - Errors built from a server response (`LLMHttpError`, `LLMProviderError`,
 *   any error stating its own `failover` disposition) are never unreachable:
 *   something answered.
 * - Timeouts are excluded: a healthy server can be slow (a long generation,
 *   a model loading).
 */
export function isEndpointUnreachable(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error instanceof LLMHttpError || error instanceof LLMProviderError) return false;
    if ((error as { failover?: unknown }).failover !== undefined) return false;
    return UNREACHABLE_CODES.test(errorCode(error).toUpperCase());
}

/** Transport codes for "nothing answered" across Node (`cause.code`) and Bun (`code`). */
const UNREACHABLE_CODES =
    /^(ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|CONNECTIONREFUSED|CONNECTIONCLOSED|CONNECTIONERROR|FAILEDTOOPENSOCKET|UND_ERR_SOCKET)$/;
