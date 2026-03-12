/**
 * Universal LLM Client v3 — HTTP Utilities
 *
 * Zero-dependency HTTP layer using native fetch.
 * Works on Node 22+, Bun, Deno, and browsers.
 */

import type { LLMClientOptions } from './interfaces.js';

// ============================================================================
// Types
// ============================================================================

export interface HttpRequestOptions {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: unknown;
    timeout?: number;
    signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
    ok: boolean;
    status: number;
    data: T;
}

// ============================================================================
// HTTP Request
// ============================================================================

/**
 * Make an HTTP request with timeout and error handling.
 * Uses native fetch (available in all target runtimes).
 */
export async function httpRequest<T = unknown>(
    url: string,
    options: HttpRequestOptions = {},
): Promise<HttpResponse<T>> {
    const { method = 'GET', headers = {}, body, timeout = 30000, signal } = options;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Combine external signal with timeout
    const combinedSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;

    try {
        const response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...headers,
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: combinedSignal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as T;

        return {
            ok: response.ok,
            status: response.status,
            data,
        };
    } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeout}ms: ${url}`);
        }
        throw error;
    }
}

// ============================================================================
// Streaming HTTP
// ============================================================================

/**
 * Make a streaming HTTP request.
 * Yields raw string chunks as they arrive.
 */
export async function* httpStream(
    url: string,
    options: HttpRequestOptions = {},
): AsyncGenerator<string, void, unknown> {
    const { method = 'POST', headers = {}, body, timeout = 120000, signal } = options;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const combinedSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;

    try {
        const response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...headers,
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: combinedSignal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        if (!response.body) {
            throw new Error('No response body for streaming');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                yield decoder.decode(value, { stream: true });
            }
        } finally {
            reader.releaseLock();
        }
    } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Stream timeout after ${timeout}ms: ${url}`);
        }
        throw error;
    }
}

// ============================================================================
// Protocol Parsers
// ============================================================================

/**
 * Parse NDJSON (newline-delimited JSON) stream.
 * Used by Ollama's streaming API.
 */
export async function* parseNDJSON<T = unknown>(
    stream: AsyncGenerator<string>,
): AsyncGenerator<T, void, unknown> {
    let buffer = '';

    for await (const chunk of stream) {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
                yield JSON.parse(trimmed) as T;
            } catch {
                // Skip invalid JSON lines
            }
        }
    }

    // Handle remaining buffer
    if (buffer.trim()) {
        try {
            yield JSON.parse(buffer) as T;
        } catch {
            // Skip invalid JSON
        }
    }
}

/**
 * Parse Server-Sent Events stream.
 * Used by OpenAI-compatible APIs and LlamaCpp/vLLM.
 */
export async function* parseSSE(
    stream: AsyncGenerator<string>,
): AsyncGenerator<{ event?: string; data: string }, void, unknown> {
    let buffer = '';

    for await (const chunk of stream) {
        buffer += chunk;

        // Split by double newlines (SSE event delimiter)
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const event of events) {
            const lines = event.split('\n');
            let eventType: string | undefined;
            const dataLines: string[] = [];

            for (const line of lines) {
                if (line.startsWith('event:')) {
                    eventType = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                    dataLines.push(line.slice(5).trim());
                }
            }

            const data = dataLines.join('\n');
            if (data && data !== '[DONE]') {
                yield { event: eventType, data };
            }
        }
    }
}

// ============================================================================
// Header Utilities
// ============================================================================

/**
 * Build standard headers for LLM API requests.
 */
export function buildHeaders(options: LLMClientOptions): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    if (options.apiKey) {
        headers['Authorization'] = `Bearer ${options.apiKey}`;
    }

    return headers;
}
