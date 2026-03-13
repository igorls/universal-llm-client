/**
 * Universal LLM Client v3 — OpenAI-Compatible Provider
 *
 * Implements BaseLLMClient for OpenAI-compatible APIs.
 * Works with: OpenAI, OpenRouter, LM Studio, LlamaCpp, vLLM, Groq, Together.
 */

import { BaseLLMClient } from '../client.js';
import { httpRequest, httpStream, parseSSE, buildHeaders } from '../http.js';
import { StandardChatDecoder } from '../stream-decoder.js';
import {
    zodToJsonSchema,
    normalizeJsonSchema,
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
    TokenUsageInfo,
} from '../interfaces.js';
import type { DecodedEvent } from '../stream-decoder.js';
import type { Auditor } from '../auditor.js';

export class OpenAICompatibleClient extends BaseLLMClient {
    constructor(options: LLMClientOptions, auditor?: Auditor) {
        // Ensure URL ends with /v1 for standard endpoints
        let url = (options.url || 'https://api.openai.com').replace(/\/+$/, '');
        if (!url.endsWith('/v1')) {
            url += '/v1';
        }
        super({ ...options, url }, auditor);
    }

    // ========================================================================
    // Chat
    // ========================================================================

    async chat(
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): Promise<LLMChatResponse> {
        // Validate: schema and tools cannot be used together
        if ((options?.schema || options?.jsonSchema) && options?.tools) {
            throw new Error(
                'Structured output and tools cannot be used together. ' +
                'Use either schema/jsonSchema for structured output OR tools for function calling.'
            );
        }

        const url = `${this.options.url}/chat/completions`;
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

        const usage: TokenUsageInfo | undefined = data.usage
            ? {
                inputTokens: data.usage.prompt_tokens,
                outputTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
            }
            : undefined;

        // Normalize tool calls (ensure IDs exist)
        const toolCalls = choice.message.tool_calls?.map(tc => ({
            ...tc,
            id: tc.id || this.generateToolCallId(),
        }));

        // Get content, handling null case
        const content = choice.message.content || '';

        const result: LLMChatResponse = {
            message: {
                role: 'assistant',
                content,
                tool_calls: toolCalls,
            },
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
        const url = `${this.options.url}/chat/completions`;
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

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'stream_start',
            provider: 'openai',
            model: this.options.model,
        });

        const decoder = new StandardChatDecoder(() => {});

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

        for await (const { data } of parseSSE(stream)) {
            try {
                const parsed = JSON.parse(data) as {
                    choices?: Array<{
                        delta?: {
                            content?: string;
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
                    };
                };

                if (parsed.usage) {
                    usage = {
                        inputTokens: parsed.usage.prompt_tokens,
                        outputTokens: parsed.usage.completion_tokens,
                        totalTokens: parsed.usage.total_tokens,
                    };
                }

                const delta = parsed.choices?.[0]?.delta;
                if (!delta) continue;

                if (delta.content) {
                    decoder.push(delta.content);
                    yield { type: 'text', content: delta.content };
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
                        const calls = Array.from(toolCallAccum.values());
                        yield { type: 'tool_call', calls };
                    }
                }
            } catch {
                // Skip unparseable SSE data
            }
        }

        decoder.flush();

        this.auditor.record({
            timestamp: Date.now(),
            type: 'stream_end',
            provider: 'openai',
            model: this.options.model,
            duration: Date.now() - start,
            usage,
        });

        const finalToolCalls = toolCallAccum.size > 0
            ? Array.from(toolCallAccum.values())
            : undefined;

        return {
            message: {
                role: 'assistant',
                content: decoder.getCleanContent(),
                tool_calls: finalToolCalls,
            },
            reasoning: decoder.getReasoning(),
            usage,
            provider: 'openai',
        };
    }

    // ========================================================================
    // Embeddings
    // ========================================================================

    async embed(text: string): Promise<number[]> {
        const url = `${this.options.url}/embeddings`;
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
        const url = `${this.options.url}/models`;
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
        } else if (options.schema) {
            // Convert Zod schema to JSON Schema
            jsonSchema = zodToJsonSchema(options.schema);
            name = options.name || 'response';
            description = options.description;
        } else {
            // Should not happen - we check this in extractSchemaOptions
            throw new Error('Either schema or jsonSchema must be provided');
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
