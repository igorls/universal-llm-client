/**
 * Universal LLM Client v3 — Google Provider
 *
 * Implements BaseLLMClient for Google AI Studio and Vertex AI.
 * Supports Gemini and Gemma models with full tool calling,
 * streaming, embeddings, and system prompt handling.
 */

import { BaseLLMClient } from '../client.js';
import { httpRequest, httpStream } from '../http.js';
import { StandardChatDecoder } from '../stream-decoder.js';
import {
    zodToJsonSchema,
    normalizeJsonSchema,
    stripUnsupportedFeatures,
    type JSONSchema,
} from '../structured-output.js';
import type {
    LLMClientOptions,
    LLMChatMessage,
    LLMChatResponse,
    ChatOptions,
    LLMToolDefinition,
    LLMToolCall,
    LLMContentPart,
    LLMTextContent,
    GooglePart,
    GoogleContent,
    GoogleRequest,
    GoogleResponse,
    GoogleFunctionDeclaration,
    TokenUsageInfo,
    AIModelApiType,
} from '../interfaces.js';
import type { DecodedEvent } from '../stream-decoder.js';
import type { Auditor } from '../auditor.js';

export class GoogleClient extends BaseLLMClient {
    private isVertex: boolean;
    private apiVersion: string;

    constructor(options: LLMClientOptions, auditor?: Auditor) {
        super(options, auditor);
        this.isVertex = options.apiType === ('vertex' as AIModelApiType);
        this.apiVersion = options.apiVersion ?? 'v1beta';
    }

    // ========================================================================
    // URL Building
    // ========================================================================

    private getBaseUrl(): string {
        if (this.isVertex) {
            const region = this.options.region ?? 'us-central1';
            return `https://${region}-aiplatform.googleapis.com/${this.apiVersion}/projects/-/locations/${region}/publishers/google/models/${this.options.model}`;
        }
        if (this.options.url) return this.options.url.replace(/\/+$/, '');
        return `https://generativelanguage.googleapis.com/${this.apiVersion}/models/${this.options.model}`;
    }

    private getChatUrl(): string {
        const base = this.getBaseUrl();
        if (this.isVertex) {
            return `${base}:generateContent`;
        }
        return `${base}:generateContent?key=${this.options.apiKey}`;
    }

    private getStreamUrl(): string {
        const base = this.getBaseUrl();
        if (this.isVertex) {
            return `${base}:streamGenerateContent?alt=sse`;
        }
        return `${base}:streamGenerateContent?alt=sse&key=${this.options.apiKey}`;
    }

    private getEmbedUrl(): string {
        if (this.isVertex) {
            const region = this.options.region ?? 'us-central1';
            return `https://${region}-aiplatform.googleapis.com/${this.apiVersion}/projects/-/locations/${region}/publishers/google/models/${this.options.model}:embedContent`;
        }
        return `https://generativelanguage.googleapis.com/${this.apiVersion}/models/${this.options.model}:embedContent?key=${this.options.apiKey}`;
    }

    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (this.isVertex && this.options.apiKey) {
            headers['Authorization'] = `Bearer ${this.options.apiKey}`;
        }
        return headers;
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

        const url = this.getChatUrl();
        const body = this.buildRequestBody(messages, options);

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'request',
            provider: this.isVertex ? 'vertex' : 'google',
            model: this.options.model,
        });

        const response = await httpRequest<GoogleResponse>(url, {
            method: 'POST',
            headers: this.getHeaders(),
            body,
            timeout: this.options.timeout ?? 60000,
        });

        const result = this.parseGoogleResponse(response.data);

        this.auditor.record({
            timestamp: Date.now(),
            type: 'response',
            provider: this.isVertex ? 'vertex' : 'google',
            model: this.options.model,
            duration: Date.now() - start,
            usage: result.usage,
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
        const url = this.getStreamUrl();
        const body = this.buildRequestBody(messages, options);

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'stream_start',
            provider: this.isVertex ? 'vertex' : 'google',
            model: this.options.model,
        });

        const decoder = new StandardChatDecoder(() => {});
        let usage: TokenUsageInfo | undefined;
        const allToolCalls: LLMToolCall[] = [];

        const stream = httpStream(url, {
            method: 'POST',
            headers: this.getHeaders(),
            body,
            timeout: this.options.timeout ?? 120000,
        });

        // Google streams SSE with JSON payloads
        let buffer = '';
        for await (const chunk of stream) {
            buffer += chunk;

            // Google SSE uses "data: " prefix
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const jsonStr = line.slice(6).trim();
                if (!jsonStr || jsonStr === '[DONE]') continue;

                try {
                    const data = JSON.parse(jsonStr) as GoogleResponse;

                    if (data.usageMetadata) {
                        usage = {
                            inputTokens: data.usageMetadata.promptTokenCount ?? 0,
                            outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
                            totalTokens: data.usageMetadata.totalTokenCount ?? 0,
                        };
                    }

                    const candidate = data.candidates?.[0];
                    if (!candidate?.content?.parts) continue;

                    for (const part of candidate.content.parts) {
                        if (part.text) {
                            decoder.push(part.text);
                            yield { type: 'text', content: part.text };
                        }
                        if (part.functionCall) {
                            const toolCall = this.convertFunctionCallToToolCall(
                                part.functionCall,
                                part.thoughtSignature,
                            );
                            allToolCalls.push(toolCall);
                            yield { type: 'tool_call', calls: [toolCall] };
                        }
                    }
                } catch {
                    // Skip unparseable JSON
                }
            }
        }

        decoder.flush();

        this.auditor.record({
            timestamp: Date.now(),
            type: 'stream_end',
            provider: this.isVertex ? 'vertex' : 'google',
            model: this.options.model,
            duration: Date.now() - start,
            usage,
        });

        return {
            message: {
                role: 'assistant',
                content: decoder.getCleanContent(),
                tool_calls: allToolCalls.length > 0 ? allToolCalls : undefined,
            },
            reasoning: decoder.getReasoning(),
            usage,
            provider: this.isVertex ? 'vertex' : 'google',
        };
    }

    // ========================================================================
    // Embeddings
    // ========================================================================

    async embed(text: string): Promise<number[]> {
        const url = this.getEmbedUrl();
        const response = await httpRequest<{
            embedding: { values: number[] };
        }>(url, {
            method: 'POST',
            headers: this.getHeaders(),
            body: {
                content: {
                    parts: [{ text }],
                },
            },
            timeout: this.options.timeout ?? 30000,
        });
        return response.data.embedding.values;
    }

    // ========================================================================
    // Model Discovery
    // ========================================================================

    async getModels(): Promise<string[]> {
        const baseUrl = this.isVertex
            ? `https://${this.options.region ?? 'us-central1'}-aiplatform.googleapis.com/${this.apiVersion}/models`
            : `https://generativelanguage.googleapis.com/${this.apiVersion}/models?key=${this.options.apiKey}`;

        try {
            const response = await httpRequest<{
                models: Array<{ name: string }>;
            }>(baseUrl, {
                headers: this.getHeaders(),
                timeout: 10000,
            });
            return response.data.models.map(m =>
                m.name.replace(/^models\//, ''),
            );
        } catch {
            return [];
        }
    }

    // ========================================================================
    // Request Building
    // ========================================================================

    private buildRequestBody(
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): GoogleRequest {
        const isGemma = this.options.model.toLowerCase().includes('gemma');
        const { systemInstruction, contents } = this.convertToGoogleMessages(messages, isGemma);

        const tools = options?.tools ?? (Object.keys(this.toolRegistry).length > 0 ? this.getToolDefinitions() : undefined);

        const body: GoogleRequest = {
            contents,
            generationConfig: this.buildGenerationConfig(options),
        };

        // System instruction (Gemini supports it, Gemma doesn't)
        if (systemInstruction && !isGemma) {
            body.systemInstruction = {
                parts: [{ text: systemInstruction }],
            };
        }

        // Tools
        if (tools?.length) {
            body.tools = [{
                functionDeclarations: tools.map(t => this.convertToGoogleTool(t)),
            }];
        }

        return body;
    }

    private buildGenerationConfig(options?: ChatOptions): Record<string, unknown> {
        const config: Record<string, unknown> = {
            ...this.options.defaultParameters,
            ...options?.parameters,
        };
        if (options?.temperature !== undefined) config['temperature'] = options.temperature;
        if (options?.maxTokens !== undefined) config['maxOutputTokens'] = options.maxTokens;
        if (this.options.thinking) {
            config['thinkingConfig'] = { thinkingBudget: 8192 };
        }

        // Structured output: add responseMimeType and responseSchema
        const schemaOptions = this.extractSchemaOptions(options);
        if (schemaOptions) {
            config['responseMimeType'] = 'application/json';

            // Convert schema to Google-compatible format
            let jsonSchema: JSONSchema;
            if (schemaOptions.jsonSchema) {
                jsonSchema = normalizeJsonSchema(schemaOptions.jsonSchema);
            } else if (schemaOptions.schema) {
                jsonSchema = zodToJsonSchema(schemaOptions.schema);
            } else {
                throw new Error('Either schema or jsonSchema must be provided');
            }

            // Strip unsupported features for Google
            const googleSchema = stripUnsupportedFeatures(jsonSchema, 'google');
            config['responseSchema'] = googleSchema;
        }

        return config;
    }

    // ========================================================================
    // Message Conversion
    // ========================================================================

    private convertToGoogleMessages(
        messages: LLMChatMessage[],
        isGemma: boolean,
    ): { systemInstruction?: string; contents: GoogleContent[] } {
        let systemInstruction: string | undefined;
        const contents: GoogleContent[] = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                if (isGemma) {
                    // Gemma: prepend system message to first user message
                    systemInstruction = typeof msg.content === 'string'
                        ? msg.content
                        : msg.content.filter((p): p is LLMTextContent => p.type === 'text').map(p => p.text).join('');
                } else {
                    systemInstruction = typeof msg.content === 'string'
                        ? msg.content
                        : msg.content.filter((p): p is LLMTextContent => p.type === 'text').map(p => p.text).join('');
                }
                continue;
            }

            if (msg.role === 'tool') {
                // Convert tool result to Google functionResponse
                let responseData: Record<string, unknown>;
                try {
                    responseData = typeof msg.content === 'string'
                        ? JSON.parse(msg.content)
                        : { result: msg.content };
                } catch {
                    responseData = { result: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) };
                }

                contents.push({
                    role: 'function',
                    parts: [{
                        functionResponse: {
                            name: msg.tool_call_id ?? 'unknown',
                            response: responseData,
                        },
                    }],
                });
                continue;
            }

            if (msg.role === 'assistant') {
                const parts: GooglePart[] = [];
                const textContent = typeof msg.content === 'string' ? msg.content : '';
                if (textContent) parts.push({ text: textContent });

                // Convert tool calls to functionCall parts
                if (msg.tool_calls) {
                    for (const tc of msg.tool_calls) {
                        const part: GooglePart = {
                            functionCall: {
                                name: tc.function.name,
                                args: typeof tc.function.arguments === 'string'
                                    ? JSON.parse(tc.function.arguments)
                                    : tc.function.arguments as Record<string, unknown>,
                            },
                        };
                        // Echo thought signature back (required by Gemini 3.x)
                        if (tc.thoughtSignature) {
                            part.thoughtSignature = tc.thoughtSignature;
                        }
                        parts.push(part);
                    }
                }

                contents.push({ role: 'model', parts });
                continue;
            }

            // User messages
            const parts = this.convertContentToGoogleParts(msg.content);

            // Gemma: prepend system instruction to first user message
            if (isGemma && systemInstruction && contents.length === 0) {
                const systemParts = [{ text: `[System Instructions]\n${systemInstruction}\n\n[User Message]\n` }];
                contents.push({
                    role: 'user',
                    parts: [...systemParts, ...parts],
                });
                systemInstruction = undefined; // Consumed
            } else {
                contents.push({ role: 'user', parts });
            }
        }

        return { systemInstruction, contents };
    }

    private convertContentToGoogleParts(content: string | LLMContentPart[]): GooglePart[] {
        if (typeof content === 'string') {
            return [{ text: content }];
        }

        return content.map(part => {
            if (part.type === 'text') {
                return { text: part.text };
            }
            // Image content
            const url = part.image_url.url;
            if (url.startsWith('data:')) {
                const match = url.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                    return {
                        inlineData: {
                            mimeType: match[1]!,
                            data: match[2]!,
                        },
                    };
                }
            }
            // For regular URLs, try inline data format
            return { text: `[Image: ${url}]` };
        });
    }

    // ========================================================================
    // Tool Conversion
    // ========================================================================

    private convertToGoogleTool(tool: LLMToolDefinition): GoogleFunctionDeclaration {
        return {
            name: tool.function.name,
            description: tool.function.description,
            parameters: {
                type: 'object',
                properties: tool.function.parameters.properties ?? {},
                required: tool.function.parameters.required,
            },
        };
    }

    private convertFunctionCallToToolCall(
        fc: { name: string; args: Record<string, unknown> },
        thoughtSignature?: string,
    ): LLMToolCall {
        const toolCall: LLMToolCall = {
            id: this.generateToolCallId(),
            type: 'function',
            function: {
                name: fc.name,
                arguments: JSON.stringify(fc.args),
            },
        };
        if (thoughtSignature) {
            toolCall.thoughtSignature = thoughtSignature;
        }
        return toolCall;
    }

    // ========================================================================
    // Response Parsing
    // ========================================================================

    private parseGoogleResponse(data: GoogleResponse): LLMChatResponse {
        const candidate = data.candidates?.[0];
        if (!candidate?.content?.parts) {
            return {
                message: { role: 'assistant', content: '' },
                provider: this.isVertex ? 'vertex' : 'google',
            };
        }

        let textContent = '';
        const toolCalls: LLMToolCall[] = [];

        for (const part of candidate.content.parts) {
            if (part.text) textContent += part.text;
            if (part.functionCall) {
                toolCalls.push(this.convertFunctionCallToToolCall(
                    part.functionCall,
                    part.thoughtSignature,
                ));
            }
        }

        const usage: TokenUsageInfo | undefined = data.usageMetadata
            ? {
                inputTokens: data.usageMetadata.promptTokenCount,
                outputTokens: data.usageMetadata.candidatesTokenCount,
                totalTokens: data.usageMetadata.totalTokenCount,
            }
            : undefined;

        return {
            message: {
                role: 'assistant',
                content: textContent,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            },
            usage,
            provider: this.isVertex ? 'vertex' : 'google',
        };
    }

}
