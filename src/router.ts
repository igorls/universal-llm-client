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
} from './interfaces.js';
import type { DecodedEvent } from './stream-decoder.js';

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

    async chat(messages: LLMChatMessage[], options?: ChatOptions): Promise<LLMChatResponse> {
        return this.execute(
            client => client.chat(messages, options),
            'chat',
        );
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
