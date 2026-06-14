/**
 * Universal LLM Client v3 — Google Provider
 *
 * Implements BaseLLMClient for Google AI Studio and Vertex AI.
 * Supports Gemini and Gemma models with full tool calling,
 * streaming, embeddings, and system prompt handling.
 */

import { BaseLLMClient } from '../client.js';
import { resolveThinking, geminiThinkingBudget } from '../thinking.js';
import { httpRequest, httpStream, parseSSE, type HttpRequestOptions } from '../http.js';
import { StandardChatDecoder } from '../stream-decoder.js';
import {
    normalizeJsonSchema,
    stripUnsupportedFeatures,
    getJsonSchemaFromConfig,
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
    DeepResearchOptions,
    DeepResearchResult,
    DeepResearchStep,
    DeepResearchEvent,
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
        // Structured output and tools can now be used together.\n        // The provider sends both responseSchema and tools in the request.\n        // The Router handles skipping validation when the response contains tool calls.

        const url = this.getChatUrl();
        const body = this.buildRequestBody(messages, options);

        // Flex tier: increase timeout (Google recommends 600s+) and use retry logic
        const tier = options?.serviceTier;
        const effectiveTimeout = tier === 'flex'
            ? Math.max(this.options.timeout ?? 60000, 600_000)
            : (this.options.timeout ?? 60000);

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'request',
            provider: this.isVertex ? 'vertex' : 'google',
            model: this.options.model,
        });

        const reqOptions = {
            method: 'POST' as const,
            headers: this.getHeaders(),
            body,
            timeout: effectiveTimeout,
        };

        const response = tier === 'flex'
            ? await this.fetchWithFlexRetry<GoogleResponse>(url, reqOptions)
            : await httpRequest<GoogleResponse>(url, reqOptions);

        const result = this.parseGoogleResponse(response.data);

        // Surface the tier that actually served the request
        const resolvedTier = response.headers?.get('x-gemini-service-tier');
        if (resolvedTier) {
            result.serviceTier = resolvedTier.toLowerCase() as 'flex' | 'priority' | 'standard';
        }

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

        // Flex tier: increase timeout (Google recommends 600s+)
        const tier = options?.serviceTier;
        const effectiveTimeout = tier === 'flex'
            ? Math.max(this.options.timeout ?? 120000, 600_000)
            : (this.options.timeout ?? 120000);

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
            timeout: effectiveTimeout,
        });

        // Google streams SSE with JSON payloads
        let buffer = '';
        let reasoningBuffer = '';
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
                            cachedTokens: data.usageMetadata.cachedContentTokenCount,
                            reasoningTokens: data.usageMetadata.thoughtsTokenCount,
                        };
                    }

                    const candidate = data.candidates?.[0];
                    if (!candidate?.content?.parts) continue;

                    for (const part of candidate.content.parts) {
                        if (part.text) {
                            if (part.thought) {
                                reasoningBuffer += part.text;
                                yield { type: 'thinking', content: part.text };
                            } else {
                                decoder.push(part.text);
                                yield { type: 'text', content: part.text };
                            }
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
            reasoning: reasoningBuffer || decoder.getReasoning(),
            usage,
            provider: this.isVertex ? 'vertex' : 'google',
        };
    }

    // ========================================================================
    // Deep Research (Gemini interactions API)
    // ========================================================================

    /** Deep Research is available via Google AI Studio only (not Vertex AI). */
    supportsDeepResearch(): boolean {
        return !this.isVertex;
    }

    private interactionsBase(): string {
        if (this.isVertex) {
            throw new Error('Deep Research is only available via Google AI Studio, not Vertex AI.');
        }
        return `https://generativelanguage.googleapis.com/${this.apiVersion}/interactions`;
    }

    private deepResearchHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.options.apiKey ?? '',
            'Api-Revision': '2026-05-20',
        };
    }

    private buildInteractionBody(input: string, opts: DeepResearchOptions, background: boolean): Record<string, unknown> {
        return {
            input,
            agent: opts.agent ?? 'deep-research-preview-04-2026',
            background,
            agent_config: {
                type: 'deep-research',
                thinking_summaries: opts.thinkingSummaries ?? 'auto',
            },
            ...(opts.tools?.length ? { tools: opts.tools.map(t => ({ type: t })) } : {}),
            ...(opts.previousInteractionId ? { previous_interaction_id: opts.previousInteractionId } : {}),
        };
    }

    private toDeepResearchResult(i: Record<string, unknown> | undefined): DeepResearchResult {
        const obj = i ?? {};
        const steps = obj['steps'] as DeepResearchStep[] | undefined;
        let report = (obj['output_text'] ?? obj['outputText'] ?? obj['output']) as string | undefined;
        // Some responses carry the final report only inside the steps' content
        // blocks (the last step is typically the answer) — concatenate text there.
        if (!report && Array.isArray(steps)) {
            const text = steps
                .flatMap(s => (Array.isArray(s.content) ? s.content : []))
                .map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
                    ? (c as { text: string }).text
                    : ''))
                .filter(Boolean)
                .join('\n\n');
            report = text || undefined;
        }
        return {
            id: (obj['id'] as string) ?? '',
            status: (obj['status'] as string) ?? 'in_progress',
            report,
            steps,
            error: obj['error'],
            raw: obj,
        };
    }

    /** httpRequest with small backoff retries — the preview interactions API is flaky (503s). */
    private async drRequest(
        url: string,
        init: HttpRequestOptions,
        retries = 3,
    ): Promise<Record<string, unknown>> {
        let lastErr: unknown;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const res = await httpRequest<Record<string, unknown>>(url, init);
                return res.data;
            } catch (e) {
                lastErr = e;
                if (attempt < retries) await this.delay(1500 * (attempt + 1), init.signal);
            }
        }
        throw lastErr;
    }

    /**
     * Run an agentic Deep Research interaction: create it, then poll until it
     * completes/fails or the timeout elapses. Returns the final report + steps.
     */
    async deepResearch(input: string, opts: DeepResearchOptions = {}): Promise<DeepResearchResult> {
        const base = this.interactionsBase();
        const headers = this.deepResearchHeaders();
        const pollInterval = opts.pollIntervalMs ?? 5000;
        const deadline = Date.now() + (opts.timeoutMs ?? 600_000);

        let interaction = await this.drRequest(base, {
            method: 'POST',
            headers,
            body: this.buildInteractionBody(input, opts, true),
            timeout: this.options.timeout ?? 60_000,
            signal: opts.signal,
        });
        const id = interaction?.['id'] as string;
        if (!id) return this.toDeepResearchResult(interaction);

        while ((interaction?.['status'] ?? 'in_progress') === 'in_progress') {
            if (Date.now() > deadline) break;
            await this.delay(pollInterval, opts.signal);
            try {
                interaction = await this.drRequest(
                    `${base}/${id}`,
                    { method: 'GET', headers, timeout: this.options.timeout ?? 60_000, signal: opts.signal },
                    2,
                );
            } catch {
                // Tolerate transient errors during a long poll; keep trying until the deadline.
            }
        }
        return this.toDeepResearchResult(interaction);
    }

    /**
     * Stream a Deep Research interaction's intermediate updates (`step.delta`
     * thought/text/image events) and return the final result. Best-effort:
     * falls back to the created interaction object if the stream ends early.
     */
    async *deepResearchStream(
        input: string,
        opts: DeepResearchOptions = {},
    ): AsyncGenerator<DeepResearchEvent, DeepResearchResult, unknown> {
        const base = this.interactionsBase();
        const headers = this.deepResearchHeaders();
        // Streaming long-running research requires background:true AND stream:true
        // in the create body (per the Deep Research Interactions API docs).
        const stream = httpStream(base, {
            method: 'POST',
            headers,
            body: { ...this.buildInteractionBody(input, opts, true), stream: true },
            timeout: opts.timeoutMs ?? 600_000,
            signal: opts.signal,
        });

        let last: Record<string, unknown> | undefined;
        for await (const { data } of parseSSE(stream)) {
            if (!data || data === '[DONE]') continue;
            let parsed: Record<string, unknown>;
            try { parsed = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
            last = parsed;
            const delta = (parsed['delta'] ?? (parsed['step'] as Record<string, unknown> | undefined)?.['delta']) as
                | Record<string, unknown> | undefined;
            if (delta) {
                const dtype = delta['type'] as string | undefined;
                if (dtype === 'thought') yield { type: 'thought', content: String(delta['text'] ?? delta['content'] ?? '') };
                else if (dtype === 'text') yield { type: 'text', content: String(delta['text'] ?? delta['content'] ?? '') };
                else if (dtype === 'image') yield { type: 'image', content: delta['image'] ?? delta['content'] };
            }
            if (typeof parsed['status'] === 'string') yield { type: 'status', status: parsed['status'] as string };
        }
        return this.toDeepResearchResult(last);
    }

    private delay(ms: number, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(new Error('aborted'));
            const t = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
        });
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

        // Inference tier (Flex / Priority)
        const tier = options?.serviceTier;
        if (tier && tier !== 'standard') {
            body.service_tier = tier.toUpperCase() as 'FLEX' | 'PRIORITY';
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
        // Unified thinking flag → Gemini thinkingConfig. Per-call overrides model
        // config. Gemini 3.x uses `thinkingLevel`; 2.5/2.0 use `thinkingBudget`
        // (0 = off, -1 = dynamic). `includeThoughts` surfaces the reasoning text.
        // A user-supplied thinkingConfig (via parameters) is left untouched.
        const thinking = resolveThinking(options?.thinking, this.options.thinking);
        if (thinking && config['thinkingConfig'] === undefined) {
            if (/gemini-3/i.test(this.options.model)) {
                const tc: Record<string, unknown> = {};
                if (!thinking.enabled) {
                    tc['thinkingLevel'] = 'MINIMAL';
                } else {
                    if (thinking.level) tc['thinkingLevel'] = thinking.level.toUpperCase();
                    tc['includeThoughts'] = true;
                }
                config['thinkingConfig'] = tc;
            } else {
                config['thinkingConfig'] = thinking.enabled
                    ? { thinkingBudget: geminiThinkingBudget(thinking.level), includeThoughts: true }
                    : { thinkingBudget: 0 };
            }
        }

        // Structured output: add responseMimeType and responseSchema
        const schemaOptions = this.extractSchemaOptions(options);
        if (schemaOptions) {
            config['responseMimeType'] = 'application/json';

            // Convert schema to Google-compatible format
            let jsonSchema: JSONSchema;
            if (schemaOptions.jsonSchema) {
                jsonSchema = normalizeJsonSchema(schemaOptions.jsonSchema);
            } else if (schemaOptions.schemaConfig) {
                jsonSchema = getJsonSchemaFromConfig(schemaOptions.schemaConfig);
            } else {
                throw new Error('Either schemaConfig or jsonSchema must be provided');
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
                                args: this.parseToolArguments(tc.function.arguments),
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
            if (part.type === 'audio') {
                return {
                    inlineData: {
                        mimeType: part.audio.mimeType,
                        data: part.audio.data,
                    },
                };
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
        fc: { name?: string; args?: Record<string, unknown> },
        thoughtSignature?: string,
    ): LLMToolCall {
        const toolCall: LLMToolCall = {
            id: this.generateToolCallId(),
            type: 'function',
            function: {
                name: fc.name || '',
                arguments: JSON.stringify(fc.args ?? {}),
            },
        };
        if (thoughtSignature) {
            toolCall.thoughtSignature = thoughtSignature;
        }
        return toolCall;
    }

    private parseToolArguments(args: string | Record<string, unknown> | undefined): Record<string, unknown> {
        if (typeof args !== 'string') {
            return args ?? {};
        }
        if (args.length === 0) {
            return {};
        }
        try {
            const parsed = JSON.parse(args) as unknown;
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed as Record<string, unknown>
                : {};
        } catch {
            return {};
        }
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
        let reasoningText = '';
        const toolCalls: LLMToolCall[] = [];

        for (const part of candidate.content.parts) {
            if (part.text) {
                // Thought summaries (includeThoughts) carry the reasoning trace;
                // keep them out of `content` and surface them as `reasoning`.
                if (part.thought) reasoningText += part.text;
                else textContent += part.text;
            }
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
                cachedTokens: data.usageMetadata.cachedContentTokenCount,
                reasoningTokens: data.usageMetadata.thoughtsTokenCount,
            }
            : undefined;

        return {
            message: {
                role: 'assistant',
                content: textContent,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            },
            reasoning: reasoningText || undefined,
            usage,
            provider: this.isVertex ? 'vertex' : 'google',
        };
    }

    // ========================================================================
    // Flex Retry Logic
    // ========================================================================

    /**
     * Retry HTTP requests for Flex tier when receiving 503/429 errors.
     * Uses exponential backoff (5s → 10s → 20s) as recommended by Google.
     */
    private async fetchWithFlexRetry<T>(
        url: string,
        reqOptions: { method: 'POST'; headers: Record<string, string>; body: unknown; timeout: number },
        maxRetries = 3,
        baseDelay = 5000,
    ): Promise<import('../http.js').HttpResponse<T>> {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await httpRequest<T>(url, reqOptions);
            } catch (error) {
                const isRetryable = error instanceof Error
                    && (error.message.includes('HTTP 503') || error.message.includes('HTTP 429'));
                if (!isRetryable || attempt >= maxRetries - 1) throw error;
                const delay = baseDelay * (2 ** attempt);
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw new Error('Unreachable');
    }

}
