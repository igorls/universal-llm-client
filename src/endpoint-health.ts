/**
 * Universal LLM Client — Shared endpoint health
 *
 * One record per endpoint origin, shared by every Router in the process, so
 * routers that point at the same host (one per tenant, per model, per role)
 * agree that it is unreachable instead of each discovering it with its own
 * timeout.
 *
 * Only transport unreachability is shared (refused, reset, DNS, no route).
 * Anything with an HTTP response, and any timeout, stays local to the router
 * that saw it: a 401 is one caller's key, a 429 one caller's quota, and a
 * timeout can be a slow generation on a healthy server.
 *
 * A down endpoint is deferred, never forbidden: routers prefer other nodes,
 * and send the request to it anyway when nothing else is left. Recovery is
 * a background probe, so no request waits on it.
 */

/** An external signal that an endpoint is unreachable, for example from a control plane. */
export interface EndpointAvailability {
    readonly status: 'down';
    /** When the observer recorded the failure (ISO timestamp). Older signals never override newer ones. */
    readonly checkedAt?: string;
    /** Delay before the first background recovery probe, in ms. */
    readonly retryAfterMs?: number;
}

/** Transport-only reachability probe: true when anything answered. */
export type ConnectivityProbe = (url: string, timeoutMs: number) => Promise<boolean>;

interface EndpointState {
    down: boolean;
    observedAt: number;
    nextProbeAt: number;
    probing: boolean;
}

const endpoints = new Map<string, EndpointState>();

/** The key an endpoint is shared under: its origin, so every path on one host shares one record. */
export function endpointKey(url: string): string {
    try {
        return new URL(url).origin.toLowerCase();
    } catch {
        return url.trim().replace(/\/+$/, '').toLowerCase();
    }
}

/**
 * Default probe. Any HTTP response proves the host is reachable; status,
 * authentication and quota do not matter here.
 */
export const defaultConnectivityProbe: ConnectivityProbe = async (url, timeoutMs) => {
    try {
        await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
        return true;
    } catch {
        return false;
    }
};

/**
 * Record that an endpoint is unreachable. A signal older than the one already
 * held is ignored, so a stale external report cannot undo a fresher success.
 */
export function markEndpointDown(url: string, retryAfterMs: number, observedAt: number = Date.now()): void {
    const key = endpointKey(url);
    if (!key) return;
    const current = endpoints.get(key);
    if (current && current.observedAt > observedAt) return;
    endpoints.set(key, {
        down: true,
        observedAt,
        nextProbeAt: observedAt + Math.max(0, retryAfterMs),
        probing: false,
    });
}

/** Record that an endpoint answered. */
export function markEndpointUp(url: string): void {
    const key = endpointKey(url);
    if (!key) return;
    const current = endpoints.get(key);
    if (current && !current.down) {
        current.observedAt = Date.now();
        return;
    }
    endpoints.set(key, { down: false, observedAt: Date.now(), nextProbeAt: 0, probing: false });
}

/** Apply an external availability signal for `url`. */
export function applyEndpointAvailability(url: string, availability: EndpointAvailability, retryAfterMs: number): void {
    if (availability.status !== 'down') return;
    const checkedAt = Date.parse(availability.checkedAt ?? '');
    markEndpointDown(url, availability.retryAfterMs ?? retryAfterMs, Number.isFinite(checkedAt) ? checkedAt : Date.now());
}

/**
 * Whether `url` is currently known to be unreachable. When a recovery probe is
 * due, starts one in the background (one at a time per endpoint) and still
 * answers from the current record.
 */
export function isEndpointDown(
    url: string,
    recovery: { probe: ConnectivityProbe; timeoutMs: number; retryAfterMs: number },
): boolean {
    const key = endpointKey(url);
    const state = key ? endpoints.get(key) : undefined;
    if (!state?.down) return false;
    if (!state.probing && Date.now() >= state.nextProbeAt) {
        state.probing = true;
        void recovery
            .probe(url, recovery.timeoutMs)
            .catch(() => false)
            .then((reachable) => {
                if (endpoints.get(key) !== state) return; // superseded by a newer record
                state.probing = false;
                if (reachable) {
                    endpoints.set(key, { down: false, observedAt: Date.now(), nextProbeAt: 0, probing: false });
                } else {
                    state.nextProbeAt = Date.now() + recovery.retryAfterMs;
                }
            });
    }
    return true;
}

/** Forget every endpoint record. For tests. */
export function resetEndpointHealth(): void {
    endpoints.clear();
}
