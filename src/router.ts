/**
 * Universal LLM Client v3 — Router (Internal Failover Engine)
 *
 * Manages the ordered provider chain with:
 *  - Priority ordering
 *  - Per-provider retries
 *  - Health tracking with failure thresholds
 *  - Cooldown periods for unhealthy providers
 *  - Audit integration for every retry/failover event
 *
 * Not exposed publicly — AIModel delegates to it.
 */

import { BaseLLMClient } from './client.js';
import type { Auditor } from './auditor.js';
import { NoopAuditor } from './auditor.js';
import { classifyFailure, type FailureDisposition } from './errors.js';
import type {
    LLMChatMessage,
    LLMChatResponse,
    ChatOptions,
    ModelMetadata,
    OutputOptions,
} from './interfaces.js';
import type { DecodedEvent } from './stream-decoder.js';
import {
    parseStructured,
    StructuredOutputError,
    StreamingJsonParser,
    getJsonSchemaFromConfig,
    type SchemaConfig,
    type StructuredOutputResult,
} from './structured-output.js';

// ============================================================================
// Types
// ============================================================================

export interface ProviderEntry {
    /** Unique identifier for this provider entry */
    id: string;
    /** The underlying LLM client */
    client: BaseLLMClient;
    /**
     * Priority (lower = tried first, defaults to insertion order). Entries
     * sharing a priority form a POOL: the router load-balances across the pool
     * (least-inflight + session affinity) and only moves to the next priority
     * tier on failure or saturation.
     */
    priority: number;
    /** Override model name for this provider */
    modelOverride?: string;
    /**
     * Max concurrent in-flight requests on this node (default: unlimited).
     * At the cap the node is skipped; when a whole pool is capped the request
     * waits up to `spillAfterMs` for a slot, then spills to the next tier.
     */
    maxConcurrent?: number;
}

interface ProviderHealth {
    healthy: boolean;
    consecutiveFailures: number;
    lastFailure?: number;
    cooldownUntil?: number;
    /** Wall-clock of the last successful dispatch — freshness gate for the cold-node preflight. */
    lastSuccessAt?: number;
}

/** Per-node runtime routing metrics (inflight + lifetime counters). */
interface ProviderMetrics {
    inflight: number;
    requests: number;
    failures: number;
    lastLatencyMs?: number;
    /** Exponential moving average (α = 0.2) of successful-call latency. */
    avgLatencyMs?: number;
}

/** Per-priority-tier counters (a tier = one pool). */
interface PoolMetrics {
    /** Requests that left this saturated pool for a lower tier. */
    spills: number;
    /** Requests that waited (bounded) for a slot in this pool. */
    queueWaits: number;
}

/** Per-request routing hints threaded from ChatOptions. */
export interface RouteOptions {
    /**
     * Affinity key: within a pool, prefer a stable node per key (rendezvous
     * hashing) so a conversation keeps hitting the same node's prompt cache.
     * Preference only — busy/unhealthy nodes fall through to the next-best.
     */
    sessionKey?: string;
}

export interface RouterConfig {
    /** Max retries per provider before failover (default: 2) */
    retriesPerProvider?: number;
    /** Max consecutive failures before marking unhealthy (default: 3) */
    maxFailures?: number;
    /** Cooldown period in ms for unhealthy providers (default: 30000) */
    cooldownMs?: number;
    /**
     * How long (ms) to wait for a slot when every node of a pool is at its
     * `maxConcurrent` cap before spilling to the next tier (default: 750).
     */
    spillAfterMs?: number;
    /**
     * Time-box for the cold-node liveness preflight (default: 2500; 0
     * disables). A node with no recent success gets a cheap `getModels()`
     * probe raced against this timer before the real request commits to it —
     * a powered-off host blackholes TCP SYNs, and the OS retry budget alone
     * stalls the first request ~21s+ before failover (observed 26.7s live).
     * Only a probe TIMEOUT marks the node dead: an error reply proves the
     * host is reachable and defers to the real dispatch.
     */
    coldProbeTimeoutMs?: number;
    /** Success-freshness window that skips the preflight (default: 60000). */
    coldProbeAfterMs?: number;
    /** Auditor for observability */
    auditor?: Auditor;
}

export interface ProviderStatus {
    id: string;
    healthy: boolean;
    active: boolean;
    consecutiveFailures: number;
    cooldownUntil?: number;
    model: string;
    /** Endpoint base URL of this node (for telemetry labeling). */
    url: string;
    /** Priority tier (pool) this node belongs to. */
    priority: number;
    /** Requests currently in flight on this node. */
    inflight: number;
    /** Concurrency cap (undefined = unlimited). */
    maxConcurrent?: number;
    /** Lifetime successful+failed dispatches to this node. */
    requests: number;
    /** Lifetime failed dispatches (retries exhausted / terminal). */
    failures: number;
    /** EMA of successful-call latency in ms. */
    avgLatencyMs?: number;
    /** Latency of the most recent successful call in ms. */
    lastLatencyMs?: number;
}

/** Pool-level view for telemetry (one entry per priority tier). */
export interface PoolStatus {
    priority: number;
    /** Node ids in this pool. */
    nodes: string[];
    /** Sum of inflight across the pool. */
    inflight: number;
    /** Requests that spilled OUT of this pool because it was saturated. */
    spills: number;
    /** Requests that queued (bounded wait) on this pool. */
    queueWaits: number;
}

// ============================================================================
// Router
// ============================================================================

export class Router {
    private providers: ProviderEntry[] = [];
    private health: Map<string, ProviderHealth> = new Map();
    private metrics: Map<string, ProviderMetrics> = new Map();
    private poolMetrics: Map<number, PoolMetrics> = new Map();
    /** Wake-ups for requests waiting on a `maxConcurrent` slot. */
    private slotWaiters: Array<() => void> = [];
    private auditor: Auditor;
    private config: Required<Omit<RouterConfig, 'auditor'>>;

    constructor(config: RouterConfig = {}) {
        this.auditor = config.auditor ?? new NoopAuditor();
        this.config = {
            retriesPerProvider: config.retriesPerProvider ?? 2,
            maxFailures: config.maxFailures ?? 3,
            cooldownMs: config.cooldownMs ?? 30000,
            spillAfterMs: config.spillAfterMs ?? 750,
            coldProbeTimeoutMs: config.coldProbeTimeoutMs ?? 2500,
            coldProbeAfterMs: config.coldProbeAfterMs ?? 60000,
        };
    }

    // ========================================================================
    // Provider Management
    // ========================================================================

    addProvider(entry: ProviderEntry): void {
        this.providers.push(entry);
        this.health.set(entry.id, {
            healthy: true,
            consecutiveFailures: 0,
        });
        this.metrics.set(entry.id, {
            inflight: 0,
            requests: 0,
            failures: 0,
        });
        // Re-sort by priority
        this.providers.sort((a, b) => a.priority - b.priority);
    }

    removeProvider(id: string): void {
        this.providers = this.providers.filter(p => p.id !== id);
        this.health.delete(id);
        this.metrics.delete(id);
    }

    setAuditor(auditor: Auditor): void {
        this.auditor = auditor;
    }

    /** All registered provider clients, in priority order. */
    getClients(): BaseLLMClient[] {
        return this.providers.map(p => p.client);
    }

    getStatus(): ProviderStatus[] {
        return this.providers.map(p => {
            const m = this.metrics.get(p.id);
            return {
                id: p.id,
                healthy: this.isAvailable(p.id),
                active: true,
                consecutiveFailures: this.health.get(p.id)?.consecutiveFailures ?? 0,
                cooldownUntil: this.health.get(p.id)?.cooldownUntil,
                model: p.modelOverride ?? p.client.model,
                url: p.client.url,
                priority: p.priority,
                inflight: m?.inflight ?? 0,
                maxConcurrent: p.maxConcurrent,
                requests: m?.requests ?? 0,
                failures: m?.failures ?? 0,
                avgLatencyMs: m?.avgLatencyMs,
                lastLatencyMs: m?.lastLatencyMs,
            };
        });
    }

    /** Pool-level (priority-tier) telemetry: membership, load, spill counters. */
    getPoolStatus(): PoolStatus[] {
        const pools = new Map<number, PoolStatus>();
        for (const p of this.providers) {
            let pool = pools.get(p.priority);
            if (!pool) {
                const pm = this.poolMetrics.get(p.priority);
                pool = {
                    priority: p.priority,
                    nodes: [],
                    inflight: 0,
                    spills: pm?.spills ?? 0,
                    queueWaits: pm?.queueWaits ?? 0,
                };
                pools.set(p.priority, pool);
            }
            pool.nodes.push(p.id);
            pool.inflight += this.metrics.get(p.id)?.inflight ?? 0;
        }
        return [...pools.values()].sort((a, b) => a.priority - b.priority);
    }

    // ========================================================================
    // Execution with Failover
    // ========================================================================

    /**
     * Execute a function against providers with automatic failover.
     *
     * Selection is pool-aware: available providers are grouped by priority
     * tier; within a tier the request goes to the session-affine node (when
     * `route.sessionKey` is set) or the least-loaded one, skipping nodes at
     * their `maxConcurrent` cap. A fully-capped tier is waited on (bounded by
     * `spillAfterMs`) before the request spills to the next tier. Failure
     * semantics per node (retries, terminal-error classification, cooldown)
     * are unchanged from the classic ordered chain.
     */
    async execute<T>(
        fn: (client: BaseLLMClient) => Promise<T>,
        context: string = 'execute',
        route?: RouteOptions,
    ): Promise<T> {
        if (this.getAvailableProviders().length === 0) {
            throw new Error('No available LLM providers. All providers are unhealthy or in cooldown.');
        }

        let lastError: Error | undefined;
        const tried = new Set<string>();

        for (const priority of this.poolPriorities()) {
            while (true) {
                const provider = await this.pickFromPool(priority, route?.sessionKey, tried);
                if (!provider) break; // pool exhausted or saturated past the queue window — spill

                tried.add(provider.id);
                if (!(await this.coldNodeAlive(provider, context))) {
                    lastError = new Error(`cold-node liveness probe timed out: ${provider.id}`);
                    continue;
                }
                this.acquireSlot(provider.id);
                const started = Date.now();
                let disposition: FailureDisposition = { retry: true, cooldown: false };
                try {
                    for (let attempt = 0; attempt <= this.config.retriesPerProvider; attempt++) {
                        try {
                            if (attempt > 0) {
                                this.auditor.record({
                                    timestamp: Date.now(),
                                    type: 'retry',
                                    provider: provider.id,
                                    model: provider.modelOverride ?? provider.client.model,
                                    metadata: { attempt, context },
                                });
                            }

                            const result = await fn(provider.client);
                            this.recordSuccess(provider.id, Date.now() - started);
                            return result;
                        } catch (error) {
                            lastError = error instanceof Error ? error : new Error(String(error));
                            disposition = classifyFailure(lastError);
                            this.auditor.record({
                                timestamp: Date.now(),
                                type: 'error',
                                provider: provider.id,
                                model: provider.modelOverride ?? provider.client.model,
                                error: lastError.message,
                                metadata: { attempt, context, retryable: disposition.retry },
                            });
                            // Terminal for this node (quota/auth/down/timeout) — stop burning
                            // retries on it and move on.
                            if (!disposition.retry) break;
                        }
                    }
                } finally {
                    this.releaseSlot(provider.id);
                }

                // Retries exhausted (or skipped) for this provider — record with the
                // classified disposition (cooldown terminal/unavailable nodes now).
                this.recordFailure(provider.id, { cooldown: disposition.cooldown });

                // Try next node (same pool first, then the next tier — the loop
                // structure IS the failover order).
                const next = this.peekNextCandidate(tried);
                if (next) {
                    this.auditor.record({
                        timestamp: Date.now(),
                        type: 'failover',
                        provider: provider.id,
                        metadata: {
                            from: provider.id,
                            nextProvider: next.id,
                            context,
                            reason: lastError?.message,
                        },
                    });
                }
            }
        }

        throw lastError ?? new Error('All providers failed');
    }

    /**
     * Execute a streaming function with failover — bounded by the first token.
     *
     * Failover for streaming is only safe BEFORE the first event reaches the
     * consumer: a provider that fails on connect / immediately (e.g. a quota
     * error, an unreachable node) can be transparently swapped for the next one.
     * Once any token has been yielded, re-streaming from another provider would
     * DUPLICATE the visible output, so a failure past that boundary is surfaced
     * to the caller instead of silently retried.
     */
    async *executeStream(
        fn: (client: BaseLLMClient) => AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>,
        context: string = 'stream',
        route?: RouteOptions,
    ): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
        if (this.getAvailableProviders().length === 0) {
            throw new Error('No available LLM providers for streaming.');
        }

        let lastError: Error | undefined;
        const tried = new Set<string>();

        for (const priority of this.poolPriorities()) {
            while (true) {
                const provider = await this.pickFromPool(priority, route?.sessionKey, tried);
                if (!provider) break; // pool exhausted or saturated — spill to next tier

                tried.add(provider.id);
                if (!(await this.coldNodeAlive(provider, context))) {
                    lastError = new Error(`cold-node liveness probe timed out: ${provider.id}`);
                    continue;
                }
                // Has this attempt emitted anything yet? Once it has, we are past the
                // first-token boundary and can no longer fail over without duplicating.
                let emitted = false;
                this.acquireSlot(provider.id);
                const started = Date.now();
                try {
                    const stream = fn(provider.client);
                    let returnValue: LLMChatResponse | void;

                    while (true) {
                        const result = await stream.next();
                        if (result.done) {
                            returnValue = result.value;
                            break;
                        }
                        emitted = true;
                        yield result.value;
                    }

                    this.recordSuccess(provider.id, Date.now() - started);
                    return returnValue;
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                    this.recordFailure(provider.id, { cooldown: classifyFailure(lastError).cooldown });

                    if (emitted) {
                        // Past the first-token boundary — re-streaming elsewhere would
                        // double the output. Surface the error rather than fail over.
                        this.auditor.record({
                            timestamp: Date.now(),
                            type: 'error',
                            provider: provider.id,
                            error: lastError.message,
                            metadata: { context, phase: 'mid-stream', failedOver: false },
                        });
                        throw lastError;
                    }

                    // Nothing emitted yet — safe to fail over to the next provider.
                    this.auditor.record({
                        timestamp: Date.now(),
                        type: 'failover',
                        provider: provider.id,
                        error: lastError.message,
                        metadata: { context, phase: 'pre-stream' },
                    });
                } finally {
                    // Slot is held for the FULL stream lifetime (also released when
                    // the consumer abandons the generator early — gen.return() runs
                    // finally blocks).
                    this.releaseSlot(provider.id);
                }
            }
        }

        throw lastError ?? new Error('All providers failed for streaming');
    }

    // ========================================================================
    // Convenience Methods
    // ========================================================================

    /**
     * @deprecated No longer needed — structured output and tools can now be used together.
     */
    private validateOutputAndTools(_options?: ChatOptions): void {
        // Structured output and tools are now allowed together.
    }

    /**
     * Extract schema from output options.
     * Returns a SchemaConfig or a bare jsonSchema object.
     */
    private getSchemaFromOutput<T>(output: OutputOptions<T>): { config: SchemaConfig<T>; name?: string; description?: string } | { jsonSchema: Record<string, unknown>; name?: string; description?: string } {
        if (output.schema) {
            return {
                config: output.schema,
                name: output.name,
                description: output.description,
            };
        }
        if (output.jsonSchema) {
            return {
                jsonSchema: output.jsonSchema as Record<string, unknown>,
                name: output.name,
                description: output.description,
            };
        }
        throw new Error('output must have either schema or jsonSchema');
    }

    async chat(messages: LLMChatMessage[], options?: ChatOptions): Promise<LLMChatResponse> {
        // Validate that output and tools are not used together (VAL-API-005)
        this.validateOutputAndTools(options);

        // If output parameter is provided, use structured output flow (VAL-API-004)
        if (options?.output) {
            // Type assertion: we know output is defined at this point
            return this.chatWithStructuredOutput(messages, options as ChatOptions & { output: OutputOptions });
        }

        return this.execute(
            client => client.chat(messages, options),
            'chat',
            { sessionKey: options?.sessionKey },
        );
    }

    /**
     * Chat with structured output using the output parameter.
     * Validates response against the schema and returns structured property.
     */
    private async chatWithStructuredOutput<T>(
        messages: LLMChatMessage[],
        options: ChatOptions & { output: OutputOptions<T> },
    ): Promise<LLMChatResponse<T>> {
        const { output } = options;
        const schemaInfo = this.getSchemaFromOutput(output);
        const schemaName = schemaInfo.name ?? 'response';

        // Emit structured_request event
        this.auditor.record({
            timestamp: Date.now(),
            type: 'structured_request',
            provider: 'router',
            schemaName,
        });

        // Build ChatOptions with schema for the provider
        // Keep tools if provided — structured output and tools can work together
        const { output: _, ...restOptions } = options;
        const structuredOptions: ChatOptions = {
            ...restOptions,
            // Use jsonSchema for the provider
            jsonSchema: 'config' in schemaInfo
                ? getJsonSchemaFromConfig(schemaInfo.config)
                : schemaInfo.jsonSchema,
            schemaName: schemaInfo.name,
            schemaDescription: schemaInfo.description,
        };

        const start = Date.now();

        // Get response from provider
        const response = await this.execute(
            client => client.chat(messages, structuredOptions),
            'chatWithStructuredOutput',
        );

        // If the response contains tool calls, skip validation and return as-is
        if (response.message.tool_calls && response.message.tool_calls.length > 0) {
            return response as LLMChatResponse<T>;
        }

        // Extract text content from response
        const content = typeof response.message.content === 'string'
            ? response.message.content
            : response.message.content
                .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
                .map(part => part.text)
                .join('');

        // Get the SchemaConfig for validation
        const schemaConfig: SchemaConfig<T> | null = 'config' in schemaInfo ? schemaInfo.config : null;

        if (!schemaConfig || !schemaConfig.validate) {
            // No validator — return parsed JSON without validation
            try {
                const structured = JSON.parse(content) as T;
                // Emit structured_response event on success
                this.auditor.record({
                    timestamp: Date.now(),
                    type: 'structured_response',
                    provider: response.provider ?? 'router',
                    model: response.message.role,
                    duration: Date.now() - start,
                    schemaName,
                    usage: response.usage,
                });
                return {
                    ...response,
                    structured,
                };
            } catch (error) {
                // JSON parse failed
                const rawOutput = content;
                this.auditor.record({
                    timestamp: Date.now(),
                    type: 'structured_validation_error',
                    provider: response.provider ?? 'router',
                    schemaName,
                    error: error instanceof Error ? error.message : 'JSON parse failed',
                    rawOutput,
                });
                throw new StructuredOutputError(
                    `Failed to parse JSON: ${rawOutput}`,
                    { rawOutput: rawOutput, cause: error instanceof Error ? error : undefined },
                );
            }
        }

        // Parse and validate against SchemaConfig
        try {
            const validated = parseStructured(schemaConfig, content);
            // Emit structured_response event on success
            this.auditor.record({
                timestamp: Date.now(),
                type: 'structured_response',
                provider: response.provider ?? 'router',
                duration: Date.now() - start,
                schemaName,
                usage: response.usage,
            });
            return {
                ...response,
                structured: validated,
            };
        } catch (error) {
            // Emit structured_validation_error event
            const rawOutput = content;
            this.auditor.record({
                timestamp: Date.now(),
                type: 'structured_validation_error',
                provider: response.provider ?? 'router',
                schemaName,
                error: error instanceof Error ? error.message : 'Validation failed',
                rawOutput,
            });
            throw error;
        }
    }

    async chatWithTools(
        messages: LLMChatMessage[],
        options?: ChatOptions & { maxIterations?: number },
    ): Promise<LLMChatResponse> {
        return this.execute(
            client => client.chatWithTools(messages, options),
            'chatWithTools',
            { sessionKey: options?.sessionKey },
        );
    }

    async *chatStream(
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
        // Structured output via output parameter is not supported on streaming
        // Use generateStructuredStream() instead
        if (options?.output) {
            throw new Error(
                'The "output" parameter is not supported with chatStream(). '
                + 'Use generateStructuredStream() for streaming structured output.',
            );
        }

        return yield* this.executeStream(
            client => client.chatStream(messages, options),
            'chatStream',
            { sessionKey: options?.sessionKey },
        );
    }

    async embed(text: string): Promise<number[]> {
        return this.execute(
            client => client.embed(text),
            'embed',
        );
    }

    async embedArray(texts: string[]): Promise<number[][]> {
        return this.execute(
            client => client.embedArray(texts),
            'embedArray',
        );
    }

    async getModels(): Promise<string[]> {
        // Aggregate models from all providers
        const allModels: string[] = [];
        for (const provider of this.providers) {
            try {
                const models = await provider.client.getModels();
                allModels.push(...models);
            } catch {
                // Skip unavailable providers
            }
        }
        return [...new Set(allModels)];
    }

    async getModelInfo(): Promise<ModelMetadata> {
        return this.execute(
            client => client.getModelInfo(),
            'getModelInfo',
        );
    }

    // ========================================================================
    // Structured Output Methods
    // ========================================================================

    /**
     * Generate structured output from the LLM with automatic failover.
     * Validates the response against the provided SchemaConfig.
     * Throws StructuredOutputError on validation failure.
     *
     * @template T The output type
     * @param config Schema configuration (JSON Schema + optional validator)
     * @param messages Chat messages to send
     * @param options Additional options (temperature, maxTokens, etc.)
     * @returns Validated structured output
     * @throws StructuredOutputError if validation fails
     */
    async generateStructured<T>(
        config: SchemaConfig<T>,
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): Promise<T> {
        // Get JSON Schema from config
        const jsonSchema = getJsonSchemaFromConfig(config);
        const schemaName = options?.schemaName ?? config.name ?? 'response';

        // Emit structured_request event
        this.auditor.record({
            timestamp: Date.now(),
            type: 'structured_request',
            provider: 'router',
            schemaName,
        });

        // Build ChatOptions with schema
        const structuredOptions: ChatOptions = {
            ...options,
            jsonSchema,
        };

        const start = Date.now();

        // Execute with failover
        const response = await this.execute(
            client => client.chat(messages, structuredOptions),
            'generateStructured',
        );

        // Parse and validate the response
        const content = typeof response.message.content === 'string'
            ? response.message.content
            : response.message.content
                .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
                .map(part => part.text)
                .join('');

        try {
            const result = parseStructured(config, content);
            // Emit structured_response event on success
            this.auditor.record({
                timestamp: Date.now(),
                type: 'structured_response',
                provider: response.provider ?? 'router',
                duration: Date.now() - start,
                schemaName,
                usage: response.usage,
            });
            return result;
        } catch (error) {
            // Emit structured_validation_error event
            this.auditor.record({
                timestamp: Date.now(),
                type: 'structured_validation_error',
                provider: response.provider ?? 'router',
                schemaName,
                error: error instanceof Error ? error.message : 'Validation failed',
                rawOutput: content,
            });
            throw error;
        }
    }

    /**
     * Try to generate structured output, returning a result object instead of throwing.
     *
     * @template T The output type
     * @param config Schema configuration (JSON Schema + optional validator)
     * @param messages Chat messages to send
     * @param options Additional options (temperature, maxTokens, etc.)
     * @returns StructuredOutputResult<T>
     */
    async tryParseStructured<T>(
        config: SchemaConfig<T>,
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): Promise<StructuredOutputResult<T>> {
        try {
            const value = await this.generateStructured(config, messages, options);
            return { ok: true, value };
        } catch (error) {
            // If error is already a StructuredOutputError, use it directly
            if (error instanceof Error && 'rawOutput' in error) {
                return {
                    ok: false,
                    error: error as unknown as import('./structured-output.js').StructuredOutputError,
                    rawOutput: (error as unknown as { rawOutput: string }).rawOutput,
                };
            }

            // Unexpected error - re-throw
            throw error;
        }
    }

    /**
     * Stream structured output with partial validated objects.
     *
     * @template T The output type
     * @param config Schema configuration (JSON Schema + optional validator)
     * @param messages Chat messages to send
     * @param options Additional options (temperature, maxTokens, etc.)
     * @yields Partial validated objects as the JSON stream progresses
     * @returns Complete validated object on stream completion
     * @throws StructuredOutputError if final validation fails
     */
    async *generateStructuredStream<T>(
        config: SchemaConfig<T>,
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): AsyncGenerator<T, T, unknown> {
        // Get JSON Schema from config
        const jsonSchema = getJsonSchemaFromConfig(config);
        const schemaName = options?.schemaName ?? config.name ?? 'response';

        // Emit structured_request event
        this.auditor.record({
            timestamp: Date.now(),
            type: 'structured_request',
            provider: 'router',
            schemaName,
        });

        // Build ChatOptions with schema
        const structuredOptions: ChatOptions = {
            ...options,
            jsonSchema,
        };

        const start = Date.now();

        // Stream with failover
        const stream = this.executeStream(
            client => client.chatStream(messages, structuredOptions),
            'generateStructuredStream',
        );

        // Accumulate text and yield partial validated objects
        const parser = new StreamingJsonParser<T>(config);
        let fullContent = '';
        let lastYielded: T | undefined;

        try {
            for await (const event of stream) {
                // Only process text events
                if (event.type !== 'text') continue;

                fullContent += event.content;

                // Try to parse partial JSON
                const result = parser.feed(event.content);

                // Yield if we got a valid partial and it's different from last
                if (result.partial !== undefined) {
                    // Only yield if different from last (avoid duplicate yields)
                    if (lastYielded === undefined || JSON.stringify(result.partial) !== JSON.stringify(lastYielded)) {
                        lastYielded = result.partial;
                        yield result.partial;
                    }
                }
            }

            // Parse and validate the complete content
            const complete = parseStructured(config, fullContent);

            // Emit structured_response event on success
            this.auditor.record({
                timestamp: Date.now(),
                type: 'structured_response',
                provider: 'router',
                schemaName,
                duration: Date.now() - start,
            });

            // Return the complete validated object
            return complete;
        } catch (error) {
            // Emit structured_validation_error event
            this.auditor.record({
                timestamp: Date.now(),
                type: 'structured_validation_error',
                provider: 'router',
                schemaName,
                error: error instanceof Error ? error.message : 'Validation failed',
                rawOutput: fullContent,
            });
            throw error;
        }
    }

    // ========================================================================
    // Tool Registration (broadcast to all providers)
    // ========================================================================

    registerTool(
        name: string,
        description: string,
        parameters: import('./interfaces.js').LLMFunction['parameters'],
        handler: import('./interfaces.js').ToolHandler,
    ): void {
        for (const provider of this.providers) {
            provider.client.registerTool(name, description, parameters, handler);
        }
    }

    registerTools(
        tools: Array<{
            name: string;
            description: string;
            parameters: import('./interfaces.js').LLMFunction['parameters'];
            handler: import('./interfaces.js').ToolHandler;
        }>,
    ): void {
        for (const provider of this.providers) {
            provider.client.registerTools(tools);
        }
    }

    // ========================================================================
    // Health Management
    // ========================================================================

    private isAvailable(id: string): boolean {
        const h = this.health.get(id);
        if (!h) return false;
        if (h.healthy) return true;
        // Check if cooldown has expired
        if (h.cooldownUntil && Date.now() >= h.cooldownUntil) {
            // Reset for re-testing
            h.healthy = true;
            h.consecutiveFailures = 0;
            h.cooldownUntil = undefined;
            return true;
        }
        return false;
    }

    private getAvailableProviders(): ProviderEntry[] {
        return this.providers.filter(p => this.isAvailable(p.id));
    }

    // ========================================================================
    // Pool Selection (priority tiers, load, affinity, bounded queue)
    // ========================================================================

    /** Distinct priority values in ascending order — the tier iteration order. */
    private poolPriorities(): number[] {
        return [...new Set(this.providers.map(p => p.priority))].sort((a, b) => a - b);
    }

    private inflight(id: string): number {
        return this.metrics.get(id)?.inflight ?? 0;
    }

    private hasCapacity(p: ProviderEntry): boolean {
        return this.inflight(p.id) < (p.maxConcurrent ?? Infinity);
    }

    /**
     * FNV-1a 32-bit — rendezvous-hash score for (sessionKey, node). Stable per
     * pair, so each key gets a consistent node ranking that only shifts for
     * keys whose top node actually changed when membership changes.
     */
    private static affinityScore(sessionKey: string, nodeId: string): number {
        let h = 0x811c9dc5;
        const s = `${sessionKey} ${nodeId}`;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
    }

    /**
     * Nodes of one tier that are healthy and not yet tried, in dispatch-preference
     * order: session-affine ranking when a key is given, else least-inflight
     * (ties broken by declaration order, already priority-sorted).
     */
    private poolCandidates(priority: number, sessionKey: string | undefined, tried: Set<string>): ProviderEntry[] {
        const nodes = this.providers.filter(
            p => p.priority === priority && !tried.has(p.id) && this.isAvailable(p.id),
        );
        if (sessionKey && nodes.length > 1) {
            return [...nodes].sort(
                (a, b) => Router.affinityScore(sessionKey, b.id) - Router.affinityScore(sessionKey, a.id),
            );
        }
        return [...nodes].sort((a, b) => this.inflight(a.id) - this.inflight(b.id));
    }

    /**
     * Pick the node to dispatch to within one tier, or null to spill.
     * Returns immediately when a candidate has a free slot; when every
     * candidate is at its cap, waits (bounded by `spillAfterMs`) for a slot to
     * free anywhere and re-evaluates, then gives up (spill) at the deadline.
     */
    private async pickFromPool(
        priority: number,
        sessionKey: string | undefined,
        tried: Set<string>,
    ): Promise<ProviderEntry | null> {
        let candidates = this.poolCandidates(priority, sessionKey, tried);
        if (candidates.length === 0) return null;

        const withSlot = candidates.find(p => this.hasCapacity(p));
        if (withSlot) return withSlot;

        // Whole tier is at its concurrency caps — bounded queue, then spill.
        this.bumpPool(priority, 'queueWaits');
        const deadline = Date.now() + this.config.spillAfterMs;
        while (Date.now() < deadline) {
            const woke = await this.waitForSlot(deadline - Date.now());
            if (!woke) break;
            candidates = this.poolCandidates(priority, sessionKey, tried);
            if (candidates.length === 0) return null;
            const freed = candidates.find(p => this.hasCapacity(p));
            if (freed) return freed;
        }
        this.bumpPool(priority, 'spills');
        this.auditor.record({
            timestamp: Date.now(),
            type: 'failover',
            provider: `pool:${priority}`,
            metadata: {
                phase: 'spill',
                reason: `pool saturated for ${this.config.spillAfterMs}ms`,
                nodes: candidates.map(p => p.id),
            },
        });
        return null;
    }

    /** Cheap lookahead for failover audit events — next untried healthy node. */
    private peekNextCandidate(tried: Set<string>): ProviderEntry | undefined {
        return this.providers.find(p => !tried.has(p.id) && this.isAvailable(p.id));
    }

    private acquireSlot(id: string): void {
        const m = this.metrics.get(id);
        if (!m) return;
        m.inflight++;
        m.requests++;
    }

    private releaseSlot(id: string): void {
        const m = this.metrics.get(id);
        if (m && m.inflight > 0) m.inflight--;
        // Wake one queued request per freed slot; it re-checks capacity itself.
        const waiter = this.slotWaiters.shift();
        if (waiter) waiter();
    }

    /** Resolves true when a slot frees somewhere, false at the timeout. */
    private waitForSlot(ms: number): Promise<boolean> {
        if (ms <= 0) return Promise.resolve(false);
        return new Promise<boolean>(resolve => {
            const waiter = (): void => {
                clearTimeout(timer);
                resolve(true);
            };
            const timer = setTimeout(() => {
                const idx = this.slotWaiters.indexOf(waiter);
                if (idx >= 0) this.slotWaiters.splice(idx, 1);
                resolve(false);
            }, ms);
            this.slotWaiters.push(waiter);
        });
    }

    private bumpPool(priority: number, counter: keyof PoolMetrics): void {
        let pm = this.poolMetrics.get(priority);
        if (!pm) {
            pm = { spills: 0, queueWaits: 0 };
            this.poolMetrics.set(priority, pm);
        }
        pm[counter]++;
    }

    /**
     * Cold-node liveness preflight. A node with no success inside
     * `coldProbeAfterMs` gets a cheap `getModels()` probe raced against
     * `coldProbeTimeoutMs` before the real request commits to it — bounding
     * the SYN-blackhole case (powered-off host) to the probe budget instead
     * of the OS TCP retry stall. Only a TIMEOUT counts as dead: an error
     * reply (auth, not-found, refused) proves the host answers and defers to
     * the real dispatch. On timeout the node is failure-recorded with
     * cooldown so subsequent requests skip it without probing.
     */
    private async coldNodeAlive(provider: ProviderEntry, context: string): Promise<boolean> {
        if (this.config.coldProbeTimeoutMs <= 0) return true;
        const h = this.health.get(provider.id);
        if (Date.now() - (h?.lastSuccessAt ?? 0) < this.config.coldProbeAfterMs) return true;

        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
            provider.client.getModels().then(
                () => 'ok' as const,
                () => 'error' as const,
            ),
            new Promise<'timeout'>((resolve) => {
                timer = setTimeout(() => resolve('timeout'), this.config.coldProbeTimeoutMs);
            }),
        ]).finally(() => clearTimeout(timer));
        if (outcome !== 'timeout') return true;

        this.auditor.record({
            timestamp: Date.now(),
            type: 'error',
            provider: provider.id,
            model: provider.modelOverride ?? provider.client.model,
            error: `cold-node liveness probe timed out after ${this.config.coldProbeTimeoutMs}ms`,
            metadata: { context, probe: true, retryable: false },
        });
        this.recordFailure(provider.id, { cooldown: true });
        return false;
    }

    private recordSuccess(id: string, latencyMs?: number): void {
        const h = this.health.get(id);
        if (h) {
            h.healthy = true;
            h.consecutiveFailures = 0;
            h.cooldownUntil = undefined;
            h.lastSuccessAt = Date.now();
        }
        if (latencyMs !== undefined) {
            const m = this.metrics.get(id);
            if (m) {
                m.lastLatencyMs = latencyMs;
                m.avgLatencyMs = m.avgLatencyMs === undefined
                    ? latencyMs
                    : Math.round(m.avgLatencyMs * 0.8 + latencyMs * 0.2);
            }
        }
    }

    private recordFailure(id: string, opts?: { cooldown?: boolean }): void {
        const m = this.metrics.get(id);
        if (m) m.failures++;
        const h = this.health.get(id);
        if (!h) return;

        h.consecutiveFailures++;
        h.lastFailure = Date.now();

        // Cool down when the caller classified the failure as
        // provider-unavailable, OR once the consecutive-failure threshold trips.
        if (opts?.cooldown || h.consecutiveFailures >= this.config.maxFailures) {
            h.healthy = false;
            h.cooldownUntil = Date.now() + this.config.cooldownMs;
        }
    }
}
