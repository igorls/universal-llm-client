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
import { httpRequest, httpStream, parseNDJSON, buildHeaders } from '../http.js';
import { StandardChatDecoder } from '../stream-decoder.js';
import {
    zodToJsonSchema,
    normalizeJsonSchema,
} from '../structured-output.js';
import type {
    LLMClientOptions,
    LLMChatMessage,
    LLMChatResponse,
    ChatOptions,
    ModelMetadata,
    OllamaResponse,
    OllamaModelInfo,
    LLMToolDefinition,
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
        const tools = options?.tools ?? (Object.keys(this.toolRegistry).length > 0 ? this.getToolDefinitions() : undefined);

        const body: Record<string, unknown> = {
            model: this.options.model,
            messages: this.convertMessages(messages),
            stream: false,
            options: this.buildOllamaOptions(options),
        };

        if (tools?.length) {
            body['tools'] = this.convertToolsToOllama(tools);
        }

        // Always send think parameter — Ollama uses a pointer type,
        // so omitting it means "use model default" (which for qwen3.5 is to think).
        // We must explicitly send false to suppress thinking.
        body['think'] = this.options.thinking ?? false;

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
            model: this.options.model,
        });

        const response = await httpRequest<OllamaResponse>(url, {
            method: 'POST',
            headers: buildHeaders(this.options),
            body,
            timeout: this.options.timeout ?? 30000,
        });

        const data = response.data;
        const usage: TokenUsageInfo | undefined = (data.prompt_eval_count || data.eval_count)
            ? {
                inputTokens: data.prompt_eval_count ?? 0,
                outputTokens: data.eval_count ?? 0,
                totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
            }
            : undefined;

        // Normalize tool call IDs (Ollama sometimes omits them)
        const toolCalls = data.message.tool_calls?.map(tc => ({
            ...tc,
            id: tc.id || this.generateToolCallId(),
            function: {
                ...tc.function,
                arguments: typeof tc.function.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function.arguments),
            },
        }));

        // Get content, handling potential null
        const content = data.message.content || data.message.thinking || '';

        const result: LLMChatResponse = {
            message: {
                role: 'assistant',
                content,
                tool_calls: toolCalls,
            },
            reasoning: data.message.content ? data.message.thinking : undefined,
            usage,
            provider: 'ollama',
        };

        this.auditor.record({
            timestamp: Date.now(),
            type: 'response',
            provider: 'ollama',
            model: this.options.model,
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
        const tools = options?.tools ?? (Object.keys(this.toolRegistry).length > 0 ? this.getToolDefinitions() : undefined);

        const body: Record<string, unknown> = {
            model: this.options.model,
            messages: this.convertMessages(messages),
            stream: true,
            options: this.buildOllamaOptions(options),
        };

        if (tools?.length) {
            body['tools'] = this.convertToolsToOllama(tools);
        }

        body['think'] = this.options.thinking ?? false;

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'stream_start',
            provider: 'ollama',
            model: this.options.model,
        });

        const decoder = new StandardChatDecoder(() => {});
        let lastResponse: OllamaResponse | undefined;

        const stream = httpStream(url, {
            method: 'POST',
            headers: buildHeaders(this.options),
            body,
            timeout: this.options.timeout ?? 120000,
        });

        for await (const chunk of parseNDJSON<OllamaResponse>(stream)) {
            lastResponse = chunk;

            if (chunk.message?.thinking) {
                decoder.pushReasoning(chunk.message.thinking);
                yield { type: 'thinking', content: chunk.message.thinking };
            }

            if (chunk.message?.content) {
                decoder.push(chunk.message.content);
                yield { type: 'text', content: chunk.message.content };
            }

            if (chunk.message?.tool_calls?.length) {
                const normalized = chunk.message.tool_calls.map(tc => ({
                    ...tc,
                    id: tc.id || this.generateToolCallId(),
                    function: {
                        ...tc.function,
                        arguments: typeof tc.function.arguments === 'string'
                            ? tc.function.arguments
                            : JSON.stringify(tc.function.arguments),
                    },
                }));
                yield { type: 'tool_call', calls: normalized };
            }
        }

        decoder.flush();

        const usage: TokenUsageInfo | undefined = lastResponse?.prompt_eval_count
            ? {
                inputTokens: lastResponse.prompt_eval_count ?? 0,
                outputTokens: lastResponse.eval_count ?? 0,
                totalTokens: (lastResponse.prompt_eval_count ?? 0) + (lastResponse.eval_count ?? 0),
            }
            : undefined;

        this.auditor.record({
            timestamp: Date.now(),
            type: 'stream_end',
            provider: 'ollama',
            model: this.options.model,
            duration: Date.now() - start,
            usage,
        });

        return {
            message: {
                role: 'assistant',
                content: decoder.getCleanContent(),
            },
            reasoning: decoder.getReasoning(),
            usage,
            provider: 'ollama',
        };
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
            const response = await httpRequest<Record<string, unknown>>(url, {
                method: 'POST',
                body: { name: modelName ?? this.options.model },
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

            const paramCountRaw = modelInfo['general.parameter_count'] as number | undefined;

            return {
                model: modelName ?? this.options.model,
                contextLength,
                architecture: arch,
                parameterCount: paramCountRaw,
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

    private buildOllamaOptions(options?: ChatOptions): Record<string, unknown> {
        const params: Record<string, unknown> = {
            ...this.options.defaultParameters,
            ...options?.parameters,
        };
        if (options?.temperature !== undefined) params['temperature'] = options.temperature;
        if (options?.maxTokens !== undefined) params['num_predict'] = options.maxTokens;
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
    private buildFormatParameter(options: import('../interfaces.js').ChatOptions): string | import('../structured-output.js').JSONSchema {
        if (options.jsonSchema) {
            return normalizeJsonSchema(options.jsonSchema);
        }

        if (options.schema) {
            return zodToJsonSchema(options.schema);
        }

        return 'json';
    }
}
