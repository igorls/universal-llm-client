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
    const message = error instanceof Error ? error.message : String(error);
    // A hung/timed-out or unreachable node — don't re-hang on it; fail over + cooldown.
    if (/timeout|econnrefused|enotfound|econnreset|fetch failed|network|socket|unreachable/i.test(message)) {
        return { retry: false, cooldown: true };
    }
    // Unknown error — preserve the historical retry-then-failover behavior.
    return { retry: true, cooldown: false };
}
