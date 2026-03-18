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
    /** Priority (lower = tried first, defaults to insertion order) */
    priority: number;
    /** Override model name for this provider */
    modelOverride?: string;
}

interface ProviderHealth {
    healthy: boolean;
    consecutiveFailures: number;
    lastFailure?: number;
    cooldownUntil?: number;
}

export interface RouterConfig {
    /** Max retries per provider before failover (default: 2) */
    retriesPerProvider?: number;
    /** Max consecutive failures before marking unhealthy (default: 3) */
    maxFailures?: number;
    /** Cooldown period in ms for unhealthy providers (default: 30000) */
    cooldownMs?: number;
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
}

// ============================================================================
// Router
// ============================================================================

export class Router {
    private providers: ProviderEntry[] = [];
    private health: Map<string, ProviderHealth> = new Map();
    private auditor: Auditor;
    private config: Required<Omit<RouterConfig, 'auditor'>>;

    constructor(config: RouterConfig = {}) {
        this.auditor = config.auditor ?? new NoopAuditor();
        this.config = {
            retriesPerProvider: config.retriesPerProvider ?? 2,
            maxFailures: config.maxFailures ?? 3,
            cooldownMs: config.cooldownMs ?? 30000,
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
        // Re-sort by priority
        this.providers.sort((a, b) => a.priority - b.priority);
    }

    removeProvider(id: string): void {
        this.providers = this.providers.filter(p => p.id !== id);
        this.health.delete(id);
    }

    setAuditor(auditor: Auditor): void {
        this.auditor = auditor;
    }

    getStatus(): ProviderStatus[] {
        return this.providers.map(p => ({
            id: p.id,
            healthy: this.isAvailable(p.id),
            active: true,
            consecutiveFailures: this.health.get(p.id)?.consecutiveFailures ?? 0,
            cooldownUntil: this.health.get(p.id)?.cooldownUntil,
            model: p.modelOverride ?? p.client.model,
        }));
    }

    // ========================================================================
    // Execution with Failover
    // ========================================================================

    /**
     * Execute a function against providers with automatic failover.
     * Tries each available provider in priority order.
     */
    async execute<T>(
        fn: (client: BaseLLMClient) => Promise<T>,
        context: string = 'execute',
    ): Promise<T> {
        const available = this.getAvailableProviders();

        if (available.length === 0) {
            throw new Error('No available LLM providers. All providers are unhealthy or in cooldown.');
        }

        let lastError: Error | undefined;

        for (const provider of available) {
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
                    this.recordSuccess(provider.id);
                    return result;
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                    this.auditor.record({
                        timestamp: Date.now(),
                        type: 'error',
                        provider: provider.id,
                        model: provider.modelOverride ?? provider.client.model,
                        error: lastError.message,
                        metadata: { attempt, context },
                    });
                }
            }

            // All retries exhausted for this provider
            this.recordFailure(provider.id);

            // Try next provider (failover)
            const nextProvider = this.getNextAvailableAfter(provider.id);
            if (nextProvider) {
                this.auditor.record({
                    timestamp: Date.now(),
                    type: 'failover',
                    provider: provider.id,
                    metadata: {
                        from: provider.id,
                        nextProvider: nextProvider.id,
                        context,
                        reason: lastError?.message,
                    },
                });
            }
        }

        throw lastError ?? new Error('All providers failed');
    }

    /**
     * Execute a streaming function with failover.
     * On failure, retries with the next provider from the beginning.
     */
    async *executeStream(
        fn: (client: BaseLLMClient) => AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>,
        context: string = 'stream',
    ): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
        const available = this.getAvailableProviders();

        if (available.length === 0) {
            throw new Error('No available LLM providers for streaming.');
        }

        let lastError: Error | undefined;

        for (const provider of available) {
            try {
                const stream = fn(provider.client);
                let returnValue: LLMChatResponse | void;

                // We need to yield all values and capture the return
                while (true) {
                    const result = await stream.next();
                    if (result.done) {
                        returnValue = result.value;
                        break;
                    }
                    yield result.value;
                }

                this.recordSuccess(provider.id);
                return returnValue;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                this.recordFailure(provider.id);

                this.auditor.record({
                    timestamp: Date.now(),
                    type: 'failover',
                    provider: provider.id,
                    error: lastError.message,
                    metadata: { context },
                });

                // Continue to next provider
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

    private getNextAvailableAfter(currentId: string): ProviderEntry | undefined {
        const idx = this.providers.findIndex(p => p.id === currentId);
        for (let i = idx + 1; i < this.providers.length; i++) {
            if (this.isAvailable(this.providers[i]!.id)) {
                return this.providers[i];
            }
        }
        return undefined;
    }

    private recordSuccess(id: string): void {
        const h = this.health.get(id);
        if (h) {
            h.healthy = true;
            h.consecutiveFailures = 0;
            h.cooldownUntil = undefined;
        }
    }

    private recordFailure(id: string): void {
        const h = this.health.get(id);
        if (!h) return;

        h.consecutiveFailures++;
        h.lastFailure = Date.now();

        if (h.consecutiveFailures >= this.config.maxFailures) {
            h.healthy = false;
            h.cooldownUntil = Date.now() + this.config.cooldownMs;
        }
    }
}
