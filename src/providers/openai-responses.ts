/**
 * Universal LLM Client v3 — OpenAI Responses API Provider
 *
 * A SECOND OpenAI transport, distinct from `providers/openai.ts`:
 * that one speaks `/v1/chat/completions`, this one speaks `/responses`.
 *
 * Why a separate client rather than a flag on the existing one: the wire
 * formats share nothing that matters. Messages become `input` ITEMS, the
 * system prompt becomes a top-level `instructions` string, tool schemas are
 * flat instead of nested under `function`, reasoning is a first-class item
 * that must be echoed back, and the stream is a typed event feed rather than
 * `choices[].delta`. Bolting that onto the 1600-line chat/completions client
 * (which also carries the vLLM/gemma-native/Cerebras special cases) would
 * make both harder to reason about.
 *
 * The primary consumer is the ChatGPT backend (`chatgpt.com/backend-api/codex`),
 * which is Responses-ONLY and additionally requires:
 *   - `store: false`             (stateless; the backend refuses stored turns)
 *   - `include: ['reasoning.encrypted_content']` so reasoning survives across
 *     turns even though nothing is stored server-side
 *   - `stream: true` always      (there is no non-streaming mode — `chat()`
 *     below drains the event stream and assembles the final response)
 * It also works against `api.openai.com/v1/responses` with a plain API key.
 */

import { BaseLLMClient } from '../client.js';
import { httpStream, parseSSE } from '../http.js';
import { LLMHttpError, LLMProviderError } from '../errors.js';
import type {
    LLMClientOptions,
    LLMChatMessage,
    LLMChatResponse,
    LLMContentPart,
    LLMToolCall,
    LLMToolDefinition,
    ChatOptions,
    ModelMetadata,
    TokenUsageInfo,
} from '../interfaces.js';
import type { DecodedEvent } from '../stream-decoder.js';
import type { Auditor } from '../auditor.js';

// ============================================================================
// Options
// ============================================================================

/** Credentials for one request. Resolved per-call so token refresh stays outside the client. */
export interface ResponsesAuth {
    /** OAuth access token or API key, sent as `Authorization: Bearer …`. */
    readonly accessToken: string;
    /** ChatGPT account id — required by the ChatGPT backend, ignored by api.openai.com. */
    readonly accountId?: string;
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';
export type TextVerbosity = 'low' | 'medium' | 'high';

export interface ResponsesClientOptions extends LLMClientOptions {
    /**
     * Called before every request. Lets the caller refresh an expiring OAuth
     * token without reconstructing the client. Falls back to `options.apiKey`.
     */
    readonly authResolver?: () => Promise<ResponsesAuth>;
    /**
     * Top-level `instructions`. When set, it WINS over `system` messages —
     * those are demoted to `developer` input items instead of being hoisted.
     * The ChatGPT backend is tuned for Codex's canonical instructions, so
     * consumers targeting it should pass those here and let their own system
     * prompt ride along as a developer item.
     */
    readonly instructions?: string;
    /** `originator` header. The ChatGPT backend expects `codex_cli_rs`. */
    readonly originator?: string;
    /** Stable id sent as `session_id` + `conversation_id` — drives prompt caching. */
    readonly conversationId?: string;
    readonly reasoningEffort?: ReasoningEffort;
    readonly reasoningSummary?: ReasoningSummary;
    readonly textVerbosity?: TextVerbosity;
}

// ============================================================================
// Wire Types (Responses API)
// ============================================================================

type ResponsesRole = 'user' | 'assistant' | 'developer' | 'system';

interface ResponsesContentPart {
    readonly type: 'input_text' | 'output_text' | 'input_image';
    readonly text?: string;
    readonly image_url?: string;
}

type ResponsesInputItem =
    | { type: 'message'; role: ResponsesRole; content: ResponsesContentPart[] }
    | { type: 'function_call'; call_id: string; name: string; arguments: string }
    | { type: 'function_call_output'; call_id: string; output: string }
    | { type: 'reasoning'; id?: string; encrypted_content?: string; summary: unknown[] };

interface ResponsesFunctionTool {
    readonly type: 'function';
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
}

/** Raw `usage` block from `response.completed`. */
interface ResponsesUsage {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly total_tokens?: number;
    readonly input_tokens_details?: { readonly cached_tokens?: number };
    readonly output_tokens_details?: { readonly reasoning_tokens?: number };
}

// ============================================================================
// Model Variants
// ============================================================================

/**
 * Split a `model[:effort]` string. The Canvas model picker carries ONE string
 * per entry, so reasoning effort travels as a suffix (`gpt-5.2-codex:xhigh`)
 * rather than a second config field the UI would have to grow a control for.
 */
export function parseModelVariant(model: string): { model: string; effort?: ReasoningEffort } {
    const idx = model.lastIndexOf(':');
    if (idx <= 0) return { model };
    const base = model.slice(0, idx);
    const suffix = model.slice(idx + 1).toLowerCase();
    const efforts: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    if (!efforts.includes(suffix)) return { model };
    return { model: base, effort: suffix as ReasoningEffort };
}

// ============================================================================
// Client
// ============================================================================

export class ResponsesClient extends BaseLLMClient {
    private readonly responsesOptions: ResponsesClientOptions;
    /**
     * Encrypted reasoning items captured from the stream, keyed by the
     * `call_id` of the tool call they preceded.
     *
     * With `store: false` the server keeps nothing, so a multi-step tool loop
     * only keeps its chain of thought if we echo these items back verbatim
     * ahead of the matching `function_call`. Keyed by call_id (rather than
     * kept as a flat list) so it survives the caller rebuilding history from
     * its own message log between iterations — the common shape of an agent
     * loop, and the case where a positional list would silently misalign.
     */
    private readonly reasoningByCallId = new Map<string, ResponsesInputItem>();
    private warnedUnsupportedPart = false;

    constructor(options: ResponsesClientOptions, auditor?: Auditor) {
        const base = (options.url || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, '');
        super({ ...options, url: base }, auditor);
        this.responsesOptions = { ...options, url: base };
    }

    // ========================================================================
    // Request Assembly
    // ========================================================================

    private async buildHeaders(): Promise<Record<string, string>> {
        const auth = this.responsesOptions.authResolver
            ? await this.responsesOptions.authResolver()
            : { accessToken: this.responsesOptions.apiKey ?? '' };

        if (!auth.accessToken) {
            throw new LLMProviderError('openai-responses', 'No access token available — sign in first');
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${auth.accessToken}`,
            // The backend streams SSE unconditionally; asking for JSON gets a 406.
            accept: 'text/event-stream',
            'OpenAI-Beta': 'responses=experimental',
        };

        if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId;
        if (this.responsesOptions.originator) headers['originator'] = this.responsesOptions.originator;
        // Prompt caching is keyed off these; omitting them costs cache hits, not correctness.
        const conversationId = this.responsesOptions.conversationId;
        if (conversationId) {
            headers['session_id'] = conversationId;
            headers['conversation_id'] = conversationId;
        }
        if (this.responsesOptions.extraHeaders) {
            Object.assign(headers, this.responsesOptions.extraHeaders);
        }
        return headers;
    }

    /** Map internal content parts to Responses parts. Audio has no Responses equivalent. */
    private toContentParts(content: LLMChatMessage['content'], role: ResponsesRole): ResponsesContentPart[] {
        const textType = role === 'assistant' ? 'output_text' : 'input_text';

        if (typeof content === 'string') {
            return [{ type: textType, text: content }];
        }

        const parts: ResponsesContentPart[] = [];
        for (const part of content as LLMContentPart[]) {
            if (part.type === 'text') {
                parts.push({ type: textType, text: part.text });
            } else if (part.type === 'image_url') {
                // Images are input-only; an assistant turn can't carry one back.
                if (role === 'assistant') continue;
                parts.push({ type: 'input_image', image_url: part.image_url.url });
            } else if (!this.warnedUnsupportedPart) {
                this.warnedUnsupportedPart = true;
                console.warn('[openai-responses] Dropping unsupported content part: audio is not part of the Responses API');
            }
        }
        return parts;
    }

    /**
     * Convert the internal message list into Responses `input` items.
     * Returns the items plus the instructions string to send at top level.
     */
    private toInput(messages: LLMChatMessage[]): { input: ResponsesInputItem[]; instructions?: string } {
        const override = this.responsesOptions.instructions;
        const hoisted: string[] = [];
        const input: ResponsesInputItem[] = [];

        for (const message of messages) {
            if (message.role === 'system') {
                // No override: the system prompt IS the instructions (hoisted, in
                // order). With an override, it stays inline as a developer item so
                // the caller's prompt is not silently dropped.
                if (!override) {
                    const text = typeof message.content === 'string'
                        ? message.content
                        : this.toContentParts(message.content, 'developer').map(p => p.text ?? '').join('\n');
                    if (text) hoisted.push(text);
                } else {
                    input.push({ type: 'message', role: 'developer', content: this.toContentParts(message.content, 'developer') });
                }
                continue;
            }

            if (message.role === 'tool') {
                const callId = message.tool_call_id;
                if (!callId) {
                    console.warn('[openai-responses] Dropping tool message with no tool_call_id');
                    continue;
                }
                const output = typeof message.content === 'string'
                    ? message.content
                    : this.toContentParts(message.content, 'user').map(p => p.text ?? '').join('\n');
                input.push({ type: 'function_call_output', call_id: callId, output });
                continue;
            }

            if (message.role === 'assistant') {
                const parts = this.toContentParts(message.content, 'assistant');
                const hasText = parts.some(p => (p.text ?? '').length > 0);
                if (hasText) {
                    input.push({ type: 'message', role: 'assistant', content: parts });
                }
                for (const call of message.tool_calls ?? []) {
                    // Echo the encrypted reasoning that produced this call, ahead of it.
                    const reasoning = this.reasoningByCallId.get(call.id);
                    if (reasoning) input.push(reasoning);
                    input.push({
                        type: 'function_call',
                        call_id: call.id,
                        // History must use the SAME wire name the tool list
                        // declares, or the replayed call references a tool the
                        // model was never offered.
                        name: this.toWireToolName(call.function.name),
                        arguments: call.function.arguments,
                    });
                }
                continue;
            }

            input.push({ type: 'message', role: 'user', content: this.toContentParts(message.content, 'user') });
        }

        const instructions = override ?? (hoisted.length ? hoisted.join('\n\n') : undefined);
        return instructions === undefined ? { input } : { input, instructions };
    }

    /**
     * Coerce a tool name into the Responses API's `^[a-zA-Z0-9_-]+$` (max 64).
     *
     * chat/completions tolerates anything; the Responses API rejects the whole
     * request with HTTP 400 `Invalid 'tools[N].name'`. BentoKit registers tools
     * under their namespaced ids (`@core/watcher:watcher_create`), so WITHOUT
     * this every tool-bearing turn fails — and because a failing provider just
     * fails over, the symptom is "my model selection was ignored" rather than
     * any visible error.
     *
     * Deterministic, so the same tool maps to the same wire name on every call
     * and history stays consistent across turns.
     */
    private toWireToolName(name: string): string {
        return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool';
    }

    /** Wire name → original, so a tool call can be dispatched by the caller. */
    private toolNameAliases = new Map<string, string>();

    private rememberToolAliases(tools: readonly LLMToolDefinition[] | undefined): void {
        this.toolNameAliases.clear();
        for (const tool of tools ?? []) {
            const wire = this.toWireToolName(tool.function.name);
            if (wire !== tool.function.name) this.toolNameAliases.set(wire, tool.function.name);
        }
    }

    /** Flatten `{type:'function', function:{…}}` into the Responses tool shape. */
    private toTools(tools: readonly LLMToolDefinition[] | undefined): ResponsesFunctionTool[] | undefined {
        if (!tools?.length) return undefined;
        return tools.map(tool => ({
            type: 'function' as const,
            name: this.toWireToolName(tool.function.name),
            description: tool.function.description,
            parameters: tool.function.parameters as Record<string, unknown>,
        }));
    }

    private buildBody(messages: LLMChatMessage[], options?: ChatOptions): Record<string, unknown> {
        const { model, effort } = parseModelVariant(this.responsesOptions.model ?? 'gpt-5.2-codex');
        const { input, instructions } = this.toInput(messages);

        const resolvedEffort: ReasoningEffort =
            effort ?? this.responsesOptions.reasoningEffort ?? 'medium';

        const body: Record<string, unknown> = {
            model,
            input,
            // Mandatory on the ChatGPT backend: it refuses stored conversations,
            // and without the encrypted-content include the reasoning chain is
            // lost between tool-loop iterations.
            store: false,
            stream: true,
            include: ['reasoning.encrypted_content'],
            text: { verbosity: this.responsesOptions.textVerbosity ?? 'medium' },
        };

        if (instructions) body['instructions'] = instructions;

        if (resolvedEffort !== 'none') {
            body['reasoning'] = {
                effort: resolvedEffort,
                summary: this.responsesOptions.reasoningSummary ?? 'auto',
            };
        }

        this.rememberToolAliases(options?.tools);
        const tools = this.toTools(options?.tools);
        if (tools) {
            body['tools'] = tools;
            if (options?.toolChoice) body['tool_choice'] = options.toolChoice;
        }

        // Deliberately NOT forwarded: temperature, top_p, max_tokens. The Codex
        // backend rejects sampling overrides on these reasoning models, and
        // `max_output_tokens` truncates mid-tool-call rather than degrading.
        return body;
    }

    // ========================================================================
    // Streaming
    // ========================================================================

    async *chatStream(
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
        const url = `${this.responsesOptions.url}/responses`;
        const body = this.buildBody(messages, options);
        const headers = await this.buildHeaders();
        const start = Date.now();

        this.auditor.record({
            timestamp: start,
            type: 'stream_start',
            provider: 'openai-responses',
            model: String(body['model']),
        });

        let text = '';
        let reasoning = '';
        let usage: TokenUsageInfo | undefined;
        let finishReason: string | undefined;
        const toolCalls: LLMToolCall[] = [];
        /** Reasoning items seen since the last function_call, awaiting a call_id to key on. */
        let pendingReasoning: ResponsesInputItem[] = [];
        /** function_call arguments accumulated per output item. */
        const argAccum = new Map<string, { callId: string; name: string; args: string }>();

        const stream = httpStream(url, {
            method: 'POST',
            headers,
            body,
            // Per-chunk IDLE timeout. Reasoning models pause between visible
            // events; floor at 5 min so a healthy pause isn't killed.
            timeout: Math.max(this.responsesOptions.timeout ?? 300000, 300000),
            signal: options?.signal,
        });

        for await (const event of parseSSE(stream)) {
            let payload: Record<string, unknown>;
            try {
                payload = JSON.parse(event.data) as Record<string, unknown>;
            } catch {
                continue; // keep-alive / partial frame
            }

            // Prefer the JSON `type`: the SSE `event:` line is absent on some
            // proxies, while `type` is always present in the Responses feed.
            const type = typeof payload['type'] === 'string' ? payload['type'] : event.event;

            switch (type) {
                case 'response.output_text.delta': {
                    const delta = typeof payload['delta'] === 'string' ? payload['delta'] : '';
                    if (delta) {
                        text += delta;
                        yield { type: 'text', content: delta };
                    }
                    break;
                }

                case 'response.reasoning_summary_text.delta':
                case 'response.reasoning_text.delta': {
                    const delta = typeof payload['delta'] === 'string' ? payload['delta'] : '';
                    if (delta) {
                        reasoning += delta;
                        yield { type: 'thinking', content: delta };
                    }
                    break;
                }

                case 'response.output_item.added': {
                    const item = payload['item'] as Record<string, unknown> | undefined;
                    if (item?.['type'] === 'function_call') {
                        const key = this.itemKey(payload, item);
                        argAccum.set(key, {
                            callId: typeof item['call_id'] === 'string' ? item['call_id'] : key,
                            name: typeof item['name'] === 'string' ? item['name'] : '',
                            args: typeof item['arguments'] === 'string' ? item['arguments'] : '',
                        });
                    }
                    break;
                }

                case 'response.function_call_arguments.delta': {
                    const key = this.itemKey(payload);
                    const delta = typeof payload['delta'] === 'string' ? payload['delta'] : '';
                    const entry = argAccum.get(key);
                    if (entry) entry.args += delta;
                    break;
                }

                case 'response.output_item.done': {
                    const item = payload['item'] as Record<string, unknown> | undefined;
                    if (!item) break;

                    if (item['type'] === 'reasoning') {
                        // Hold it until we know which tool call it belongs to.
                        pendingReasoning.push({
                            type: 'reasoning',
                            ...(typeof item['id'] === 'string' ? { id: item['id'] } : {}),
                            ...(typeof item['encrypted_content'] === 'string'
                                ? { encrypted_content: item['encrypted_content'] }
                                : {}),
                            summary: Array.isArray(item['summary']) ? item['summary'] : [],
                        });
                        break;
                    }

                    if (item['type'] === 'function_call') {
                        const key = this.itemKey(payload, item);
                        const entry = argAccum.get(key);
                        const callId = typeof item['call_id'] === 'string' ? item['call_id'] : entry?.callId ?? key;
                        const wireName = typeof item['name'] === 'string' ? item['name'] : entry?.name ?? '';
                        // Hand the caller the name it registered, not the
                        // sanitized wire name it has never heard of.
                        const name = this.toolNameAliases.get(wireName) ?? wireName;
                        // The done event carries the complete arguments; fall back
                        // to the accumulated deltas when it doesn't.
                        const args = typeof item['arguments'] === 'string' && item['arguments']
                            ? item['arguments']
                            : entry?.args ?? '';
                        argAccum.delete(key);

                        for (const reasoningItem of pendingReasoning) {
                            this.reasoningByCallId.set(callId, reasoningItem);
                        }
                        pendingReasoning = [];

                        const call: LLMToolCall = {
                            id: callId,
                            type: 'function',
                            function: { name, arguments: args || '{}' },
                        };
                        toolCalls.push(call);
                        yield { type: 'tool_call', calls: [call] };
                    }
                    break;
                }

                case 'response.completed': {
                    const response = payload['response'] as Record<string, unknown> | undefined;
                    usage = this.toUsage(response?.['usage'] as ResponsesUsage | undefined, start);
                    finishReason = toolCalls.length ? 'tool_calls' : 'stop';
                    break;
                }

                case 'response.incomplete': {
                    const response = payload['response'] as Record<string, unknown> | undefined;
                    const details = response?.['incomplete_details'] as { reason?: string } | undefined;
                    finishReason = details?.reason ?? 'incomplete';
                    break;
                }

                case 'response.failed':
                case 'error': {
                    throw this.toError(payload);
                }

                default:
                    break;
            }
        }

        const message: LLMChatMessage = {
            role: 'assistant',
            content: text,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        };

        return {
            message,
            ...(finishReason ? { finishReason } : {}),
            ...(reasoning ? { reasoning } : {}),
            ...(usage ? { usage, lastCallUsage: usage } : {}),
            provider: 'openai-responses',
        };
    }

    /**
     * Stable key for an output item across `added` / `arguments.delta` / `done`.
     * `item_id` is present on most events; `output_index` is the fallback the
     * backend always sends.
     */
    private itemKey(payload: Record<string, unknown>, item?: Record<string, unknown>): string {
        const itemId = payload['item_id'] ?? item?.['id'];
        if (typeof itemId === 'string' && itemId) return itemId;
        const index = payload['output_index'];
        return typeof index === 'number' ? `idx:${index}` : 'idx:0';
    }

    private toUsage(raw: ResponsesUsage | undefined, start: number): TokenUsageInfo | undefined {
        if (!raw) return undefined;
        const inputTokens = raw.input_tokens ?? 0;
        const outputTokens = raw.output_tokens ?? 0;
        const durationMs = Date.now() - start;
        const usage: TokenUsageInfo = {
            inputTokens,
            outputTokens,
            totalTokens: raw.total_tokens ?? inputTokens + outputTokens,
            durationMs,
        };
        const cached = raw.input_tokens_details?.cached_tokens;
        const reasoningTokens = raw.output_tokens_details?.reasoning_tokens;
        return {
            ...usage,
            ...(cached !== undefined ? { cachedTokens: cached } : {}),
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
            ...(durationMs > 0 ? { tokensPerSecond: (outputTokens / durationMs) * 1000 } : {}),
        };
    }

    /**
     * Turn a `response.failed` / `error` frame into a typed error.
     *
     * Subscription quota exhaustion arrives here (not as an HTTP 429), so it is
     * mapped onto LLMHttpError(429) — that is what `classifyFailure` reads to
     * cool the provider down and fail over instead of retrying a dry account.
     */
    private toError(payload: Record<string, unknown>): Error {
        const response = payload['response'] as Record<string, unknown> | undefined;
        const errorObj = (response?.['error'] ?? payload['error'] ?? payload) as Record<string, unknown>;
        const message = typeof errorObj['message'] === 'string' ? errorObj['message'] : JSON.stringify(errorObj);
        const code = typeof errorObj['code'] === 'string' ? errorObj['code'] : '';
        const haystack = `${code} ${message}`;

        if (/usage_limit_reached|usage_not_included|rate_limit_exceeded|quota|usage limit/i.test(haystack)) {
            return new LLMHttpError(429, message, `${this.responsesOptions.url}/responses`);
        }
        if (/invalid_token|unauthorized|expired/i.test(haystack)) {
            return new LLMHttpError(401, message, `${this.responsesOptions.url}/responses`);
        }
        return new LLMProviderError('openai-responses', message);
    }

    // ========================================================================
    // Non-Streaming (assembled from the stream)
    // ========================================================================

    async chat(messages: LLMChatMessage[], options?: ChatOptions): Promise<LLMChatResponse> {
        // The Codex backend has no non-streaming mode — drain and assemble.
        const iterator = this.chatStream(messages, options);
        let result = await iterator.next();
        while (!result.done) {
            result = await iterator.next();
        }
        const response = result.value;
        if (!response) {
            throw new LLMProviderError('openai-responses', 'Stream ended without a response');
        }
        return response;
    }

    // ========================================================================
    // Capabilities
    // ========================================================================

    /**
     * The ChatGPT backend exposes no model-listing endpoint — the catalog is
     * fixed by the subscription, so consumers ship a static list.
     */
    async getModels(): Promise<string[]> {
        return [];
    }

    async embed(_text: string): Promise<number[]> {
        throw new LLMProviderError('openai-responses', 'Embeddings are not available on the Responses API');
    }

    override async getModelInfo(modelName?: string): Promise<ModelMetadata> {
        const { model } = parseModelVariant(modelName ?? this.responsesOptions.model ?? '');
        // Codex-family context windows; conservative floor for anything unknown.
        const contextLength = /codex-mini/.test(model) ? 128000 : 272000;
        return { contextLength };
    }

    /** Clear the cached encrypted reasoning (e.g. when a conversation is reset). */
    resetReasoningCache(): void {
        this.reasoningByCallId.clear();
    }
}
