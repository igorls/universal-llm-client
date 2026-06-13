/**
 * Universal LLM Client v3 — OpenAI-Compatible Provider
 *
 * Implements BaseLLMClient for OpenAI-compatible APIs.
 * Works with: OpenAI, OpenRouter, LM Studio, LlamaCpp, vLLM, Groq, Together.
 */

import { BaseLLMClient } from '../client.js';
import { resolveThinking, isOpenAIReasoningModel } from '../thinking.js';
import { httpRequest, httpStream, parseSSE, buildHeaders } from '../http.js';
import { StandardChatDecoder } from '../stream-decoder.js';
import {
    normalizeJsonSchema,
    getJsonSchemaFromConfig,
    type JSONSchema,
    type StructuredOutputOptions,
} from '../structured-output.js';
import type {
    LLMClientOptions,
    LLMChatMessage,
    LLMChatResponse,
    ChatOptions,
    OpenAIResponse,
    OpenAIModelInfo,
    LLMToolCall,
    TokenUsageInfo,
} from '../interfaces.js';
import type { DecodedEvent } from '../stream-decoder.js';
import type { Auditor } from '../auditor.js';
import { isGemmaDiffusionModel, parseGemmaDiffusionOutput } from '../gemma-diffusion.js';

export class OpenAICompatibleClient extends BaseLLMClient {
    /**
     * DiffusionGemma on trimmed vLLM builds has no server-side reasoning or
     * tool-call parser — the native channel protocol is handled client-side
     * (see gemma-diffusion.ts). Auto-detected from the model name; override
     * with `gemmaNativeProtocol` in LLMClientOptions.
     */
    private get gemmaNative(): boolean {
        return this.options.gemmaNativeProtocol ?? isGemmaDiffusionModel(this.options.model);
    }

    /**
     * Build a full endpoint URL, respecting apiBasePath (already baked into this.options.url)
     * and any queryParams provided at the provider config level.
     */
    private buildUrl(suffix: string): string {
        const base = this.options.url.replace(/\/+$/, '');
        const path = suffix.startsWith('/') ? suffix : '/' + suffix;
        let full = base + path;

        const qp = this.options.queryParams;
        if (qp && Object.keys(qp).length > 0) {
            const search = new URLSearchParams();
            for (const [k, v] of Object.entries(qp)) {
                if (v != null) search.append(k, String(v));
            }
            const qs = search.toString();
            if (qs) {
                full += (full.includes('?') ? '&' : '?') + qs;
            }
        }
        return full;
    }

    constructor(options: LLMClientOptions, auditor?: Auditor) {
        let base = (options.url || 'https://api.openai.com').replace(/\/+$/, '');

        // Respect apiBasePath (from ProviderConfig.apiBasePath). Default "/v1" for broad compatibility.
        // Set apiBasePath: '' (or '/') when you are supplying a *complete* path already
        // (e.g. full Azure ".../deployments/my-model" URL) or for non-/v1 OpenAI-compatible servers.
        const desired = options.apiBasePath;
        const shouldAppend = desired !== '' && desired !== '/';

        if (shouldAppend) {
            const basePath = (desired || '/v1')
                .replace(/^\/?/, '/')
                .replace(/\/+$/, '');
            if (!base.endsWith(basePath)) {
                base += basePath;
            }
        }

        super({ ...options, url: base }, auditor);
    }

    // ========================================================================
    // Chat
    // ========================================================================

    async chat(
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): Promise<LLMChatResponse> {
        // Structured output and tools can now be used together.\n        // The provider sends both response_format and tools in the request.\n        // The Router handles skipping validation when the response contains tool calls.

        const url = this.buildUrl('/chat/completions');
        const tools = options?.tools ?? (Object.keys(this.toolRegistry).length > 0 ? this.getToolDefinitions() : undefined);

        const body: Record<string, unknown> = {
            model: this.options.model,
            messages: this.convertMessages(messages),
            ...this.buildRequestParams(options),
        };

        // Handle structured output
        const schemaOptions = this.extractSchemaOptions(options);
        if (schemaOptions) {
            body['response_format'] = this.buildResponseFormat(schemaOptions);
        } else if (options?.responseFormat) {
            body['response_format'] = options.responseFormat;
        }

        if (tools?.length) {
            body['tools'] = tools;
            if (options?.toolChoice) {
                body['tool_choice'] = options.toolChoice;
            }
        }

        if (this.gemmaNative) {
            // Markers must survive decoding for client-side parsing,
            // and request-level tool parsing is unavailable server-side.
            body['skip_special_tokens'] = false;
            if (tools?.length) body['tool_choice'] = 'none';
        }

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'request',
            provider: 'openai',
            model: this.options.model,
        });

        const response = await httpRequest<OpenAIResponse>(url, {
            method: 'POST',
            headers: buildHeaders(this.options),
            body,
            timeout: this.options.timeout ?? 30000,
        });

        const data = response.data;
        const choice = data.choices[0];

        if (!choice) {
            throw new Error('No choices returned from OpenAI API');
        }

        // vLLM / OpenAI-compatible `usage` carries no timing, so derive decode
        // throughput from the client-measured wall-clock duration.
        const durationMs = Date.now() - start;
        const usage: TokenUsageInfo | undefined = data.usage
            ? {
                inputTokens: data.usage.prompt_tokens,
                outputTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
                cachedTokens: data.usage.prompt_tokens_details?.cached_tokens,
                durationMs,
                tokensPerSecond: durationMs > 0
                    ? data.usage.completion_tokens / (durationMs / 1000)
                    : undefined,
            }
            : undefined;

        // Normalize tool calls (ensure IDs and JSON-parseable empty args exist).
        let toolCalls = choice.message.tool_calls?.map(tc => this.normalizeToolCall(tc));

        // Get content, handling null case
        let content = choice.message.content || '';
        let reasoning: string | undefined;

        // Reasoning models served over the OpenAI-compatible API (vLLM
        // `--reasoning-parser`, DeepSeek-R1, etc.) return the chain-of-thought
        // in a dedicated field instead of inline <think> tags. vLLM uses
        // `reasoning_content`; some gateways use `reasoning`.
        const serverReasoning = choice.message.reasoning ?? choice.message.reasoning_content;
        if (typeof serverReasoning === 'string' && serverReasoning.length > 0) {
            reasoning = serverReasoning;
        }

        if (this.gemmaNative && content) {
            const parsed = parseGemmaDiffusionOutput(content);
            content = parsed.content;
            if (parsed.reasoning) reasoning = parsed.reasoning;
            if (!toolCalls?.length && parsed.toolCalls.length) {
                toolCalls = parsed.toolCalls.map(tc => ({
                    id: this.generateToolCallId(),
                    type: 'function' as const,
                    function: { name: tc.name, arguments: tc.argumentsJson },
                }));
            }
        }

        const result: LLMChatResponse = {
            message: {
                role: 'assistant',
                content,
                tool_calls: toolCalls,
            },
            ...(reasoning !== undefined && { reasoning }),
            usage,
            provider: 'openai',
        };

        this.auditor.record({
            timestamp: Date.now(),
            type: 'response',
            provider: 'openai',
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
        const url = this.buildUrl('/chat/completions');
        const tools = options?.tools ?? (Object.keys(this.toolRegistry).length > 0 ? this.getToolDefinitions() : undefined);

        const body: Record<string, unknown> = {
            model: this.options.model,
            messages: this.convertMessages(messages),
            stream: true,
            ...this.buildRequestParams(options),
        };

        if (tools?.length) {
            body['tools'] = tools;
            if (options?.toolChoice) {
                body['tool_choice'] = options.toolChoice;
            }
        }

        if (this.gemmaNative) {
            body['skip_special_tokens'] = false;
            if (tools?.length) body['tool_choice'] = 'none';
        }

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'stream_start',
            provider: 'openai',
            model: this.options.model,
        });

        // In gemma-native mode the decoder classifies thought-channel content,
        // so we yield ITS events (thinking vs text) instead of the raw deltas.
        const decoderEvents: DecodedEvent[] = [];
        const decoder = new StandardChatDecoder(
            this.gemmaNative ? e => decoderEvents.push(e) : () => {},
        );

        // Track accumulated tool calls across chunks
        const toolCallAccum: Map<number, {
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
        }> = new Map();

        const stream = httpStream(url, {
            method: 'POST',
            headers: buildHeaders(this.options),
            body,
            timeout: this.options.timeout ?? 120000,
        });

        let usage: TokenUsageInfo | undefined;
        // Accumulates reasoning deltas from servers that stream a dedicated
        // `reasoning` / `reasoning_content` field (vLLM, DeepSeek-R1, etc.).
        let reasoningBuffer = '';

        for await (const { data } of parseSSE(stream)) {
            try {
                const parsed = JSON.parse(data) as {
                    choices?: Array<{
                        delta?: {
                            content?: string;
                            // Reasoning-model chain-of-thought deltas (vLLM
                            // `--reasoning-parser`, DeepSeek-R1, etc.).
                            reasoning?: string;
                            reasoning_content?: string;
                            tool_calls?: Array<{
                                index: number;
                                id?: string;
                                type?: string;
                                function?: { name?: string; arguments?: string };
                            }>;
                        };
                        finish_reason?: string;
                    }>;
                    usage?: {
                        prompt_tokens: number;
                        completion_tokens: number;
                        total_tokens: number;
                        prompt_tokens_details?: {
                            cached_tokens?: number;
                        };
                    };
                };

                if (parsed.usage) {
                    usage = {
                        inputTokens: parsed.usage.prompt_tokens,
                        outputTokens: parsed.usage.completion_tokens,
                        totalTokens: parsed.usage.total_tokens,
                        cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens,
                    };
                }

                const delta = parsed.choices?.[0]?.delta;
                if (!delta) continue;

                // Surface server-side reasoning deltas as thinking events.
                const reasoningDelta = delta.reasoning ?? delta.reasoning_content;
                if (reasoningDelta) {
                    reasoningBuffer += reasoningDelta;
                    yield { type: 'thinking', content: reasoningDelta };
                }

                if (delta.content) {
                    decoder.push(delta.content);
                    if (this.gemmaNative) {
                        while (decoderEvents.length) yield decoderEvents.shift()!;
                    } else {
                        yield { type: 'text', content: delta.content };
                    }
                }

                // Accumulate streamed tool calls
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const existing = toolCallAccum.get(tc.index);
                        if (!existing) {
                            toolCallAccum.set(tc.index, {
                                id: tc.id || this.generateToolCallId(),
                                type: 'function',
                                function: {
                                    name: tc.function?.name || '',
                                    arguments: tc.function?.arguments || '',
                                },
                            });
                        } else {
                            if (tc.function?.arguments) {
                                existing.function.arguments += tc.function.arguments;
                            }
                            if (tc.function?.name) {
                                existing.function.name += tc.function.name;
                            }
                        }
                    }
                }

                // Emit tool calls when stream finishes
                if (parsed.choices?.[0]?.finish_reason === 'tool_calls' || parsed.choices?.[0]?.finish_reason === 'stop') {
                    if (toolCallAccum.size > 0) {
                        const calls = Array.from(toolCallAccum.values())
                            .map(tc => this.normalizeToolCall(tc));
                        yield { type: 'tool_call', calls };
                    }
                }
            } catch {
                // Skip unparseable SSE data
            }
        }

        decoder.flush();
        if (this.gemmaNative) {
            while (decoderEvents.length) yield decoderEvents.shift()!;
        }

        // Augment usage with client-measured timing (vLLM streams no timing).
        if (usage) {
            const durationMs = Date.now() - start;
            usage = {
                ...usage,
                durationMs,
                tokensPerSecond: durationMs > 0
                    ? usage.outputTokens / (durationMs / 1000)
                    : undefined,
            };
        }

        this.auditor.record({
            timestamp: Date.now(),
            type: 'stream_end',
            provider: 'openai',
            model: this.options.model,
            duration: Date.now() - start,
            usage,
        });

        let finalToolCalls = toolCallAccum.size > 0
            ? Array.from(toolCallAccum.values()).map(tc => this.normalizeToolCall(tc))
            : undefined;
        let cleanContent = decoder.getCleanContent();
        // Prefer the server's dedicated reasoning field; fall back to <think>
        // tags parsed from the content stream by the decoder.
        let reasoning = reasoningBuffer || decoder.getReasoning();

        if (this.gemmaNative) {
            // Native tool-call blocks live in the text channel; extract them.
            const parsed = parseGemmaDiffusionOutput(cleanContent);
            cleanContent = parsed.content;
            if (parsed.reasoning) {
                reasoning = reasoning ? `${reasoning}\n\n${parsed.reasoning}` : parsed.reasoning;
            }
            if (!finalToolCalls?.length && parsed.toolCalls.length) {
                finalToolCalls = parsed.toolCalls.map(tc => ({
                    id: this.generateToolCallId(),
                    type: 'function' as const,
                    function: { name: tc.name, arguments: tc.argumentsJson },
                }));
                yield { type: 'tool_call', calls: finalToolCalls };
            }
        }

        return {
            message: {
                role: 'assistant',
                content: cleanContent,
                tool_calls: finalToolCalls,
            },
            reasoning,
            usage,
            provider: 'openai',
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
        const url = this.buildUrl('/embeddings');
        const response = await httpRequest<{
            data: Array<{ embedding: number[] }>;
        }>(url, {
            method: 'POST',
            headers: buildHeaders(this.options),
            body: {
                model: this.options.model,
                input: text,
            },
            timeout: this.options.timeout ?? 30000,
        });
        return response.data.data[0]?.embedding ?? [];
    }

    // ========================================================================
    // Model Discovery
    // ========================================================================

    async getModels(): Promise<string[]> {
        const url = this.buildUrl('/models');
        try {
            const response = await httpRequest<{
                data: OpenAIModelInfo[];
            }>(url, {
                headers: buildHeaders(this.options),
                timeout: 5000,
            });
            return response.data.data.map(m => m.id);
        } catch {
            return [];
        }
    }

    // ========================================================================
    // Internals
    // ========================================================================

    private convertMessages(messages: LLMChatMessage[]): LLMChatMessage[] {
        // OpenAI format is our canonical format, minimal conversion needed
        return messages.map(msg => ({
            ...msg,
            // Ensure content is never null/undefined
            content: msg.content ?? '',
        }));
    }

    private buildRequestParams(options?: ChatOptions): Record<string, unknown> {
        const params: Record<string, unknown> = {
            ...this.options.defaultParameters,
            ...options?.parameters,
        };
        if (options?.temperature !== undefined) params['temperature'] = options.temperature;
        if (options?.maxTokens !== undefined) params['max_tokens'] = options.maxTokens;

        // Unified thinking flag. Per-call overrides model config; only emitted
        // when explicitly set, so servers that reject unknown fields are
        // unaffected by default. OpenAI reasoning models (o-series / GPT-5) use
        // `reasoning_effort`; vLLM / Qwen use `chat_template_kwargs.enable_thinking`.
        // A user-supplied value (via parameters) always wins.
        const thinking = resolveThinking(options?.thinking, this.options.thinking);
        if (thinking) {
            const isOfficialOpenAI = (this.options.url ?? '').includes('api.openai.com');
            if (isOpenAIReasoningModel(this.options.model)) {
                if (params['reasoning_effort'] === undefined) {
                    params['reasoning_effort'] = thinking.enabled ? (thinking.level ?? 'medium') : 'minimal';
                }
            } else if (!isOfficialOpenAI) {
                // `chat_template_kwargs` is a vLLM/Qwen extension. Official OpenAI
                // rejects unknown body fields (and gpt-4o has no thinking toggle),
                // so only send it to self-hosted / compatible gateways.
                const existing = (params['chat_template_kwargs'] as Record<string, unknown> | undefined) ?? {};
                params['chat_template_kwargs'] = { enable_thinking: thinking.enabled, ...existing };
            }
        }
        return params;
    }

    // ========================================================================
    // Structured Output Helpers
    // ========================================================================

    /**
     * Build OpenAI response_format for structured output.
     */
    private buildResponseFormat(options: StructuredOutputOptions<unknown> & { strict?: boolean }): Record<string, unknown> {
        let jsonSchema: JSONSchema;
        let name: string;
        let description: string | undefined;

        // Prefer jsonSchema if provided (handles raw JSON Schema case)
        if (options.jsonSchema) {
            // Use raw JSON Schema
            jsonSchema = normalizeJsonSchema(options.jsonSchema);
            name = options.name || 'response';
            description = options.description;
        } else if (options.schemaConfig) {
            // Use SchemaConfig's embedded JSON Schema
            jsonSchema = getJsonSchemaFromConfig(options.schemaConfig);
            name = options.name || options.schemaConfig.name || 'response';
            description = options.description || options.schemaConfig.description;
        } else {
            // Should not happen - we check this in extractSchemaOptions
            throw new Error('Either schemaConfig or jsonSchema must be provided');
        }

        // OpenAI strict mode — configurable, defaults to true for reliable structured output
        return {
            type: 'json_schema',
            json_schema: {
                name,
                ...(description && { description }),
                schema: jsonSchema,
                strict: options.strict ?? true,
            },
        };
    }
}
