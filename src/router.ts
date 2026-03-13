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
    zodToJsonSchema,
    parseStructured,
    StructuredOutputError,
    type StructuredOutputResult,
} from './structured-output.js';
import { z } from 'zod';

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
     * Validate that output and tools are not used together.
     * Throws an error if both are provided.
     */
    private validateOutputAndTools(options?: ChatOptions): void {
        if (options?.output && options?.tools && options.tools.length > 0) {
            throw new Error('output and tools cannot be used together. Structured output and tool calling are mutually exclusive.');
        }
    }

    /**
     * Extract schema from output options.
     */
    private getSchemaFromOutput<T>(output: OutputOptions<T>): { schema: z.ZodType<T>; name?: string; description?: string } | { jsonSchema: Record<string, unknown>; name?: string; description?: string } {
        if (output.schema) {
            return {
                schema: output.schema,
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

        // Build ChatOptions with schema for the provider
        // Remove output and tools (schema and tools are mutually exclusive)
        const { output: _, tools: __, ...restOptions } = options;
        const structuredOptions: ChatOptions = {
            ...restOptions,
            // Use jsonSchema for the provider
            jsonSchema: 'jsonSchema' in schemaInfo ? schemaInfo.jsonSchema : zodToJsonSchema(schemaInfo.schema),
            schemaName: schemaInfo.name,
            schemaDescription: schemaInfo.description,
        };

        // Get response from provider
        const response = await this.execute(
            client => client.chat(messages, structuredOptions),
            'chatWithStructuredOutput',
        );

        // Extract text content from response
        const content = typeof response.message.content === 'string'
            ? response.message.content
            : response.message.content
                .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
                .map(part => part.text)
                .join('');

        // Get the Zod schema for validation (use the one from output, or convert from jsonSchema)
        const zodSchema = 'schema' in schemaInfo ? schemaInfo.schema : null;

        if (!zodSchema) {
            // If we only have jsonSchema without a Zod schema, we can't validate
            // Return the parsed JSON without validation
            try {
                const structured = JSON.parse(content) as T;
                return {
                    ...response,
                    structured,
                };
            } catch {
                // JSON parse failed, but we don't have Zod schema to create proper error
                throw new StructuredOutputError(
                    `Failed to parse JSON: ${content}`,
                    { rawOutput: content },
                );
            }
        }

        // Parse and validate against Zod schema
        const validated = parseStructured(zodSchema, content);

        return {
            ...response,
            structured: validated,
        };
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
     * Validates the response against the provided Zod schema.
     * Throws StructuredOutputError on validation failure.
     *
     * @template T The type inferred from the Zod schema
     * @param schema Zod schema for validation
     * @param messages Chat messages to send
     * @param options Additional options (temperature, maxTokens, etc.)
     * @returns Validated structured output
     * @throws StructuredOutputError if validation fails
     */
    async generateStructured<T>(
        schema: z.ZodType<T>,
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): Promise<T> {
        // Convert Zod schema to JSON Schema for providers
        const jsonSchema = zodToJsonSchema(schema);

        // Build ChatOptions with schema
        const structuredOptions: ChatOptions = {
            ...options,
            jsonSchema,
        };

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

        // This will throw StructuredOutputError on failure
        return parseStructured(schema, content);
    }

    /**
     * Try to generate structured output, returning a result object instead of throwing.
     * Same as generateStructured but returns { ok: true, value } on success
     * and { ok: false, error, rawOutput } on failure.
     *
     * @template T The type inferred from the Zod schema
     * @param schema Zod schema for validation
     * @param messages Chat messages to send
     * @param options Additional options (temperature, maxTokens, etc.)
     * @returns StructuredOutputResult<T> - either success with value or failure with error
     */
    async tryParseStructured<T>(
        schema: z.ZodType<T>,
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): Promise<StructuredOutputResult<T>> {
        try {
            const value = await this.generateStructured(schema, messages, options);
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
