/**
 * Universal LLM Client v3 — AIModel (The Universal Client)
 *
 * The only public-facing class. Developers configure one model with
 * multiple provider backends for transparent failover.
 *
 * Provider classes are internal — the user never imports them.
 */

import {
    AIModelApiType,
    type AIModelConfig,
    type ProviderConfig,
    type LLMClientOptions,
    type LLMChatMessage,
    type LLMChatResponse,
    type ChatOptions,
    type ModelMetadata,
    type LLMFunction,
    type ToolHandler,
} from './interfaces.js';
import type { DecodedEvent } from './stream-decoder.js';
import { Router, type RouterConfig, type ProviderStatus } from './router.js';
import type { Auditor } from './auditor.js';
import { NoopAuditor } from './auditor.js';
import { OllamaClient } from './providers/ollama.js';
import { OpenAICompatibleClient } from './providers/openai.js';
import { GoogleClient } from './providers/google.js';
import { BaseLLMClient } from './client.js';
import {
    type StructuredOutputResult,
    type SchemaConfig,
} from './structured-output.js';

// ============================================================================
// Default Provider URLs
// ============================================================================

const DEFAULT_URLS: Record<string, string> = {
    ollama: 'http://localhost:11434',
    openai: 'https://api.openai.com',
    llamacpp: 'http://localhost:8080',
    // google and vertex build their own URLs internally
};

// ============================================================================
// AIModel — The Universal Client
// ============================================================================

export class AIModel {
    private router: Router;
    private auditor: Auditor;
    private config: AIModelConfig;

    constructor(config: AIModelConfig) {
        this.config = config;
        this.auditor = config.auditor ?? new NoopAuditor();

        const routerConfig: RouterConfig = {
            retriesPerProvider: config.retries ?? 2,
            auditor: this.auditor,
        };
        this.router = new Router(routerConfig);

        // Initialize providers in order
        for (let i = 0; i < config.providers.length; i++) {
            const providerConfig = config.providers[i]!;
            const client = this.createClient(providerConfig);
            const id = `${this.normalizeType(providerConfig.type)}-${i}`;

            this.router.addProvider({
                id,
                client,
                priority: providerConfig.priority ?? i,
                modelOverride: providerConfig.model,
            });
        }
    }

    // ========================================================================
    // Chat
    // ========================================================================

    /** Send a chat request with automatic failover across providers */
    async chat(
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): Promise<LLMChatResponse> {
        return this.router.chat(messages, options);
    }

    /** Chat with automatic tool execution (multi-turn loop) */
    async chatWithTools(
        messages: LLMChatMessage[],
        options?: ChatOptions & { maxIterations?: number },
    ): Promise<LLMChatResponse> {
        return this.router.chatWithTools(messages, options);
    }

    /** Stream chat response with pluggable decoder strategy */
    async *chatStream(
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
        return yield* this.router.chatStream(messages, options);
    }

    // ========================================================================
    // Structured Output
    // ========================================================================

    /**
     * Generate structured output from the LLM with automatic failover.
     * Validates the response against the provided Zod schema.
     * Throws StructuredOutputError on validation failure.
     *
     * @template T The output type
     * @param config Schema configuration (JSON Schema + optional validator)
     * @param messages Chat messages to send
     * @param options Additional options (temperature, maxTokens, etc.)
     * @returns Promise resolving to validated structured output
     * @throws StructuredOutputError if JSON parsing fails or validation fails
     *
     * @example
     * ```typescript
     * import { fromZod } from 'universal-llm-client/zod';
     * const UserConfig = fromZod(z.object({
     *   name: z.string(),
     *   age: z.number(),
     * }));
     *
     * const user = await model.generateStructured(UserConfig, [
     *   { role: 'user', content: 'Generate a user profile' },
     * ]);
     * // user.name: string, user.age: number
     * ```
     */
    async generateStructured<T>(
        config: SchemaConfig<T>,
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): Promise<T> {
        return this.router.generateStructured(config, messages, options);
    }

    /**
     * Try to generate structured output, returning a result object instead of throwing.
     * Same as generateStructured but returns { ok: true, value } on success
     * and { ok: false, error, rawOutput } on failure.
     *
     * @template T The output type
     * @param config Schema configuration (JSON Schema + optional validator)
     * @param messages Chat messages to send
     * @param options Additional options (temperature, maxTokens, etc.)
     * @returns StructuredOutputResult<T> - either success with value or failure with error
     *
     * @example
     * ```typescript
     * const result = await model.tryParseStructured(config, messages);
     *
     * if (result.ok) {
     *   console.log('User:', result.value.name);
     * } else {
     *   console.log('Error:', result.error.message);
     *   console.log('Raw output:', result.rawOutput);
     * }
     * ```
     */
    async tryParseStructured<T>(
        config: SchemaConfig<T>,
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): Promise<StructuredOutputResult<T>> {
        return this.router.tryParseStructured(config, messages, options);
    }

    /**
     * Stream structured output with partial validated objects.
     *
     * Yields partial validated objects as JSON generates, then returns the
     * complete validated object on stream completion.
     *
     * For invalid partial JSON, no yield occurs (partial validation is best-effort).
     * On stream completion, if the final JSON fails validation, throws StructuredOutputError.
     *
     * @template T The output type
     * @param config Schema configuration (JSON Schema + optional validator)
     * @param messages Chat messages to send
     * @param options Additional options (temperature, maxTokens, etc.)
     * @yields Partial validated objects as the JSON stream progresses
     * @returns Complete validated object on stream completion
     * @throws StructuredOutputError if final validation fails
     *
     * @example
     * ```typescript
     * import { fromZod } from 'universal-llm-client/zod';
     * const UserConfig = fromZod(z.object({
     *   name: z.string(),
     *   age: z.number(),
     * }));
     *
     * const stream = model.generateStructuredStream(UserConfig, [
     *   { role: 'user', content: 'Generate a user' },
     * ]);
     *
     * for await (const partial of stream) {
     *   console.log('Partial user:', partial);
     * }
     * ```
     */
    async *generateStructuredStream<T>(
        config: SchemaConfig<T>,
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): AsyncGenerator<T, T, unknown> {
        return yield* this.router.generateStructuredStream(config, messages, options);
    }

    // ========================================================================
    // Embeddings
    // ========================================================================

    /** Generate embedding for a single text */
    async embed(text: string): Promise<number[]> {
        return this.router.embed(text);
    }

    /** Generate embeddings for multiple texts */
    async embedArray(texts: string[]): Promise<number[][]> {
        return this.router.embedArray(texts);
    }

    // ========================================================================
    // Tool Registration
    // ========================================================================

    /** Register a tool callable by the LLM (broadcast to all providers) */
    registerTool(
        name: string,
        description: string,
        parameters: LLMFunction['parameters'],
        handler: ToolHandler,
    ): void {
        this.router.registerTool(name, description, parameters, handler);
    }

    /** Register multiple tools at once */
    registerTools(
        tools: Array<{
            name: string;
            description: string;
            parameters: LLMFunction['parameters'];
            handler: ToolHandler;
        }>,
    ): void {
        this.router.registerTools(tools);
    }

    // ========================================================================
    // Model Management
    // ========================================================================

    /** Get available models from all configured providers */
    async getModels(): Promise<string[]> {
        return this.router.getModels();
    }

    /** Get metadata about the current model (context length, capabilities) */
    async getModelInfo(): Promise<ModelMetadata> {
        return this.router.getModelInfo();
    }

    /** Switch model at runtime (updates all providers) */
    setModel(name: string): void {
        this.config.model = name;
        // The model name change will be picked up by the providers
        // through the router on next request
    }

    /** Get the current model name */
    get model(): string {
        return this.config.model;
    }

    // ========================================================================
    // Provider Status
    // ========================================================================

    /** Get health/status of all configured providers */
    getProviderStatus(): ProviderStatus[] {
        return this.router.getStatus();
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /** Clean shutdown — flush auditor, disconnect MCP, etc. */
    async dispose(): Promise<void> {
        await this.auditor.flush?.();
    }

    // ========================================================================
    // Internal: Provider Factory
    // ========================================================================

    private createClient(providerConfig: ProviderConfig): BaseLLMClient {
        const type = this.normalizeType(providerConfig.type);
        const modelName = providerConfig.model ?? this.config.model;

        const clientOptions: LLMClientOptions = {
            model: modelName,
            url: providerConfig.url ?? DEFAULT_URLS[type] ?? '',
            apiType: type as AIModelApiType,
            apiKey: providerConfig.apiKey,
            timeout: this.config.timeout ?? 30000,
            retries: this.config.retries ?? 2,
            debug: this.config.debug ?? false,
            defaultParameters: this.config.defaultParameters,
            thinking: this.config.thinking ?? false,
            region: providerConfig.region,
            apiVersion: providerConfig.apiVersion,
        };

        switch (type) {
            case 'ollama':
                return new OllamaClient(clientOptions, this.auditor);

            case 'openai':
            case 'llamacpp':
                return new OpenAICompatibleClient(clientOptions, this.auditor);

            case 'google':
            case 'vertex':
                return new GoogleClient(clientOptions, this.auditor);

            default:
                throw new Error(`Unknown provider type: ${type}`);
        }
    }

    private normalizeType(type: string): string {
        return type.toLowerCase();
    }
}
