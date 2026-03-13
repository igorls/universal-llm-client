/**
 * Universal LLM Client v3 — Auditor (Observability)
 *
 * Every LLM interaction (request, response, tool call, retry, failover)
 * is recorded through the Auditor interface. Frameworks inject their own
 * Auditor for dashboards, cost tracking, or behavioral scoring.
 */

import type { TokenUsageInfo, ToolExecutionResult } from './interfaces.js';

// ============================================================================
// Audit Event
// ============================================================================

export type AuditEventType =
    | 'request'
    | 'response'
    | 'stream_start'
    | 'stream_end'
    | 'tool_call'
    | 'tool_result'
    | 'error'
    | 'retry'
    | 'failover'
    | 'structured_request'
    | 'structured_response'
    | 'structured_validation_error';

export interface AuditEvent {
    /** Unix timestamp in ms */
    timestamp: number;
    /** Event type */
    type: AuditEventType;
    /** Provider that generated this event */
    provider?: string;
    /** Model name */
    model?: string;
    /** Duration in ms (for request/response pairs) */
    duration?: number;
    /** Token usage (for response events) */
    usage?: TokenUsageInfo;
    /** Tool execution details (for tool_call/tool_result events) */
    toolExecution?: ToolExecutionResult;
    /** Error message (for error/retry events) */
    error?: string;
    /** Arbitrary metadata for framework-specific data */
    metadata?: Record<string, unknown>;
    /** Schema name for structured output events */
    schemaName?: string;
    /** Raw output snippet for validation errors */
    rawOutput?: string;
}

// ============================================================================
// Auditor Interface
// ============================================================================

/**
 * Interface for LLM observability.
 *
 * Implement this to capture all LLM lifecycle events.
 * The library calls `record()` at every interaction point.
 */
export interface Auditor {
    /** Record an audit event */
    record(event: AuditEvent): void;
    /** Flush any buffered events (optional) */
    flush?(): Promise<void>;
}

// ============================================================================
// Built-in Auditors
// ============================================================================

/**
 * Zero-overhead auditor that discards all events.
 * Used as the default when no auditor is configured.
 */
export class NoopAuditor implements Auditor {
    record(_event: AuditEvent): void {
        // Intentionally empty
    }
}

/**
 * Structured console logging auditor.
 * Useful for development and debugging.
 */
export class ConsoleAuditor implements Auditor {
    private prefix: string;

    constructor(prefix: string = '[LLM]') {
        this.prefix = prefix;
    }

    record(event: AuditEvent): void {
        const parts = [
            this.prefix,
            event.type.toUpperCase(),
            event.provider ? `[${event.provider}]` : '',
            event.model ? `(${event.model})` : '',
        ].filter(Boolean);

        switch (event.type) {
            case 'request':
                console.log(parts.join(' '), '→');
                break;
            case 'response':
                console.log(
                    parts.join(' '),
                    event.duration ? `${event.duration}ms` : '',
                    event.usage ? `${event.usage.totalTokens} tokens` : '',
                );
                break;
            case 'stream_start':
                console.log(parts.join(' '), 'streaming...');
                break;
            case 'stream_end':
                console.log(
                    parts.join(' '),
                    'done',
                    event.duration ? `${event.duration}ms` : '',
                );
                break;
            case 'tool_call':
                console.log(parts.join(' '), event.toolExecution?.tool_call_id ?? '');
                break;
            case 'tool_result':
                console.log(
                    parts.join(' '),
                    event.toolExecution?.error ? '❌' : '✅',
                    event.toolExecution?.duration ? `${event.toolExecution.duration}ms` : '',
                );
                break;
            case 'error':
                console.error(parts.join(' '), event.error ?? 'Unknown error');
                break;
            case 'retry':
                console.warn(parts.join(' '), event.error ?? '', event.metadata ?? '');
                break;
            case 'failover':
                console.warn(parts.join(' '), '→', event.metadata?.['nextProvider'] ?? '');
                break;
            case 'structured_request':
                console.log(
                    parts.join(' '),
                    `schema=${event.schemaName ?? 'unknown'}`,
                    '→',
                );
                break;
            case 'structured_response':
                console.log(
                    parts.join(' '),
                    event.duration ? `${event.duration}ms` : '',
                    `schema=${event.schemaName ?? 'unknown'}`,
                );
                break;
            case 'structured_validation_error':
                console.error(
                    parts.join(' '),
                    `schema=${event.schemaName ?? 'unknown'}`,
                    event.error ?? 'Validation failed',
                    event.rawOutput ? `raw=${event.rawOutput.slice(0, 50)}...` : '',
                );
                break;
        }
    }
}

/**
 * Buffered auditor that collects events for batch processing.
 * Useful for custom sinks (OpenTelemetry, DataDog, databases, etc.)
 */
export class BufferedAuditor implements Auditor {
    private events: AuditEvent[] = [];
    private maxBufferSize: number;
    private onFlush?: (events: AuditEvent[]) => Promise<void>;

    constructor(options: {
        maxBufferSize?: number;
        onFlush?: (events: AuditEvent[]) => Promise<void>;
    } = {}) {
        this.maxBufferSize = options.maxBufferSize ?? 1000;
        this.onFlush = options.onFlush;
    }

    record(event: AuditEvent): void {
        this.events.push(event);
        if (this.events.length >= this.maxBufferSize) {
            // Auto-flush when buffer is full (fire and forget)
            this.flush().catch(() => {});
        }
    }

    /** Get all buffered events */
    getEvents(): ReadonlyArray<AuditEvent> {
        return this.events;
    }

    /** Flush buffered events to the configured sink */
    async flush(): Promise<void> {
        if (this.events.length === 0) return;
        const batch = this.events.splice(0);
        if (this.onFlush) {
            await this.onFlush(batch);
        }
    }

    /** Clear all buffered events without flushing */
    clear(): void {
        this.events.length = 0;
    }
}
