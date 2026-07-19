/**
 * Universal LLM Client v3 — OpenAI-Compatible Provider
 *
 * Implements BaseLLMClient for OpenAI-compatible APIs.
 * Works with: OpenAI, OpenRouter, LM Studio, LlamaCpp, vLLM, Groq, Together.
 */

import { BaseLLMClient } from '../client.js';
import { resolveThinking, isOpenAIReasoningModel, supportsChatTemplateKwargs } from '../thinking.js';
import { httpRequest, httpStream, parseSSE, buildHeaders } from '../http.js';
import { createDecoder, StandardChatDecoder } from '../stream-decoder.js';
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
    ModelMetadata,
    OpenAIResponse,
    OpenAIModelInfo,
    LLMToolCall,
    LLMToolDefinition,
    TokenUsageInfo,
    ThinkingLevel,
} from '../interfaces.js';
import type { DecodedEvent, StreamDecoder } from '../stream-decoder.js';
import type { Auditor } from '../auditor.js';
import { gemmaArgsToJson, isGemmaDiffusionModel, parseGemmaDiffusionOutput } from '../gemma-diffusion.js';

const VLLM_AUTO_TOOL_CHOICE_HINT =
    'vLLM rejected automatic tool choice. Retrying with text-level tool calling. To use native tool_calls, start vLLM with --enable-auto-tool-choice and --tool-call-parser <parser>.';

const CEREBRAS_MODEL_CONTEXT_LENGTHS: Readonly<Record<string, number>> = {
    // Cerebras currently omits max context metadata from /v1/models for this
    // served model. Live requests with ~90K prompt tokens succeed, so 128K is
    // a conservative fallback that avoids treating it like an 8K local server.
    'gemma-4-31b': 131_072,
};

function isCerebrasEndpoint(url: string | undefined): boolean {
    return (url ?? '').toLowerCase().includes('api.cerebras.ai');
}

function normalizeModelId(model: string): string {
    return model.toLowerCase();
}

function knownOpenAICompatModelInfo(url: string | undefined, model: string): ModelMetadata | undefined {
    if (!isCerebrasEndpoint(url)) return undefined;
    const contextLength = CEREBRAS_MODEL_CONTEXT_LENGTHS[normalizeModelId(model)];
    return contextLength ? { model, contextLength } : undefined;
}

function applyMaxTokensParam(
    params: Record<string, unknown>,
    maxTokens: number | undefined,
    url: string | undefined,
): void {
    if (maxTokens === undefined) return;
    if (isCerebrasEndpoint(url)) {
        if (params['max_completion_tokens'] === undefined && params['max_tokens'] === undefined) {
            params['max_completion_tokens'] = maxTokens;
        }
        return;
    }
    if (params['max_tokens'] === undefined) params['max_tokens'] = maxTokens;
}

function cerebrasReasoningEffort(level: ThinkingLevel | undefined): 'low' | 'medium' | 'high' {
    if (level === 'high') return 'high';
    if (level === 'low' || level === 'minimal') return 'low';
    return 'medium';
}

function usesGemmaCerebrasReasoningDefault(model: string): boolean {
    return normalizeModelId(model) === 'gemma-4-31b';
}

function normalizeMessagesForOpenAICompat(messages: LLMChatMessage[]): LLMChatMessage[] {
    let sawNonSystem = false;

    return messages.map(message => {
        if (message.role !== 'system') {
            sawNonSystem = true;
            return toOpenAICompatMessage(message, message.content);
        }

        if (!sawNonSystem) {
            return toOpenAICompatMessage(message, message.content);
        }

        return toOpenAICompatMessage({
            role: 'user',
            content: `[SYSTEM MESSAGE]\n${stringifyMessageContent(message.content)}`,
        });
    });
}

function toOpenAICompatMessage(
    message: LLMChatMessage,
    content: LLMChatMessage['content'] = message.content,
): LLMChatMessage {
    const normalized: LLMChatMessage = {
        role: message.role,
        content: content ?? '',
    };

    if (message.role === 'assistant' && message.tool_calls) {
        normalized.tool_calls = message.tool_calls;
    }
    if (message.role === 'tool' && message.tool_call_id) {
        normalized.tool_call_id = message.tool_call_id;
    }

    return normalized;
}

function stringifyMessageContent(content: LLMChatMessage['content']): string {
    if (typeof content === 'string') return content;
    return content
        .map(part => {
            if (part.type === 'text') return part.text;
            if (part.type === 'image_url') return `[Image: ${part.image_url.url}]`;
            if (part.type === 'audio') return `[Audio: ${part.audio.mimeType}]`;
            return '';
        })
        .filter(Boolean)
        .join('\n');
}

function hasToolDefinitions(body: Record<string, unknown>): boolean {
    const tools = body['tools'];
    return Array.isArray(tools) && tools.length > 0;
}

function isVllmAutoToolChoiceError(value: unknown): boolean {
    const text = value instanceof Error
        ? value.message
        : typeof value === 'string'
            ? value
            : JSON.stringify(value ?? '');
    const normalized = text.toLowerCase();
    return (
        normalized.includes('auto')
        && normalized.includes('tool choice requires --enable-auto-tool-choice')
        && normalized.includes('--tool-call-parser')
    );
}

async function requestWithVllmToolFallback<T>(
    url: string,
    request: {
        readonly headers: Record<string, string>;
        readonly body: Record<string, unknown>;
        readonly timeout: number;
    },
    tools: LLMToolDefinition[] | undefined,
    onFallback: () => void,
): Promise<import('../http.js').HttpResponse<T>> {
    try {
        return await httpRequest<T>(url, {
            method: 'POST',
            headers: request.headers,
            body: request.body,
            timeout: request.timeout,
        });
    } catch (error) {
        if (
            tools?.length
            && hasToolDefinitions(request.body)
            && isVllmAutoToolChoiceError(error)
        ) {
            onFallback();
            return httpRequest<T>(url, {
                method: 'POST',
                headers: request.headers,
                body: withoutNativeTools(request.body, tools),
                timeout: request.timeout,
            });
        }
        throw error;
    }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        /* not JSON */
    }
    return null;
}

function normalizeLooseArguments(rawArgs: string): string | null {
    const trimmed = rawArgs.trim();
    if (!trimmed) return '{}';
    const jsonArgs = parseJsonObject(trimmed);
    if (jsonArgs) return JSON.stringify(jsonArgs);

    const unwrapped = trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed.slice(1, -1).trim() : trimmed;
    try {
        return gemmaArgsToJson(unwrapped);
    } catch {
        return null;
    }
}

function parseTextToolCallBody(content: string): Array<{ name: string; arguments: string }> {
    const body = content.trim();
    if (!body) return [];

    try {
        const parsed = JSON.parse(body) as unknown;
        const rawCalls = Array.isArray(parsed) ? parsed : [parsed];
        const calls: Array<{ name: string; arguments: string }> = [];
        for (const rawCall of rawCalls) {
            if (!rawCall || typeof rawCall !== 'object') continue;
            const record = rawCall as Record<string, unknown>;
            const name = record['name'];
            if (typeof name !== 'string' || !name) continue;
            const args = record['arguments'] ?? record['parameters'] ?? record['args'] ?? {};
            calls.push({
                name,
                arguments: typeof args === 'string' ? JSON.stringify(parseJsonObject(args) ?? {}) : JSON.stringify(args ?? {}),
            });
        }
        if (calls.length > 0) return calls;
    } catch {
        /* not structured JSON */
    }

    const bareGemmaCallMatch = /^call:([@A-Za-z_][@A-Za-z0-9_.:-]*)\s*[\({]([\s\S]*)[\)}]\s*$/u.exec(body);
    if (bareGemmaCallMatch) {
        const rawArgs = bareGemmaCallMatch[2]!.trim();
        const argumentsJson = normalizeLooseArguments(rawArgs);
        if (argumentsJson) return [{ name: bareGemmaCallMatch[1]!, arguments: argumentsJson }];
    }

    const functionCallMatch = /^([@A-Za-z_][@A-Za-z0-9_.:-]*)\s*\(([\s\S]*)\)\s*$/u.exec(body);
    if (functionCallMatch) {
        const rawArgs = functionCallMatch[2]!.trim();
        const argumentsJson = normalizeLooseArguments(rawArgs);
        if (argumentsJson) return [{ name: functionCallMatch[1]!, arguments: argumentsJson }];
    }

    const calls: Array<{ name: string; arguments: string }> = [];
    const funcPattern = /<function=([@A-Za-z_][@A-Za-z0-9_.:-]*)>([\s\S]*?)<\/function>/g;
    let fMatch: RegExpExecArray | null;
    while ((fMatch = funcPattern.exec(body)) !== null) {
        const args: Record<string, string> = {};
        const paramPattern = /<parameter=([A-Za-z_][A-Za-z0-9_-]*)>([\s\S]*?)<\/parameter>/g;
        let pMatch: RegExpExecArray | null;
        while ((pMatch = paramPattern.exec(fMatch[2] ?? '')) !== null) {
            args[pMatch[1]!] = pMatch[2]!.trim();
        }
        calls.push({ name: fMatch[1]!, arguments: JSON.stringify(args) });
    }
    return calls;
}

function findBareGemmaCallSegments(content: string): string[] {
    const segments: string[] = [];
    const startPattern = /call:[@A-Za-z_][@A-Za-z0-9_.:-]*\s*[\({]/gu;
    let match: RegExpExecArray | null;

    while ((match = startPattern.exec(content)) !== null) {
        const start = match.index;
        const opener = content[match.index + match[0].length - 1]!;
        const openIdx = match.index + match[0].length - 1;
        const primaryClose = opener === '(' ? ')' : '}';
        const toleratedClose = opener === '(' ? '}' : undefined;

        let depth = 0;
        let quote: string | null = null;
        let escaped = false;
        for (let i = openIdx; i < content.length; i++) {
            const ch = content[i]!;
            if (quote) {
                if (escaped) {
                    escaped = false;
                } else if (ch === '\\') {
                    escaped = true;
                } else if (ch === quote) {
                    quote = null;
                }
                continue;
            }

            if (ch === '"' || ch === "'") {
                quote = ch;
            } else if (ch === opener) {
                depth++;
            } else if (ch === primaryClose) {
                depth--;
                if (depth === 0) {
                    segments.push(content.slice(start, i + 1));
                    startPattern.lastIndex = i + 1;
                    break;
                }
            } else if (depth === 1 && toleratedClose !== undefined && ch === toleratedClose) {
                const rawArgs = content.slice(openIdx + 1, i).trim();
                if (rawArgs.startsWith('{')) continue;
                if (!normalizeLooseArguments(rawArgs)) continue;
                segments.push(content.slice(start, i + 1));
                startPattern.lastIndex = i + 1;
                break;
            }
        }
    }

    return segments;
}

function recoverToolCallsFromText(
    content: string,
    knownToolNames: Set<string>,
    generateId: () => string,
): { calls: LLMToolCall[]; cleanContent: string } | null {
    if (!content || content.length < 10) return null;

    const calls: LLMToolCall[] = [];
    let cleanContent = content;
    const isKnownTool = (name: string) => knownToolNames.has(name);

    const toolCallPattern = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let tcMatch: RegExpExecArray | null;
    while ((tcMatch = toolCallPattern.exec(content)) !== null) {
        const parsedCalls = parseTextToolCallBody(tcMatch[1]!);
        let matched = false;
        for (const parsed of parsedCalls) {
            if (!isKnownTool(parsed.name)) continue;
            matched = true;
            calls.push({
                id: generateId(),
                type: 'function',
                function: { name: parsed.name, arguments: parsed.arguments },
            });
        }
        if (matched) cleanContent = cleanContent.replace(tcMatch[0], '');
    }

    for (const segment of findBareGemmaCallSegments(content)) {
        const parsedCalls = parseTextToolCallBody(segment);
        let matched = false;
        for (const parsed of parsedCalls) {
            if (!isKnownTool(parsed.name)) continue;
            matched = true;
            calls.push({
                id: generateId(),
                type: 'function',
                function: { name: parsed.name, arguments: parsed.arguments },
            });
        }
        if (matched) cleanContent = cleanContent.replace(segment, '');
    }

    if (calls.length === 0) return null;
    return { calls, cleanContent: cleanContent.trim() };
}

function toolFallbackInstruction(tools: LLMToolDefinition[]): LLMChatMessage {
    const toolLines = tools.map(tool => {
        const fn = tool.function;
        return `- ${fn.name}: ${fn.description}\n  parameters JSON schema: ${JSON.stringify(fn.parameters)}`;
    });
    return {
        role: 'system',
        content:
            'The server does not support native OpenAI tool parsing for this request. '
            + 'Use this text tool protocol instead.\n\n'
            + 'When you need a tool, respond with exactly one or more tool calls and no prose:\n'
            + '<tool_call>tool_name({"argument":"value"})</tool_call>\n\n'
            + 'After tool results are provided, answer the user normally. Available tools:\n'
            + toolLines.join('\n'),
    };
}

function withTextToolFallbackMessages(messages: LLMChatMessage[], tools: LLMToolDefinition[]): LLMChatMessage[] {
    return [toolFallbackInstruction(tools), ...messages];
}

function withoutNativeTools(body: Record<string, unknown>, tools: LLMToolDefinition[]): Record<string, unknown> {
    const fallbackBody = { ...body };
    delete fallbackBody['tools'];
    delete fallbackBody['tool_choice'];
    fallbackBody['messages'] = withTextToolFallbackMessages(
        (body['messages'] as LLMChatMessage[]) ?? [],
        tools,
    );
    return fallbackBody;
}

export class OpenAICompatibleClient extends BaseLLMClient {
    private warnedVllmToolFallback = false;

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
        const raw = this.options.url.replace(/\/+$/, '');
        // Split off any query string already on the configured base URL so the
        // path is inserted before it (avoids `host/v1?k=v/chat/completions`).
        const qIdx = raw.indexOf('?');
        const basePath = (qIdx === -1 ? raw : raw.slice(0, qIdx)).replace(/\/+$/, '');
        const existingQuery = qIdx === -1 ? '' : raw.slice(qIdx + 1);
        const path = suffix.startsWith('/') ? suffix : '/' + suffix;

        const search = new URLSearchParams(existingQuery);
        const qp = this.options.queryParams;
        if (qp) {
            for (const [k, v] of Object.entries(qp)) {
                if (v != null) search.set(k, String(v));
            }
        }
        const qs = search.toString();
        return basePath + path + (qs ? `?${qs}` : '');
    }

    constructor(options: LLMClientOptions, auditor?: Auditor) {
        let base = (options.url || 'https://api.openai.com').replace(/\/+$/, '');

        // Respect apiBasePath (from ProviderConfig.apiBasePath). Default "/v1" for broad compatibility.
        // Set apiBasePath: '' (or '/') when you are supplying a *complete* path already
        // (e.g. full Azure ".../deployments/my-model" URL) or for non-/v1 OpenAI-compatible servers.
        const desired = options.apiBasePath;
        const shouldAppend = desired !== '' && desired !== '/';

        if (shouldAppend) {
            // Normalize to exactly one leading slash and no trailing slash
            // (so 'v1', '/v1', '//v1' and '/v1/' all become '/v1').
            const basePath = ('/' + (desired || '/v1').replace(/^\/+/, '')).replace(/\/+$/, '');
            if (!base.endsWith(basePath)) {
                base += basePath;
            }
        }

        super({ ...options, url: base }, auditor);
    }

    private warnVllmToolFallback(): void {
        if (this.warnedVllmToolFallback) return;
        this.warnedVllmToolFallback = true;
        console.warn(`[OpenAI] ${VLLM_AUTO_TOOL_CHOICE_HINT}`);
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
        const tools = options?.tools;

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

        const response = await requestWithVllmToolFallback<OpenAIResponse>(
            url,
            {
                headers: buildHeaders(this.options),
                body,
                timeout: this.options.timeout ?? 30000,
            },
            tools,
            () => this.warnVllmToolFallback(),
        );

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
                reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens,
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

        if (!toolCalls?.length && tools?.length && content) {
            const knownToolNames = new Set(tools.map(tool => tool.function.name));
            const recovered = recoverToolCallsFromText(content, knownToolNames, () => this.generateToolCallId());
            if (recovered) {
                toolCalls = recovered.calls;
                content = recovered.cleanContent;
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
            finishReason: choice.finish_reason,
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
        const tools = options?.tools;
        const knownToolNames = new Set(tools?.map(tool => tool.function.name) ?? []);

        const body: Record<string, unknown> = {
            model: this.options.model,
            messages: this.convertMessages(messages),
            stream: true,
            // Without this, OpenAI-compatible servers (vLLM, llama.cpp, LM Studio)
            // omit the `usage` object from the stream entirely — the final-chunk
            // usage parser below then never fires and consumers get NO token
            // accounting for streamed turns (billing/telemetry silently empty).
            stream_options: { include_usage: true },
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

        // In gemma-native mode, or when a caller selects an explicit decoder,
        // the decoder classifies content into typed events instead of exposing
        // raw deltas with protocol tags still attached.
        const decoderEvents: DecodedEvent[] = [];
        const decoderOption = options?.decoder;
        const decoderInstanceProvided = Boolean(decoderOption && typeof decoderOption === 'object');
        const yieldDecoderEvents = !decoderInstanceProvided
            && (this.gemmaNative || typeof decoderOption === 'string' || knownToolNames.size > 0);
        const decoder: StreamDecoder = typeof decoderOption === 'string'
            ? createDecoder(decoderOption, e => decoderEvents.push(e), { knownToolNames })
            : decoderInstanceProvided
                ? decoderOption as StreamDecoder
                : new StandardChatDecoder(yieldDecoderEvents ? e => decoderEvents.push(e) : () => {}, { knownToolNames });
        const decoderToolCalls: LLMToolCall[] = [];
        const takeDecoderEvents = function* (): Generator<DecodedEvent> {
            while (decoderEvents.length) {
                const event = decoderEvents.shift()!;
                if (event.type === 'tool_call') {
                    decoderToolCalls.push(...event.calls);
                    yield event;
                } else if (yieldDecoderEvents) {
                    yield event;
                }
            }
        };

        // Track accumulated tool calls across chunks
        const toolCallAccum: Map<number, {
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
        }> = new Map();

        let activeBody = body;
        let retriedWithTextTools = false;

        let usage: TokenUsageInfo | undefined;
        // Accumulates reasoning deltas from servers that stream a dedicated
        // `reasoning` / `reasoning_content` field (vLLM, DeepSeek-R1, etc.).
        let reasoningBuffer = '';

        while (true) {
            const stream = httpStream(url, {
                method: 'POST',
                headers: buildHeaders(this.options),
                body: activeBody,
                timeout: this.options.timeout ?? 120000,
            });

            try {
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
                                completion_tokens_details?: {
                                    reasoning_tokens?: number;
                                };
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
                                reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens,
                            };
                        }

                        const delta = parsed.choices?.[0]?.delta;
                        if (!delta) continue;

                        // Surface server-side reasoning deltas as thinking events.
                        const reasoningDelta = delta.reasoning ?? delta.reasoning_content;
                        if (reasoningDelta) {
                            reasoningBuffer += reasoningDelta;
                            decoder.pushReasoning?.(reasoningDelta);
                            if (yieldDecoderEvents) {
                                for (const event of takeDecoderEvents()) yield event;
                            } else {
                                yield { type: 'thinking', content: reasoningDelta };
                            }
                        }

                        if (delta.content) {
                            decoder.push(delta.content);
                            if (yieldDecoderEvents) {
                                for (const event of takeDecoderEvents()) yield event;
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
                break;
            } catch (error) {
                if (
                    !retriedWithTextTools
                    && tools?.length
                    && hasToolDefinitions(activeBody)
                    && isVllmAutoToolChoiceError(error)
                ) {
                    this.warnVllmToolFallback();
                    activeBody = withoutNativeTools(activeBody, tools);
                    retriedWithTextTools = true;
                    continue;
                }
                throw error;
            }
        }

        decoder.flush();
        if (yieldDecoderEvents) {
            for (const event of takeDecoderEvents()) yield event;
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
            : decoderToolCalls.length > 0
                ? decoderToolCalls
                : undefined;
        let cleanContent = decoder.getCleanContent();
        // Prefer the server's dedicated reasoning field; fall back to <think>
        // tags parsed from the content stream by the decoder.
        const decodedReasoning = decoder.getReasoning();
        let reasoning = decodedReasoning !== undefined ? decodedReasoning : yieldDecoderEvents ? undefined : reasoningBuffer;

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

        if (!finalToolCalls?.length && tools?.length && cleanContent) {
            const knownToolNames = new Set(tools.map(tool => tool.function.name));
            const recovered = recoverToolCallsFromText(cleanContent, knownToolNames, () => this.generateToolCallId());
            if (recovered) {
                finalToolCalls = recovered.calls;
                cleanContent = recovered.cleanContent;
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

    /** Cached endpoint-reported model metadata, keyed by model id. */
    private modelInfoCache = new Map<string, ModelMetadata>();

    override async getModelInfo(modelName?: string): Promise<ModelMetadata> {
        const model = modelName ?? this.options.model;
        const known = knownOpenAICompatModelInfo(this.options.url, model);
        if (known) return known;

        const cached = this.modelInfoCache.get(model);
        if (cached) return cached;

        // Ask the endpoint itself before falling back to the conservative
        // 8192 default: vLLM reports `max_model_len` per model card and
        // llama.cpp exposes `meta.n_ctx_train`. Without this, every local
        // vLLM/llama.cpp server is treated as an 8K-context model and
        // callers budget/truncate against the wrong window.
        try {
            const response = await httpRequest<{
                data?: Array<{ id: string; max_model_len?: number; meta?: { n_ctx_train?: number } }>;
            }>(this.buildUrl('/models'), {
                headers: buildHeaders(this.options),
                timeout: 5000,
            });
            if (response.ok) {
                const cards = response.data.data ?? [];
                const card = cards.find(m => m.id === model) ?? cards[0];
                const ctx = card?.max_model_len ?? card?.meta?.n_ctx_train;
                if (typeof ctx === 'number' && ctx > 0) {
                    const info: ModelMetadata = { model, contextLength: ctx };
                    this.modelInfoCache.set(model, info);
                    return info;
                }
            }
        } catch {
            // Endpoint variant without metadata — fall through to default
        }

        return super.getModelInfo(model);
    }

    private convertMessages(messages: LLMChatMessage[]): LLMChatMessage[] {
        return normalizeMessagesForOpenAICompat(messages);
    }

    private buildRequestParams(options?: ChatOptions): Record<string, unknown> {
        const params: Record<string, unknown> = {
            ...this.options.defaultParameters,
            ...options?.parameters,
        };
        if (options?.temperature !== undefined) params['temperature'] = options.temperature;
        applyMaxTokensParam(params, options?.maxTokens, this.options.url);

        // Unified thinking flag. Per-call overrides model config; only emitted
        // when explicitly set, so servers that reject unknown fields are
        // unaffected by default. OpenAI reasoning models (o-series / GPT-5) use
        // `reasoning_effort`; vLLM / Qwen use `chat_template_kwargs.enable_thinking`.
        // A user-supplied value (via parameters) always wins.
        const thinking = resolveThinking(options?.thinking, this.options.thinking);
        if (isCerebrasEndpoint(this.options.url)) {
            if (params['reasoning_effort'] === undefined && params['disable_reasoning'] === undefined) {
                if (thinking) {
                    params['reasoning_effort'] = thinking.enabled ? cerebrasReasoningEffort(thinking.level) : 'none';
                } else if (usesGemmaCerebrasReasoningDefault(this.options.model)) {
                    params['reasoning_effort'] = 'medium';
                }
            }
        } else if (thinking) {
            if (isOpenAIReasoningModel(this.options.model)) {
                if (params['reasoning_effort'] === undefined) {
                    params['reasoning_effort'] = thinking.enabled ? (thinking.level ?? 'medium') : 'minimal';
                }
            } else if (supportsChatTemplateKwargs(this.options.url)) {
                // `chat_template_kwargs` is a self-hosted vLLM/Qwen extension.
                // Official OpenAI and hosted OpenAI-compatible gateways (Cerebras,
                // Groq, Fireworks, …) reject unknown body fields with HTTP 400,
                // so only send it to endpoints not on the strict-host list.
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
