/**
 * Universal LLM Client v3 — OpenAI-Compatible Provider
 *
 * Implements BaseLLMClient for OpenAI-compatible APIs.
 * Works with: OpenAI, OpenRouter, LM Studio, LlamaCpp, vLLM, Groq, Together.
 */

import { BaseLLMClient } from '../client.js';
import {
    resolveThinking,
    isOpenAIReasoningModel,
    supportsChatTemplateKwargs,
    isStrictOpenAICompatHost,
} from '../thinking.js';
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
import { extractGemmaThoughtChannels, stripGemmaChannelMarkers } from '../gemma-channel.js';
import { StreamLoopGuard } from '../stream-guard.js';

const VLLM_AUTO_TOOL_CHOICE_HINT =
    'vLLM rejected automatic tool choice. Retrying with text-level tool calling. To use native tool_calls, start vLLM with --enable-auto-tool-choice and --tool-call-parser <parser>.';

/**
 * Whether the OpenAI-compatible provider should omit `response_format` on the
 * wire (prompt-only structured output). Controlled by
 * {@link LLMClientOptions.omitResponseFormat} (default: send format when requested).
 *
 * Operators can set `omitResponseFormat: true` for engines that mishandle
 * structured-output headers. (A 2026-07-20 vLLM + Gemma-4 NVFP4 EngineCore
 * crash on `json_object` was fixed on the serving side; the option remains as
 * an escape hatch.)
 */
export function shouldOmitResponseFormatWire(options: {
    readonly omitResponseFormat?: boolean;
    readonly url?: string;
    readonly model?: string;
}): boolean {
    return options.omitResponseFormat === true;
}

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

/**
 * OpenAI-compat endpoints (vLLM, llama.cpp, gateways) rarely advertise
 * modality capabilities on `/v1/models`. Without a `vision` flag, BentoKit's
 * ProviderManager treats the model as text-only and **strips images** before
 * they ever reach the server — even when the served weights are multimodal
 * (e.g. Gemma-4 on vLLM, proven live via image OCR + describe benches).
 *
 * Infer a best-effort capability list from the model id so callers can route
 * images. Conservative: only families known to accept OpenAI-style
 * `image_url` parts. Tools are tagged for families with documented function
 * calling. Callers that need certainty should live-probe (CP image-probe).
 */
export function inferOpenAICompatCapabilities(model: string): string[] {
    const m = normalizeModelId(model);
    const caps = new Set<string>(['completion']);

    // Multimodal / vision-language families (OpenAI image_url or equivalent)
    const vision =
        /gemma-?4/.test(m) ||
        /gemma-?3(?!\s*embedding)/.test(m) || // Gemma 3 IT is multimodal; skip embeddinggemma
        /\bgpt-4o\b/.test(m) ||
        /\bgpt-4\.1\b/.test(m) ||
        /\bgpt-5\b/.test(m) ||
        /o[1-4](-|$)/.test(m) ||
        /claude-(3|4|sonnet|opus|haiku)/.test(m) ||
        /llava|bakllava|moondream|pixtral|molmo|internvl|minicpm-v|phi-4-multimodal|phi-3\.5-vision/.test(m) ||
        /qwen[-_.]?(2\.5-)?vl|qwen3-vl|qwen.*-vl|vl.*qwen/.test(m) ||
        /llama-?4/.test(m) ||
        /mistral-small.*vision|mistral-medium/.test(m) ||
        /glm-4v|glm-ocr|step-1v|aria\b|idefics|paligemma/.test(m);
    if (vision) caps.add('vision');

    // Native / OpenAI tool calling (not exhaustive; safe over-tag for chat IT models)
    const tools =
        /gemma-?4/.test(m) ||
        /\bgpt-4|\bgpt-5|\bo[1-4]/.test(m) ||
        /claude|qwen|llama|mistral|glm|kimi|deepseek|command-r|minimax/.test(m);
    if (tools) caps.add('tools');

    return [...caps];
}

function knownOpenAICompatModelInfo(url: string | undefined, model: string): ModelMetadata | undefined {
    if (!isCerebrasEndpoint(url)) return undefined;
    const contextLength = CEREBRAS_MODEL_CONTEXT_LENGTHS[normalizeModelId(model)];
    if (!contextLength) return undefined;
    return {
        model,
        contextLength,
        capabilities: inferOpenAICompatCapabilities(model),
    };
}

function withInferredCapabilities(model: string, info: ModelMetadata): ModelMetadata {
    if (info.capabilities?.length) return info;
    return { ...info, capabilities: inferOpenAICompatCapabilities(model) };
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

/** True for Gemma family model ids (ollama `gemma4:…`, vLLM `gemma-4-…`, HF names). */
export function isGemmaModelId(model: string): boolean {
    return /gemma/i.test(model);
}

/**
 * Dual-mode Gemma request defaults for OpenAI-compatible servers (vLLM).
 *
 * Goals (live Canvas incident + Google/vLLM docs):
 * - **Reasoning OFF:** pin `enable_thinking:false` so the chat template never
 *   freestyles a thought channel (`thought`×N degeneration with tools/vision).
 * - **Reasoning ON:** pin `enable_thinking:true` so the real thought channel
 *   opens correctly; keep Google's sampling so CoT doesn't collapse to loops.
 * - **Both:** temp 1.0 / top_p 0.95 / top_k 64 (Google standardized config);
 *   mild `repetition_penalty` (stronger when off) to break pure token runs
 *   without crushing legitimate restatement in CoT.
 *
 * Never overwrites caller-supplied sampling or an explicit
 * `chat_template_kwargs.enable_thinking`. Skips Cerebras (uses
 * `reasoning_effort` instead; rejects unknown fields).
 */
export function applyGemmaDualModeRequestDefaults(input: {
    readonly model: string;
    readonly url?: string;
    readonly body: Record<string, unknown>;
    /** Resolved thinking intent; `undefined` = caller did not set → default OFF. */
    readonly thinking?: { readonly enabled: boolean; readonly level?: string };
}): void {
    if (!isGemmaModelId(input.model)) return;
    if (isCerebrasEndpoint(input.url)) return;

    const { body, thinking } = input;
    const thinkingOn = thinking?.enabled === true;

    // Google standardized sampling — same for thinking and non-thinking.
    if (body['temperature'] === undefined) body['temperature'] = 1.0;
    if (body['top_p'] === undefined) body['top_p'] = 0.95;
    if (body['top_k'] === undefined) body['top_k'] = 64;

    // Anti-runaway without killing CoT diversity.
    // OFF: slightly stronger (stops freestyle "thoughtthought…" spam).
    // ON: gentler so intermediate reasoning can restate premises.
    if (body['repetition_penalty'] === undefined) {
        body['repetition_penalty'] = thinkingOn ? 1.05 : 1.1;
    }

    // Always pin enable_thinking on vLLM/self-hosted so the template is never
    // ambiguous. User-supplied kwargs win.
    if (supportsChatTemplateKwargs(input.url)) {
        const existing = (body['chat_template_kwargs'] as Record<string, unknown> | undefined) ?? {};
        if (existing['enable_thinking'] === undefined) {
            body['chat_template_kwargs'] = {
                ...existing,
                enable_thinking: thinkingOn,
            };
        }
    }
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

/** True when a tool-call arguments payload is a JSON object/array literal. */
function isValidToolArgumentsJson(args: unknown): boolean {
    if (typeof args !== 'string') return false;
    try {
        JSON.parse(args);
        return true;
    } catch {
        return false;
    }
}

/**
 * Outbound history frames must NEVER carry non-JSON tool-call arguments:
 * vLLM's serving layer json.loads-validates every assistant tool_calls
 * frame in the request and 400s the whole turn ("Unterminated string
 * starting at: line 1 column N") when one is malformed — observed live
 * after a max_tokens-truncated call left partial arguments in history.
 * The frame is informational (the paired tool result tells the story), so
 * a stub preserves the exchange without poisoning the request.
 */
function sanitizeOutboundToolCalls(
    toolCalls: LLMChatMessage['tool_calls'],
): LLMChatMessage['tool_calls'] {
    if (!toolCalls?.length) return toolCalls;
    if (toolCalls.every(tc => isValidToolArgumentsJson(tc.function.arguments))) return toolCalls;
    return toolCalls.map(tc =>
        isValidToolArgumentsJson(tc.function.arguments)
            ? tc
            : {
                ...tc,
                function: {
                    ...tc.function,
                    arguments: JSON.stringify({ _invalid: 'arguments were truncated/malformed and stubbed' }),
                },
            },
    );
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
        normalized.tool_calls = sanitizeOutboundToolCalls(message.tool_calls);
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

/**
 * Strip trailing junk a server-side tool parser may leave on a tool NAME
 * (`"sessions("` → `"sessions"`). Only a trailing run of opener/whitespace
 * characters is removed — anything else passes through unchanged so
 * downstream "unknown tool" reporting still sees the evidence.
 */
export function sanitizeToolCallName(raw: string): string {
    return raw.trim().replace(/[({\s]+$/u, '');
}

/**
 * Best-effort recovery for a non-JSON tool-argument string: tolerate a
 * trailing `)` run left by a sliced `name({...})` form, then parse strict
 * JSON, then gemma pseudo-JSON — but ONLY for balanced non-strict brace
 * bodies. A truncated strict-JSON string (`{"key": "va`) must return null
 * untouched: the malformed-arguments stub machinery owns that case, and
 * lenient pseudo-JSON parsing would silently mangle it instead.
 */
export function recoverLooseToolArguments(rawArgs: string): string | null {
    const trimmed = rawArgs.trim();
    if (!trimmed) return '{}';

    const stripped = trimmed.replace(/[)\s]+$/u, '');
    const candidates = stripped !== trimmed && stripped.endsWith('}') ? [stripped, trimmed] : [trimmed];
    for (const candidate of candidates) {
        const obj = parseJsonObject(candidate);
        if (obj) return JSON.stringify(obj);
    }

    const loose = stripped.endsWith('}') ? stripped : trimmed;
    if (loose.startsWith('{') && loose.endsWith('}') && !loose.startsWith('{"')) {
        try {
            return gemmaArgsToJson(loose.slice(1, -1).trim());
        } catch {
            return null;
        }
    }
    return null;
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

        // Handle structured output. Some engines (vLLM Gemma-4 NVFP4) hard-crash
        // on wire `response_format` — omit and rely on prompt discipline.
        const omitWireFormat = shouldOmitResponseFormatWire({
            omitResponseFormat: this.options.omitResponseFormat,
            url: this.options.url,
            model: this.options.model,
        });
        if (!omitWireFormat) {
            const schemaOptions = this.extractSchemaOptions(options);
            if (schemaOptions) {
                body['response_format'] = this.buildResponseFormat(schemaOptions);
            } else if (options?.responseFormat) {
                body['response_format'] = options.responseFormat;
            }
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
            // Diffusion vLLM builds generate exactly ONE 256-token block when
            // max_tokens is omitted — long turns get truncated mid-thought.
            // Give the model a real budget unless the caller set one.
            if (body['max_tokens'] == null) body['max_tokens'] = 4096;
        }

        this.applyFamilySamplingDefaults(body, this.resolveCallThinking(options));
        await this.applyDefaultOutputBound(body, messages, tools);

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
                // Local single-request inference (vLLM/llama.cpp on busy GPUs)
                // routinely exceeds 30s; align with the BentoKit module client.
                timeout: this.options.timeout ?? 60000,
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
        // Join both fields when a gateway populates them differently instead
        // of silently dropping one (defensive — most servers set exactly one).
        const serverReasoning =
            [choice.message.reasoning, choice.message.reasoning_content]
                .filter((value): value is string => typeof value === 'string' && value.length > 0)
                .join('\n\n') || undefined;
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
        } else if (isGemmaModelId(this.options.model) && content) {
            // Autoregressive Gemma-4 on vLLM without `--reasoning-parser gemma4`
            // embeds the thought channel in `content`. Split it so callers get
            // clean answers + reasoning (same contract as the stream path).
            const extracted = extractGemmaThoughtChannels(content);
            if (extracted.found) {
                content = extracted.content.trim();
                if (extracted.reasoning) {
                    reasoning = reasoning
                        ? `${reasoning}\n\n${extracted.reasoning}`
                        : extracted.reasoning;
                }
            }
            // Unclosed / truncated thought channel (max_tokens mid-CoT): keep
            // markers out of the user-visible answer.
            if (/<\|channel/i.test(content) || /<\|thought/i.test(content)) {
                const unclosed = content.match(
                    /<\|channel\|?>\s*'?\s*(?:thought|think)\s*'?\s*\r?\n?([\s\S]*)$/i,
                );
                if (unclosed) {
                    const thought = (unclosed[1] ?? '').trim();
                    if (thought) {
                        reasoning = reasoning ? `${reasoning}\n\n${thought}` : thought;
                    }
                    content = content.slice(0, unclosed.index).trim();
                } else {
                    content = stripGemmaChannelMarkers(content).trim();
                }
            }
            if (reasoning) reasoning = stripGemmaChannelMarkers(reasoning);
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
            // See the chat() gemma-native block: parser-less diffusion vLLM
            // needs an explicit output budget or it stops after one block.
            if (body['max_tokens'] == null) body['max_tokens'] = 4096;
        }

        this.applyFamilySamplingDefaults(body, this.resolveCallThinking(options));
        await this.applyDefaultOutputBound(body, messages, tools);

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'stream_start',
            provider: 'openai',
            model: this.options.model,
        });

        // Client-side runaway protection: feed every streamed delta (content
        // AND reasoning — reasoning loops are the common failure) into the
        // guard; on detection, abort the socket so the SERVER stops generating.
        const loopGuard = new StreamLoopGuard();
        const loopAbort = new AbortController();
        const effectiveSignal = options?.signal
            ? AbortSignal.any([options.signal, loopAbort.signal])
            : loopAbort.signal;
        const abortOnLoop = (): boolean => {
            const d = loopGuard.detection;
            if (!d) return false;
            console.warn(
                `[openai] Stream loop guard triggered (${d.reason}${d.pattern ? `: "${d.pattern}" ×${d.repeats}` : ''}) after ${d.totalChars} chars — aborting generation`,
            );
            loopAbort.abort();
            return true;
        };

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
        // Deltas already yielded to the consumer. The vLLM tool-choice 400
        // fires pre-stream, so a retry after ANY emitted delta would replay
        // content the caller already received — guard against it.
        let emittedDeltas = 0;
        // Natural finish reason from the final chunk ('stop' | 'tool_calls' |
        // 'length' | ...). 'length' means the output cap cut the generation —
        // any accumulated tool call is partial by construction.
        let lastFinishReason: string | undefined;

        let usage: TokenUsageInfo | undefined;
        // Accumulates reasoning deltas from servers that stream a dedicated
        // `reasoning` / `reasoning_content` field (vLLM, DeepSeek-R1, etc.).
        let reasoningBuffer = '';
        // Head-of-stream buffer for the thinking channel — see the marker
        // filter at the reasoning-delta yield site. null = filter done.
        let thinkingHeadPending: string | null = '';

        while (true) {
            const stream = httpStream(url, {
                method: 'POST',
                headers: buildHeaders(this.options),
                body: activeBody,
                // Per-chunk IDLE timeout (resets on every chunk — see httpStream).
                // Thinking models legitimately pause between visible chunks;
                // floor at 5 minutes so a healthy long pause isn't killed while
                // a genuinely wedged stream still aborts.
                timeout: Math.max(this.options.timeout ?? 300000, 300000),
                // Caller aborts + loop-guard aborts MUST reach the socket;
                // without this the server keeps generating after a cancel.
                signal: effectiveSignal,
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
                        if (delta.content || delta.reasoning || delta.reasoning_content || delta.tool_calls) {
                            emittedDeltas++;
                        }

                        // Surface server-side reasoning deltas as thinking events.
                        const reasoningDelta = delta.reasoning ?? delta.reasoning_content;
                        if (reasoningDelta) {
                            reasoningBuffer += reasoningDelta;
                            decoder.pushReasoning?.(reasoningDelta);
                            if (yieldDecoderEvents) {
                                for (const event of takeDecoderEvents()) yield event;
                            } else {
                                // Head-of-stream marker filter: gemma leaks literal
                                // channel markers (e.g. `<|channel|>' think'`) at the
                                // START of the reasoning stream when the server-side
                                // parser routed the text but kept the marker. Buffer
                                // the head until a newline (or 96 chars) so a marker
                                // split across chunks is stripped before display.
                                if (thinkingHeadPending !== null) {
                                    thinkingHeadPending += reasoningDelta;
                                    if (thinkingHeadPending.includes('\n') || thinkingHeadPending.length >= 96) {
                                        const cleaned = stripGemmaChannelMarkers(thinkingHeadPending);
                                        thinkingHeadPending = null;
                                        if (cleaned) yield { type: 'thinking', content: cleaned };
                                    }
                                } else {
                                    yield { type: 'thinking', content: reasoningDelta };
                                }
                            }
                            if (loopGuard.push(reasoningDelta) && abortOnLoop()) break;
                        }

                        if (delta.content) {
                            decoder.push(delta.content);
                            if (yieldDecoderEvents) {
                                for (const event of takeDecoderEvents()) yield event;
                            } else {
                                yield { type: 'text', content: delta.content };
                            }
                            if (loopGuard.push(delta.content) && abortOnLoop()) break;
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
                                // Tool-call ARGUMENTS are a loop channel too: a model
                                // with content and reasoning both empty can still spiral
                                // inside e.g. a think-tool argument (observed live).
                                if (tc.function?.arguments && loopGuard.push(tc.function.arguments) && abortOnLoop()) {
                                    break;
                                }
                            }
                            if (loopGuard.detection) break;
                        }

                        if (parsed.choices?.[0]?.finish_reason) {
                            lastFinishReason = parsed.choices[0].finish_reason;
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
                // Loop-guard abort races the in-flight read — the stream was
                // intentionally killed; salvage what streamed as a clean end.
                if (loopGuard.detection) break;
                if (
                    !retriedWithTextTools
                    && emittedDeltas === 0
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
        // Flush a still-buffered thinking head (short reasoning that never hit
        // the newline/size threshold).
        if (thinkingHeadPending) {
            const cleaned = stripGemmaChannelMarkers(thinkingHeadPending);
            thinkingHeadPending = null;
            if (cleaned) yield { type: 'thinking', content: cleaned };
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

        // A guard-aborted stream was cut mid-generation: any accumulated tool
        // call is partial by construction (its argument tail is the loop
        // garbage that triggered the abort) — never execute it. Same for a
        // 'length'-truncated stream whose accumulated arguments don't parse:
        // executing them misfires, and re-sending the partial JSON in the
        // next request makes vLLM 400 the whole turn ("Unterminated string").
        let finalToolCalls = loopGuard.detection
            ? undefined
            : toolCallAccum.size > 0
                ? Array.from(toolCallAccum.values()).map(tc => this.normalizeToolCall(tc))
                : decoderToolCalls.length > 0
                    ? decoderToolCalls
                    : undefined;
        if (finalToolCalls?.length) {
            const valid = finalToolCalls.filter(tc => isValidToolArgumentsJson(tc.function.arguments));
            if (valid.length < finalToolCalls.length) {
                console.warn(
                    `[openai] Dropped ${finalToolCalls.length - valid.length} tool call(s) with malformed arguments (finish_reason=${lastFinishReason ?? 'unknown'})`,
                );
                finalToolCalls = valid.length > 0 ? valid : undefined;
            }
        }
        let cleanContent = stripGemmaChannelMarkers(decoder.getCleanContent());
        // Prefer the server's dedicated reasoning field; fall back to <think>
        // tags parsed from the content stream by the decoder. Strip any leaked
        // channel markers in either case (observed: `<|channel|>' think'` at
        // the head of vLLM gemma reasoning).
        const decodedReasoning = decoder.getReasoning();
        let reasoning = decodedReasoning !== undefined ? decodedReasoning : yieldDecoderEvents ? undefined : reasoningBuffer;
        if (reasoning) reasoning = stripGemmaChannelMarkers(reasoning);

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

        if (!finalToolCalls?.length && tools?.length && cleanContent && !loopGuard.detection) {
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
            // Consumers can tell a guard-aborted turn from a natural stop and
            // e.g. nudge the model instead of trusting the truncated output.
            // The natural finish_reason ('length' etc.) flows through so the
            // tool loop's truncation handling can react.
            ...(loopGuard.detection
                ? { finishReason: 'degeneration' }
                : lastFinishReason
                    ? { finishReason: lastFinishReason }
                    : {}),
        };
    }

    private normalizeToolCall(
        toolCall: Partial<LLMToolCall> & { function?: Partial<LLMToolCall['function']> },
    ): LLMToolCall {
        // Boundary defense: server-side tool parsers (observed with vLLM's
        // gemma4 parser on pseudo-call text) can deliver names with trailing
        // junk ("sessions(") and argument strings that aren't valid JSON.
        // Executing those verbatim burns a whole turn on "Unknown tool: x("
        // + "Unterminated string" errors the model cannot self-correct from.
        const name = sanitizeToolCallName(toolCall.function?.name || '');
        let args = this.normalizeToolArguments(toolCall.function?.arguments);
        if (!isValidToolArgumentsJson(args)) {
            const recovered = recoverLooseToolArguments(args);
            if (recovered) args = recovered;
        }
        return {
            ...toolCall,
            id: toolCall.id || this.generateToolCallId(),
            type: 'function',
            function: {
                ...toolCall.function,
                name,
                arguments: args,
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

    /**
     * Context length we positively KNOW (endpoint metadata probe or the known-
     * model map) — never the conservative 8192 fallback. Undefined for cloud
     * endpoints that expose no window metadata. Negative results are cached so
     * cloud endpoints pay the /models probe exactly once per client.
     */
    private knownWindowCache = new Map<string, number | null>();

    private async resolveKnownContextLength(model: string): Promise<number | undefined> {
        const cached = this.knownWindowCache.get(model);
        if (cached !== undefined) return cached ?? undefined;
        // Only a REAL advertised window counts here. getModelInfo()'s conservative
        // 8192 default is for budgeting callers — feeding it into output-bounding
        // would make every server-managed cloud API look like an 8K-window backend
        // and silently cap max_tokens, breaking applyDefaultOutputBound's "cloud
        // APIs keep today's behavior" contract.
        const probed = await this.probeContextLength(model);
        this.knownWindowCache.set(model, probed ?? null);
        return probed ?? undefined;
    }

    /**
     * Probe the endpoint's REAL context window for a model: the known-model map
     * first, then the live `/models` card (vLLM `max_model_len` / llama.cpp
     * `meta.n_ctx_train`). Returns `undefined` when the endpoint advertises no
     * window — callers decide whether to apply a default (budgeting) or leave
     * the request unbounded (output-bounding).
     */
    private async probeContextLength(model: string): Promise<number | undefined> {
        const known = knownOpenAICompatModelInfo(this.options.url, model);
        if (known?.contextLength) return known.contextLength;
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
                if (typeof ctx === 'number' && ctx > 0) return ctx;
            }
        } catch {
            // Endpoint variant without metadata — unknown window.
        }
        return undefined;
    }

    /**
     * Family-aware sampling + dual-mode thinking defaults (Gemma on/off).
     * See {@link applyGemmaDualModeRequestDefaults}.
     */
    private applyFamilySamplingDefaults(
        body: Record<string, unknown>,
        thinking?: { readonly enabled: boolean; readonly level?: string },
    ): void {
        applyGemmaDualModeRequestDefaults({
            model: this.options.model,
            url: this.options.url,
            body,
            thinking,
        });
    }

    /**
     * Bound the output when the caller didn't. Hard-window backends treat an
     * omitted max_tokens as "generate until the window fills" — a reasoning
     * loop then runs for minutes and the oversized result overflows the next
     * request. Only applies when the endpoint's REAL window is known (vLLM
     * max_model_len / llama.cpp n_ctx_train / known-model map): cloud APIs
     * with server-managed defaults keep today's behavior.
     *
     * Thinking-ON turns get a higher floor/cap so a real CoT + answer can finish
     * without being clipped into another retry spiral.
     */
    private async applyDefaultOutputBound(
        body: Record<string, unknown>,
        messages: LLMChatMessage[],
        tools: LLMToolDefinition[] | undefined,
    ): Promise<void> {
        if (body['max_tokens'] != null || body['max_completion_tokens'] != null) return;
        const window = await this.resolveKnownContextLength(this.options.model);
        if (!window) return;
        const promptChars = JSON.stringify(messages).length + (tools?.length ? JSON.stringify(tools).length : 0);
        const promptEstimate = Math.ceil(promptChars / 4);
        const MARGIN = 512;
        const thinkingOn =
            (body['chat_template_kwargs'] as { enable_thinking?: boolean } | undefined)?.enable_thinking === true;
        // Thinking needs headroom for the thought channel + final answer.
        // Without a high enough floor, enable_thinking:true burns the whole
        // budget inside CoT and returns empty content (measured live).
        const CAP = thinkingOn ? 16_384 : 8_192;
        const FLOOR = thinkingOn ? 2_048 : 256;
        const bound = Math.max(FLOOR, Math.min(CAP, window - promptEstimate - MARGIN));
        // OpenAI reasoning models reject `max_tokens` — use `max_completion_tokens`.
        if (isOpenAIReasoningModel(this.options.model) && isStrictOpenAICompatHost(this.options.url)) {
            body['max_completion_tokens'] = bound;
        } else {
            body['max_tokens'] = bound;
        }
    }

    override async getModelInfo(modelName?: string): Promise<ModelMetadata> {
        const model = modelName ?? this.options.model;
        const known = knownOpenAICompatModelInfo(this.options.url, model);
        if (known) return known;

        const cached = this.modelInfoCache.get(model);
        if (cached) return cached;

        // Ask the endpoint for its real window (vLLM reports `max_model_len` per
        // model card, llama.cpp exposes `meta.n_ctx_train`) before falling back
        // to the conservative 8192 default — otherwise every local vLLM/llama.cpp
        // server is treated as an 8K-context model and callers budget/truncate
        // against the wrong window. The fallback keeps this method total so
        // budgeting callers always get a number; output-bounding instead uses
        // resolveKnownContextLength(), which never applies the fallback.
        //
        // Capabilities are almost never on the card — attach family inference
        // so multimodal models (Gemma-4, etc.) are not treated as text-only.
        const probed = await this.probeContextLength(model);
        const info = withInferredCapabilities(model, {
            model,
            contextLength: probed ?? 8192,
        });
        this.modelInfoCache.set(model, info);
        return info;
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
        // when explicitly set for non-Gemma models (so servers that reject
        // unknown fields are unaffected). OpenAI reasoning models use
        // `reasoning_effort`; vLLM / Qwen use `chat_template_kwargs.enable_thinking`.
        // Gemma on vLLM is special-cased below + in applyGemmaDualModeRequestDefaults
        // so enable_thinking is ALWAYS pinned (on or off) — ambiguity freestyles
        // a broken thought channel.
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
                // existing (user parameters) wins over our enable_thinking key order
                params['chat_template_kwargs'] = { enable_thinking: thinking.enabled, ...existing };
            }
        }

        // gpt-5.x / o-series reasoning models on strict hosted OpenAI-compat
        // endpoints (api.openai.com, …) reject several /v1/chat/completions params
        // with HTTP 400. Normalize the ones we may have set — all share one
        // predicate (reasoning model AND strict host):
        if (isOpenAIReasoningModel(this.options.model) && isStrictOpenAICompatHost(this.options.url)) {
            // (a) `max_tokens` is unsupported on these models — rename to
            //     `max_completion_tokens` ("Unsupported parameter: 'max_tokens' …
            //     Use 'max_completion_tokens' instead.").
            if (params['max_tokens'] !== undefined && params['max_completion_tokens'] === undefined) {
                params['max_completion_tokens'] = params['max_tokens'];
            }
            delete params['max_tokens'];
            // (b) non-default `temperature` is rejected — omit it (server default = 1).
            delete params['temperature'];
            // (c) `reasoning_effort` is rejected ALONGSIDE function tools unless
            //     it is 'none' (routing tool turns through /v1/responses is the
            //     alternative; forcing 'none' is the minimal in-band fix).
            if ((options?.tools?.length ?? 0) > 0) {
                params['reasoning_effort'] = 'none';
            }
        }
        return params;
    }

    /** Resolve thinking for a call (shared by chat + stream body assembly). */
    private resolveCallThinking(options?: ChatOptions) {
        return resolveThinking(options?.thinking, this.options.thinking);
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
