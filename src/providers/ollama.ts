/**
 * Universal LLM Client v3 — Ollama Provider
 *
 * Implements BaseLLMClient for Ollama's native API.
 * Supports chat, streaming (NDJSON), embeddings, model discovery,
 * context length detection via /api/show, and structured output.
 *
 * Structured Output Assertions:
 * - VAL-PROVIDER-OLLAMA-001: format parameter with JSON Schema
 * - VAL-PROVIDER-OLLAMA-003: Vision with base64 extraction alongside format
 * - VAL-PROVIDER-OLLAMA-004: format "json" vs schema modes
 */

import { BaseLLMClient } from '../client.js';
import { resolveThinking } from '../thinking.js';
import { httpRequest, httpStream, parseNDJSON, buildHeaders } from '../http.js';
import { StandardChatDecoder } from '../stream-decoder.js';
import {
    normalizeJsonSchema,
    getJsonSchemaFromConfig,
} from '../structured-output.js';
import { extractGemmaThoughtChannels } from '../gemma-channel.js';
import { LLMProviderError, extractProviderErrorMessage } from '../errors.js';
import type {
    LLMClientOptions,
    LLMChatMessage,
    LLMChatResponse,
    ChatOptions,
    ModelMetadata,
    OllamaResponse,
    OllamaModelInfo,
    LLMToolDefinition,
    LLMToolCall,
    TokenUsageInfo,
} from '../interfaces.js';
import type { DecodedEvent } from '../stream-decoder.js';
import type { Auditor } from '../auditor.js';

export class OllamaClient extends BaseLLMClient {
    constructor(options: LLMClientOptions, auditor?: Auditor) {
        super({
            ...options,
            url: (options.url || 'http://localhost:11434').replace(/\/+$/, ''),
        }, auditor);
    }

    // ========================================================================
    // Chat
    // ========================================================================

    async chat(
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): Promise<LLMChatResponse> {
        // Structured output and tools can now be used together.\n        // The provider sends both format and tools in the request.\n        // The Router handles skipping validation when the response contains tool calls.

        const url = `${this.options.url}/api/chat`;
        // Per-call model override (same endpoint/credentials), else the configured model.
        const model = options?.model ?? this.options.model;
        const tools = options?.tools ?? (Object.keys(this.toolRegistry).length > 0 ? this.getToolDefinitions() : undefined);

        const body: Record<string, unknown> = {
            model,
            messages: this.convertMessages(messages),
            stream: false,
            options: this.buildOllamaOptions(options),
        };
        this.hoistKeepAlive(body);

        if (tools?.length) {
            body['tools'] = this.convertToolsToOllama(tools);
        }

        // Enable native thinking by default — thinking models produce better
        // tool selections and reasoning when allowed to think before acting.
        // Ollama `think` is on/off (no levels); default on for thinking models.
        body['think'] = resolveThinking(options?.thinking, this.options.thinking)?.enabled ?? true;

        // Handle structured output via format parameter
        const schemaOptions = this.extractSchemaOptions(options);
        if (schemaOptions) {
            body['format'] = this.buildFormatParameter(schemaOptions);
        } else if (options?.responseFormat) {
            // Legacy json_object mode - map to Ollama's "json" format
            body['format'] = 'json';
        }

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'request',
            provider: 'ollama',
            model,
        });

        const response = await httpRequest<OllamaResponse>(url, {
            method: 'POST',
            headers: buildHeaders(this.options),
            body,
            timeout: this.options.timeout ?? 30000,
        });

        const data = response.data;

        // Ollama can answer HTTP 200 with a bare `{"error":"…"}` (quota/session
        // limit, bad request) instead of a completion. Fail hard so the Router's
        // failover engages — never let it flow through as the model's reply.
        const providerError = extractProviderErrorMessage(data);
        if (providerError) {
            throw new LLMProviderError('ollama', `Ollama error: ${providerError}`);
        }
        if (!data.message) {
            throw new LLMProviderError('ollama', `Ollama returned no message: ${JSON.stringify(data).slice(0, 300)}`);
        }

        const usage: TokenUsageInfo | undefined = (data.prompt_eval_count || data.eval_count)
            ? {
                inputTokens: data.prompt_eval_count ?? 0,
                outputTokens: data.eval_count ?? 0,
                totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
                // Ollama reports server-precise timing in nanoseconds.
                durationMs: data.total_duration ? data.total_duration / 1e6 : undefined,
                tokensPerSecond: data.eval_duration && data.eval_count
                    ? data.eval_count / (data.eval_duration / 1e9)
                    : undefined,
            }
            : undefined;

        // Normalize tool calls (Ollama sometimes omits IDs and empty args).
        const toolCalls = data.message.tool_calls?.map(tc => this.normalizeToolCall(tc));

        const gemmaContent = extractGemmaThoughtChannels(data.message.content || '');
        const reasoning = [data.message.thinking, gemmaContent.reasoning].filter(Boolean).join('\n\n') || undefined;

        const result: LLMChatResponse = {
            message: {
                role: 'assistant',
                content: gemmaContent.content,
                tool_calls: toolCalls,
            },
            finishReason: data.done_reason,
            reasoning,
            usage,
            provider: 'ollama',
        };

        this.auditor.record({
            timestamp: Date.now(),
            type: 'response',
            provider: 'ollama',
            model,
            duration: Date.now() - start,
            usage,
        });

        return result;
    }

    // ========================================================================
    // Streaming
    // ========================================================================

    async *chatStream(
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
        const url = `${this.options.url}/api/chat`;
        // Per-call model override (same endpoint/credentials), else the configured model.
        const model = options?.model ?? this.options.model;
        const tools = options?.tools ?? (Object.keys(this.toolRegistry).length > 0 ? this.getToolDefinitions() : undefined);

        const body: Record<string, unknown> = {
            model,
            messages: this.convertMessages(messages),
            stream: true,
            options: this.buildOllamaOptions(options),
        };
        this.hoistKeepAlive(body);

        if (tools?.length) {
            body['tools'] = this.convertToolsToOllama(tools);
        }

        // Ollama `think` is on/off (no levels); default on for thinking models.
        body['think'] = resolveThinking(options?.thinking, this.options.thinking)?.enabled ?? true;

        // Handle structured output via format parameter — same as chat(). Without
        // this, streaming structured output is unconstrained and the model can emit
        // malformed JSON that only fails at the final parse.
        const schemaOptions = this.extractSchemaOptions(options);
        if (schemaOptions) {
            body['format'] = this.buildFormatParameter(schemaOptions);
        } else if (options?.responseFormat) {
            // Legacy json_object mode - map to Ollama's "json" format
            body['format'] = 'json';
        }

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'stream_start',
            provider: 'ollama',
            model,
        });

        const decoderEvents: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(event => decoderEvents.push(event));
        let lastResponse: OllamaResponse | undefined;
        const streamedToolCalls: import('../interfaces.js').LLMToolCall[] = [];

        // Stream idle timeout: thinking models can pause for minutes between chunks.
        // Ensure at least 5 minutes regardless of the base request timeout.
        const streamTimeout = Math.max(this.options.timeout ?? 300000, 300000);

        const stream = httpStream(url, {
            method: 'POST',
            headers: buildHeaders(this.options),
            body,
            timeout: streamTimeout,
        });

        for await (const chunk of parseNDJSON<OllamaResponse>(stream)) {
            // A quota / session-limit error can arrive mid-stream as a 200 NDJSON
            // line carrying a bare `{"error":"…"}` (no `message`). Throw so the
            // Router fails over, rather than silently dropping it (empty reply)
            // or, worse, letting it surface as content.
            const streamError = extractProviderErrorMessage(chunk);
            if (streamError) {
                throw new LLMProviderError('ollama', `Ollama error: ${streamError}`);
            }

            lastResponse = chunk;

            if (chunk.message?.thinking) {
                decoder.pushReasoning(chunk.message.thinking);
                const pending = decoderEvents.splice(0);
                for (const event of pending) {
                    yield event;
                }
            }

            if (chunk.message?.content) {
                decoder.push(chunk.message.content);
                const pending = decoderEvents.splice(0);
                for (const event of pending) {
                    yield event;
                }
            }

            if (chunk.message?.tool_calls?.length) {
                const normalized = chunk.message.tool_calls.map(tc => this.normalizeToolCall(tc));
                streamedToolCalls.push(...normalized);
                yield { type: 'tool_call', calls: normalized };
            }
        }

        decoder.flush();
        const pending = decoderEvents.splice(0);
        for (const event of pending) {
            yield event;
        }

        const usage: TokenUsageInfo | undefined = lastResponse?.prompt_eval_count
            ? {
                inputTokens: lastResponse.prompt_eval_count ?? 0,
                outputTokens: lastResponse.eval_count ?? 0,
                totalTokens: (lastResponse.prompt_eval_count ?? 0) + (lastResponse.eval_count ?? 0),
                durationMs: lastResponse.total_duration ? lastResponse.total_duration / 1e6 : undefined,
                tokensPerSecond: lastResponse.eval_duration && lastResponse.eval_count
                    ? lastResponse.eval_count / (lastResponse.eval_duration / 1e9)
                    : undefined,
            }
            : undefined;

        this.auditor.record({
            timestamp: Date.now(),
            type: 'stream_end',
            provider: 'ollama',
            model,
            duration: Date.now() - start,
            usage,
        });

        return {
            message: {
                role: 'assistant',
                content: decoder.getCleanContent(),
                tool_calls: streamedToolCalls.length > 0 ? streamedToolCalls : undefined,
            },
            finishReason: lastResponse?.done_reason,
            reasoning: decoder.getReasoning(),
            usage,
            provider: 'ollama',
        };
    }

    private normalizeToolCall(
        toolCall: Partial<LLMToolCall> & { function?: Partial<LLMToolCall['function']> },
    ): LLMToolCall {
        return {
            ...toolCall,
            id: toolCall.id || this.generateToolCallId(),
            type: 'function',
            function: {
                ...toolCall.function,
                name: toolCall.function?.name || '',
                arguments: this.normalizeToolArguments(toolCall.function?.arguments),
            },
        };
    }

    private normalizeToolArguments(args: unknown): string {
        if (typeof args === 'string') {
            return args.trim().length > 0 ? args : '{}';
        }
        if (args == null) {
            return '{}';
        }
        return JSON.stringify(args) ?? '{}';
    }

    // ========================================================================
    // Embeddings
    // ========================================================================

    async embed(text: string): Promise<number[]> {
        const url = `${this.options.url}/api/embed`;
        const response = await httpRequest<{ embeddings: number[][] }>(url, {
            method: 'POST',
            headers: buildHeaders(this.options),
            body: { model: this.options.model, input: text },
            timeout: this.options.timeout ?? 30000,
        });
        return response.data.embeddings[0] ?? [];
    }

    override async embedArray(texts: string[]): Promise<number[][]> {
        const url = `${this.options.url}/api/embed`;
        const response = await httpRequest<{ embeddings: number[][] }>(url, {
            method: 'POST',
            headers: buildHeaders(this.options),
            body: { model: this.options.model, input: texts },
            timeout: this.options.timeout ?? 30000,
        });
        return response.data.embeddings;
    }

    // ========================================================================
    // Model Discovery
    // ========================================================================

    async getModels(): Promise<string[]> {
        const url = `${this.options.url}/api/tags`;
        const response = await httpRequest<{ models: OllamaModelInfo[] }>(url, {
            timeout: 5000,
        });
        return response.data.models.map(m => m.name);
    }

    override async getModelInfo(modelName?: string): Promise<ModelMetadata> {
        const url = `${this.options.url}/api/show`;
        try {
            const targetModel = modelName ?? this.options.model;
            const response = await httpRequest<Record<string, unknown>>(url, {
                method: 'POST',
                body: { name: targetModel },
                timeout: 5000,
            });

            const modelInfo = response.data['model_info'] as Record<string, unknown> | undefined;
            if (!modelInfo) return { contextLength: 8192 };

            // Extract architecture-specific context length
            const arch = modelInfo['general.architecture'] as string | undefined;
            let contextLength = 8192;

            if (arch) {
                const ctxKey = `${arch}.context_length`;
                const ctxValue = modelInfo[ctxKey] as number | undefined;
                if (ctxValue) contextLength = ctxValue;
            }

            // Prefer the live deployment context when available. /api/show reports
            // the trained maximum; /api/ps reports what the daemon has actually loaded.
            try {
                const psResponse = await httpRequest<{ models?: Array<{ name?: string; context_length?: number }> }>(
                    `${this.options.url}/api/ps`,
                    { timeout: 5000 },
                );
                const liveModel = psResponse.data.models?.find(
                    model => model.name?.toLowerCase() === targetModel.toLowerCase(),
                );
                if (liveModel?.context_length && liveModel.context_length > 0) {
                    contextLength = Math.min(contextLength, liveModel.context_length);
                }
            } catch {
                // Ignore /api/ps failures — /api/show is still a valid fallback
            }

            const paramCountRaw = modelInfo['general.parameter_count'] as number | undefined;
            const capabilities = response.data['capabilities'] as string[] | undefined;

            return {
                model: targetModel,
                contextLength,
                architecture: arch,
                parameterCount: paramCountRaw,
                capabilities,
            };
        } catch {
            return { contextLength: 8192 };
        }
    }

    // ========================================================================
    // Readiness
    // ========================================================================

    /** Ensure model is available, pull if missing */
    async ensureReady(): Promise<void> {
        try {
            await this.getModelInfo();
        } catch {
            // Try pulling the model
            this.debugLog(`Model not found, attempting pull: ${this.options.model}`);
            await httpRequest(`${this.options.url}/api/pull`, {
                method: 'POST',
                body: { name: this.options.model },
                timeout: 300000, // 5 min for pull
            });
        }
    }

    // ========================================================================
    // Internals
    // ========================================================================

    private convertMessages(messages: LLMChatMessage[]): Record<string, unknown>[] {
        return messages.map(msg => {
            const converted: Record<string, unknown> = { role: msg.role };

            // Handle multimodal content (array of text + image parts)
            if (Array.isArray(msg.content)) {
                const textParts: string[] = [];
                const images: string[] = [];

                for (const part of msg.content) {
                    if (part.type === 'text') {
                        textParts.push(part.text);
                    } else if (part.type === 'audio') {
                        this.debugLog('Ollama: skipping audio content (not supported)');
                    } else if (part.type === 'image_url' && part.image_url?.url) {
                        // Extract base64 data from data URL or use raw base64
                        const url = part.image_url.url;
                        if (url.startsWith('data:')) {
                            // data:image/jpeg;base64,XXXX → extract XXXX
                            const base64Data = url.split(',')[1];
                            if (base64Data) images.push(base64Data);
                        } else if (url.startsWith('http')) {
                            // Ollama doesn't support URLs directly — skip
                            // (caller should download and convert to base64)
                            this.debugLog('Ollama vision: skipping URL image, use base64 instead');
                        } else {
                            // Assume raw base64
                            images.push(url);
                        }
                    }
                }

                converted['content'] = textParts.join('\n');
                if (images.length > 0) {
                    converted['images'] = images;
                }
            } else {
                converted['content'] = msg.content ?? '';
            }

            // Ollama needs tool call arguments as objects, not strings
            if (msg.tool_calls?.length) {
                converted['tool_calls'] = msg.tool_calls.map(tc => ({
                    ...tc,
                    function: {
                        ...tc.function,
                        arguments: typeof tc.function.arguments === 'string'
                            ? (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })()
                            : tc.function.arguments,
                    },
                }));
            }

            // Preserve tool_call_id for tool result messages
            if (msg.tool_call_id) {
                converted['tool_call_id'] = msg.tool_call_id;
            }

            return converted;
        });
    }

    private convertToolsToOllama(tools: LLMToolDefinition[]): unknown[] {
        return tools.map(t => ({
            type: 'function',
            function: {
                name: t.function.name,
                description: t.function.description,
                parameters: t.function.parameters,
            },
        }));
    }

    /**
     * `keep_alive` is a TOP-LEVEL Ollama request field, not a sampling option —
     * left inside `options` it is silently ignored (models unload on the
     * server's default and pinning policies do nothing). Callers configure it
     * via defaultParameters/parameters like everything else; this hoists it out
     * of the built options onto the request body. Numeric strings ("-1", "300")
     * are coerced to numbers: Ollama parses bare numbers as seconds (negative =
     * keep forever) but REJECTS unit-less duration strings.
     */
    private hoistKeepAlive(body: Record<string, unknown>): void {
        const params = body['options'] as Record<string, unknown> | undefined;
        if (!params || params['keep_alive'] === undefined) return;
        const raw = params['keep_alive'];
        delete params['keep_alive'];
        body['keep_alive'] = typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
    }

    private buildOllamaOptions(options?: ChatOptions): Record<string, unknown> {
        const params: Record<string, unknown> = {
            ...this.options.defaultParameters,
            ...options?.parameters,
        };
        if (options?.temperature !== undefined) params['temperature'] = options.temperature;
        // Output cap: map the first-class maxTokens option to Ollama's
        // num_predict unless the caller already pinned num_predict via
        // defaultParameters/parameters (explicit params win).
        if (options?.maxTokens !== undefined && params['num_predict'] === undefined) {
            params['num_predict'] = options.maxTokens;
        }
        // Context window: Ollama defaults num_ctx to a small value (typically
        // 4096), silently truncating long agent prompts. Map the first-class
        // contextLength option unless the caller already pinned num_ctx via
        // defaultParameters/parameters (explicit params win).
        const contextLength = options?.contextLength ?? this.options.contextLength;
        if (contextLength !== undefined && params['num_ctx'] === undefined) {
            params['num_ctx'] = contextLength;
        }
        return params;
    }

    // ========================================================================
    // Structured Output Helpers
    // ========================================================================

    /**
     * Build Ollama format parameter from schema options.
     * Ollama accepts:
     * - format: "json" for simple JSON mode
     * - format: { ...schema } for structured output with JSON Schema
     */
    private buildFormatParameter(options: { schemaConfig?: import('../structured-output.js').SchemaConfig<unknown>, jsonSchema?: import('../structured-output.js').JSONSchema }): string | import('../structured-output.js').JSONSchema {
        if (options.jsonSchema) {
            return normalizeJsonSchema(options.jsonSchema);
        }

        if (options.schemaConfig) {
            return getJsonSchemaFromConfig(options.schemaConfig);
        }

        return 'json';
    }
}
