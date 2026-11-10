/**
 * Universal LLM Client v3 — Anthropic Messages API Provider
 *
 * Implements BaseLLMClient for Anthropic's Messages API (Claude).
 * Uses the custom Anthropic protocol — NOT OpenAI-compatible.
 *
 * Key differences from OpenAI:
 *   - Endpoint: POST /v1/messages (not /chat/completions)
 *   - Auth: x-api-key header (not Authorization: Bearer)
 *   - System prompt: top-level `system` field, not a message
 *   - Messages: content is always an array of content blocks
 *   - Tool calls: `tool_use` content blocks (not tool_calls array)
 *   - Tool results: `tool_result` content blocks in user messages
 *   - Streaming: content_block_start/delta/stop events with typed deltas
 */

import { BaseLLMClient } from '../client.js';
import { resolveThinking, anthropicThinkingBudget } from '../thinking.js';
import { httpRequest, httpStream, parseSSE } from '../http.js';
import { LLMHttpError } from '../errors.js';
import { StandardChatDecoder } from '../stream-decoder.js';
import type {
    LLMClientOptions,
    LLMChatMessage,
    LLMChatResponse,
    LLMToolCall,
    LLMToolDefinition,
    ChatOptions,
    TokenUsageInfo,
    ModelMetadata,
    LLMContentPart,
    LLMMessageContent,
    ThinkingLevel,
} from '../interfaces.js';
import type { DecodedEvent } from '../stream-decoder.js';
import type { Auditor } from '../auditor.js';

// ============================================================================
// Anthropic-Specific Types
// ============================================================================

/** Anthropic content block types */
interface AnthropicTextBlock {
    readonly type: 'text';
    readonly text: string;
}

interface AnthropicImageBlock {
    readonly type: 'image';
    readonly source: {
        readonly type: 'base64' | 'url';
        readonly media_type?: string;
        readonly data?: string;
        readonly url?: string;
    };
}

interface AnthropicToolUseBlock {
    readonly type: 'tool_use';
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
    readonly type: 'tool_result';
    readonly tool_use_id: string;
    readonly content: string | AnthropicTextBlock[];
}

interface AnthropicThinkingBlock {
    readonly type: 'thinking';
    readonly thinking: string;
    readonly signature: string;
}

interface AnthropicRedactedThinkingBlock {
    readonly type: 'redacted_thinking';
    readonly data: string;
}

/** A thinking block as the API returned it, kept to be sent back verbatim. */
type AnthropicReplayedThinking = AnthropicThinkingBlock | AnthropicRedactedThinkingBlock;

type AnthropicContentBlock = (
    | AnthropicTextBlock
    | AnthropicImageBlock
    | AnthropicToolUseBlock
    | AnthropicToolResultBlock
    | AnthropicThinkingBlock
    | AnthropicRedactedThinkingBlock
) & { readonly cache_control?: { readonly type: 'ephemeral' } };

/** Anthropic message format */
interface AnthropicMessage {
    readonly role: 'user' | 'assistant';
    readonly content: string | AnthropicContentBlock[];
}

/** Anthropic tool definition (uses input_schema, not parameters) */
interface AnthropicToolDef {
    readonly name: string;
    readonly description: string;
    readonly input_schema: {
        readonly type: 'object';
        readonly properties?: Record<string, unknown>;
        readonly required?: string[];
    };
}

/** Anthropic request body */
interface AnthropicRequest {
    readonly model: string;
    readonly messages: AnthropicMessage[];
    readonly max_tokens: number;
    readonly cache_control?: { readonly type: 'ephemeral' };
    readonly system?:
        | string
        | Array<{
              type: 'text';
              text: string;
              cache_control?: { type: 'ephemeral' };
          }>;
    readonly tools?: AnthropicToolDef[];
    readonly tool_choice?: { readonly type: 'auto' | 'any' | 'tool'; readonly name?: string };
    readonly stream?: boolean;
    readonly temperature?: number;
    readonly thinking?:
        | { readonly type: 'enabled'; readonly budget_tokens: number; readonly block_binding?: AnthropicBlockBinding }
        | {
              readonly type: 'adaptive';
              readonly display?: 'summarized' | 'omitted';
              readonly block_binding?: AnthropicBlockBinding;
          }
        | { readonly type: 'disabled' | 'between_tools' };
    readonly output_config?: { readonly effort: AnthropicEffort };
}

/**
 * What the API does with a replayed thinking block whose conversation changed
 * since the block was made. `drop_block` drops it (not billed) instead of
 * failing the request. Needs {@link THINKING_BINDING_BETA}.
 */
interface AnthropicBlockBinding {
    readonly prefix_mismatch_behavior: 'drop_block';
}

/** Beta that accepts `thinking.block_binding`. */
const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/** Tool calls whose thinking is kept for replay; the oldest are forgotten first. */
const MAX_REPLAYED_TOOL_CALLS = 512;

/** Whether this request sends thinking blocks back (and so carries `block_binding`). */
function carriesReplayedThinking(body: AnthropicRequest | undefined): boolean {
    const thinking = body?.thinking;
    return thinking !== undefined && 'block_binding' in thinking && thinking.block_binding !== undefined;
}

/** Thinking shapes a model card can list. */
type AnthropicThinkingType = 'enabled' | 'adaptive' | 'disabled' | 'between_tools';

/** `output_config.effort` levels, lowest first. */
type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const ANTHROPIC_EFFORTS: readonly AnthropicEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Anthropic usage counters; input_tokens excludes cache reads and writes. */
interface AnthropicUsage {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
}

interface AnthropicResponse {
    readonly id: string;
    readonly type: 'message';
    readonly role: 'assistant';
    readonly content: AnthropicContentBlock[];
    readonly model: string;
    readonly stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
    readonly usage: AnthropicUsage;
}

/** Anthropic model from models list */
interface AnthropicModelInfo {
    readonly id: string;
    readonly display_name: string;
    readonly created_at: string;
    readonly type: 'model';
    /** Input window in tokens. Anthropic-compatible servers may omit it. */
    readonly max_input_tokens?: number;
    /** What the model accepts. Anthropic-compatible servers may omit it. */
    readonly capabilities?: {
        readonly image_input?: { readonly supported?: boolean };
        readonly thinking?: {
            readonly supported?: boolean;
            /** Which `thinking.type` values the model accepts. */
            readonly types?: Partial<Record<AnthropicThinkingType, { readonly supported?: boolean }>>;
        };
        /** Which `output_config.effort` levels the model accepts. */
        readonly effort?: { readonly supported?: boolean } & Partial<
            Record<AnthropicEffort, { readonly supported?: boolean }>
        >;
    };
}

/**
 * The `thinking.type` that turns thinking off on this model: `disabled`, or
 * `between_tools` where the card lists only that. Undefined when the card
 * lists neither, as on models that always think.
 */
function thinkingOffSwitch(card: AnthropicModelInfo | undefined): 'disabled' | 'between_tools' | undefined {
    const types = card?.capabilities?.thinking?.types;
    if (types?.disabled?.supported) return 'disabled';
    if (types?.between_tools?.supported) return 'between_tools';
    return undefined;
}

/**
 * The API's answer when a model takes no `temperature` at all ("`temperature`
 * is deprecated for this model."). An out-of-range value gets a different
 * error ("temperature: range: 0..1") and does not match.
 */
const TEMPERATURE_REJECTED = /`?temperature`? is (?:deprecated|not supported)/i;

/**
 * The effort level a thinking level asks for on this model: the same name
 * (`minimal` asks for `low`), or else the nearest level the card lists, the
 * lower one on a tie. Undefined when the card lists no effort levels.
 */
function effortForLevel(level: ThinkingLevel, card: AnthropicModelInfo): AnthropicEffort | undefined {
    const effort = card.capabilities?.effort;
    if (!effort?.supported) return undefined;
    const wanted = ANTHROPIC_EFFORTS.indexOf(level === 'minimal' ? 'low' : level);
    let best: AnthropicEffort | undefined;
    for (const candidate of ANTHROPIC_EFFORTS) {
        if (!effort[candidate]?.supported) continue;
        const distance = Math.abs(ANTHROPIC_EFFORTS.indexOf(candidate) - wanted);
        if (best === undefined || distance < Math.abs(ANTHROPIC_EFFORTS.indexOf(best) - wanted)) best = candidate;
    }
    return best;
}

// ============================================================================
// Streaming Event Types
// ============================================================================

interface StreamMessageStart {
    readonly type: 'message_start';
    readonly message: AnthropicResponse;
}

interface StreamContentBlockStart {
    readonly type: 'content_block_start';
    readonly index: number;
    readonly content_block: AnthropicContentBlock;
}

interface StreamContentBlockDelta {
    readonly type: 'content_block_delta';
    readonly index: number;
    readonly delta:
        | { readonly type: 'text_delta'; readonly text: string }
        | { readonly type: 'input_json_delta'; readonly partial_json: string }
        | { readonly type: 'thinking_delta'; readonly thinking: string }
        | { readonly type: 'signature_delta'; readonly signature: string };
}

interface StreamContentBlockStop {
    readonly type: 'content_block_stop';
    readonly index: number;
}

interface StreamMessageDelta {
    readonly type: 'message_delta';
    readonly delta: {
        readonly stop_reason: string | null;
        readonly stop_sequence?: string | null;
    };
    readonly usage: Partial<AnthropicUsage>;
}

interface StreamMessageStop {
    readonly type: 'message_stop';
}

type AnthropicStreamEvent =
    | StreamMessageStart
    | StreamContentBlockStart
    | StreamContentBlockDelta
    | StreamContentBlockStop
    | StreamMessageDelta
    | StreamMessageStop
    | { readonly type: 'ping' }
    | { readonly type: 'error'; readonly error: { readonly type: string; readonly message: string } };

/**
 * Window reported when config declares none and the endpoint's model card has
 * no `max_input_tokens` (`contextLengthSource: 'assumed'`). One value for the
 * whole protocol, not looked up by model name: the figure this client has
 * always reported. A server with a smaller window should be given a declared
 * `contextLength`.
 */
const ANTHROPIC_ASSUMED_CONTEXT_LENGTH = 200_000;

// ============================================================================
// Anthropic Client
// ============================================================================

export class AnthropicClient extends BaseLLMClient {
    private readonly baseUrl: string;
    /**
     * `/v1/models` cards by model id, from {@link getModels} or a single-card
     * lookup. `null` records an endpoint that has no card for the id (HTTP 404),
     * so it is not asked again; other failures are not remembered.
     */
    private readonly modelCards = new Map<string, AnthropicModelInfo | null>();
    /**
     * Models that answered a request with `temperature` by rejecting it. The
     * model card does not say which models take `temperature`, so the API's
     * own answer is the signal; later requests to these models leave it out.
     */
    private readonly modelsRejectingTemperature = new Set<string>();
    /**
     * Signed thinking blocks from responses, keyed by the id of the tool call
     * they came before. A later request that turns thinking on puts them back
     * in front of that tool call, so the model keeps its reasoning across a
     * tool loop. Keyed by id, not position, so it survives a caller rebuilding
     * history from its own message log.
     */
    private readonly thinkingByToolUseId = new Map<string, AnthropicReplayedThinking[]>();
    /** Set once this endpoint rejected a request with replayed thinking that succeeded without it. */
    private thinkingReplayRejected = false;

    constructor(options: LLMClientOptions, auditor?: Auditor) {
        const url = (options.url || 'https://api.anthropic.com').replace(/\/+$/, '');
        super({ ...options, url }, auditor);
        this.baseUrl = url;
    }

    // ========================================================================
    // Headers
    // ========================================================================

    /** Request headers; a body that replays thinking also gets {@link THINKING_BINDING_BETA}. */
    private buildAnthropicHeaders(body?: AnthropicRequest): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
        };
        if (this.options.apiKey) {
            headers['x-api-key'] = this.options.apiKey;
        }
        if (carriesReplayedThinking(body)) {
            headers['anthropic-beta'] = THINKING_BINDING_BETA;
        }
        return headers;
    }

    // ========================================================================
    // Chat (non-streaming)
    // ========================================================================

    override async chat(
        messages: LLMChatMessage[],
        options?: ChatOptions,
        callOptions?: ChatOptions,
    ): Promise<LLMChatResponse> {
        const resolvedOptions = callOptions ?? options;
        const url = `${this.baseUrl}/v1/messages`;
        const card = await this.thinkingCard(resolvedOptions);
        const build = (replay: boolean) => this.buildRequestBody(messages, resolvedOptions, false, card, replay);

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'request',
            provider: 'anthropic',
            model: this.options.model,
        });

        const response = await this.sendMessages(build, (requestBody) =>
            httpRequest<AnthropicResponse>(url, {
                method: 'POST',
                headers: this.buildAnthropicHeaders(requestBody),
                body: requestBody,
                signal: resolvedOptions?.signal,
                timeout: this.options.timeout ?? 60000,
            }),
        );

        const data = response.data;
        this.rememberThinking(data.content);
        const result = this.parseAnthropicResponse(data);

        this.auditor.record({
            timestamp: Date.now(),
            type: 'response',
            provider: 'anthropic',
            model: this.options.model,
            duration: Date.now() - start,
            usage: result.usage,
        });

        return result;
    }

    // ========================================================================
    // Streaming
    // ========================================================================

    override async *chatStream(
        messages: LLMChatMessage[],
        options?: ChatOptions,
        callOptions?: ChatOptions,
    ): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
        const resolvedOptions = callOptions ?? options;
        const url = `${this.baseUrl}/v1/messages`;
        const card = await this.thinkingCard(resolvedOptions);
        const build = (replay: boolean) => this.buildRequestBody(messages, resolvedOptions, true, card, replay);

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'stream_start',
            provider: 'anthropic',
            model: this.options.model,
        });

        const decoder = new StandardChatDecoder(() => {});

        // Track content blocks as they stream in
        const contentBlocks: Map<
            number,
            {
                type: string;
                text: string;
                toolId?: string;
                toolName?: string;
                inputJson?: string;
                thinking?: string;
                signature?: string;
                data?: string;
            }
        > = new Map();

        let usage: TokenUsageInfo | undefined;
        let rawUsage: Partial<AnthropicUsage> = {};

        const stream = this.streamMessages(url, build, resolvedOptions?.signal);

        for await (const { data } of parseSSE(stream)) {
            try {
                const event = JSON.parse(data) as AnthropicStreamEvent;

                switch (event.type) {
                    case 'message_start': {
                        rawUsage = { ...event.message.usage };
                        usage = this.toUsage(rawUsage);
                        break;
                    }

                    case 'content_block_start': {
                        const block = event.content_block;
                        if (block.type === 'text') {
                            contentBlocks.set(event.index, { type: 'text', text: '' });
                        } else if (block.type === 'tool_use') {
                            contentBlocks.set(event.index, {
                                type: 'tool_use',
                                text: '',
                                toolId: block.id,
                                toolName: block.name,
                                inputJson: '',
                            });
                        } else if (block.type === 'thinking') {
                            contentBlocks.set(event.index, { type: 'thinking', text: '', thinking: '' });
                        } else if (block.type === 'redacted_thinking') {
                            contentBlocks.set(event.index, { type: 'redacted_thinking', text: '', data: block.data });
                        }
                        break;
                    }

                    case 'content_block_delta': {
                        const block = contentBlocks.get(event.index);
                        if (!block) break;

                        if (event.delta.type === 'text_delta') {
                            block.text += event.delta.text;
                            decoder.push(event.delta.text);
                            yield { type: 'text', content: event.delta.text };
                        } else if (event.delta.type === 'input_json_delta') {
                            block.inputJson = (block.inputJson ?? '') + event.delta.partial_json;
                        } else if (event.delta.type === 'thinking_delta') {
                            block.thinking = (block.thinking ?? '') + event.delta.thinking;
                            decoder.pushReasoning(event.delta.thinking);
                            yield { type: 'thinking', content: event.delta.thinking };
                        } else if (event.delta.type === 'signature_delta') {
                            block.signature = event.delta.signature;
                        }
                        break;
                    }

                    case 'content_block_stop': {
                        const block = contentBlocks.get(event.index);
                        if (block?.type === 'tool_use' && block.toolId && block.toolName) {
                            // Parse accumulated JSON and emit tool call
                            const toolCall: LLMToolCall = {
                                id: block.toolId,
                                type: 'function',
                                function: {
                                    name: block.toolName,
                                    arguments: block.inputJson ?? '{}',
                                },
                            };
                            yield { type: 'tool_call', calls: [toolCall] };
                        }
                        break;
                    }

                    case 'message_delta': {
                        // Delta counters are cumulative snapshots, not additions.
                        rawUsage = { ...rawUsage, ...event.usage };
                        usage = this.toUsage(rawUsage);
                        break;
                    }

                    case 'error': {
                        throw new Error(`Anthropic stream error: ${event.error.type} — ${event.error.message}`);
                    }
                }
            } catch (e) {
                if (e instanceof Error && e.message.startsWith('Anthropic stream error')) {
                    throw e;
                }
                // Skip unparseable SSE data
            }
        }

        decoder.flush();

        // The blocks in the order the API sent them, for thinking replay.
        this.rememberThinking(
            [...contentBlocks.entries()]
                .sort(([a], [b]) => a - b)
                .flatMap(([, block]): AnthropicContentBlock[] => {
                    if (block.type === 'thinking') {
                        return [{ type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? '' }];
                    }
                    if (block.type === 'redacted_thinking') return [{ type: 'redacted_thinking', data: block.data ?? '' }];
                    if (block.type === 'tool_use' && block.toolId) {
                        return [{ type: 'tool_use', id: block.toolId, name: block.toolName ?? '', input: {} }];
                    }
                    return [];
                }),
        );

        this.auditor.record({
            timestamp: Date.now(),
            type: 'stream_end',
            provider: 'anthropic',
            model: this.options.model,
            duration: Date.now() - start,
            usage,
        });

        // Build final tool calls from accumulated content blocks
        const toolCalls: LLMToolCall[] = [];
        for (const block of contentBlocks.values()) {
            if (block.type === 'tool_use' && block.toolId && block.toolName) {
                toolCalls.push({
                    id: block.toolId,
                    type: 'function',
                    function: {
                        name: block.toolName,
                        arguments: block.inputJson ?? '{}',
                    },
                });
            }
        }

        return {
            message: {
                role: 'assistant',
                content: decoder.getCleanContent(),
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            },
            reasoning: decoder.getReasoning(),
            usage,
            provider: 'anthropic',
        };
    }

    // ========================================================================
    // Embeddings (not supported by Anthropic)
    // ========================================================================

    override async embed(_text: string): Promise<number[]> {
        throw new Error('Anthropic does not support embeddings. Use a different provider.');
    }

    // ========================================================================
    // Model Discovery
    // ========================================================================

    /**
     * The endpoint's model ids. A failed listing throws; nothing is made up.
     * The cards are kept, so {@link getModelInfo} needs no further request.
     */
    override async getModels(): Promise<string[]> {
        const url = `${this.baseUrl}/v1/models`;
        const response = await httpRequest<{
            data: AnthropicModelInfo[];
        }>(url, {
            headers: this.buildAnthropicHeaders(),
            timeout: 5000,
        });
        for (const card of response.data.data) this.modelCards.set(card.id, card);
        return response.data.data.map((m) => m.id);
    }

    /**
     * Declared values first, then the endpoint's model card
     * (`GET /v1/models/{id}`): `max_input_tokens` for the window, and
     * `capabilities` for image input and thinking. Tool use is part of the
     * Messages protocol, so it is listed whenever the card has capabilities.
     * Whatever the card leaves out is the protocol's assumed default: the
     * window above, and tool use plus image input. The model name is never read.
     */
    override async getModelInfo(modelName?: string): Promise<ModelMetadata> {
        const model = modelName ?? this.options.model;
        const info: ModelMetadata = {
            model,
            contextLength: ANTHROPIC_ASSUMED_CONTEXT_LENGTH,
            contextLengthSource: 'assumed',
            capabilities: ['tools', 'vision'],
            capabilitiesSource: 'assumed',
        };
        if (this.declaresModelInfo(modelName)) return this.withDeclaredModelInfo(info, modelName);

        const card = await this.modelCard(model);
        if (typeof card?.max_input_tokens === 'number' && card.max_input_tokens > 0) {
            info.contextLength = card.max_input_tokens;
            info.contextLengthSource = 'endpoint';
        }
        if (card?.capabilities) {
            const capabilities = ['tools'];
            if (card.capabilities.image_input?.supported) capabilities.push('vision');
            if (card.capabilities.thinking?.supported) capabilities.push('thinking');
            info.capabilities = capabilities;
            info.capabilitiesSource = 'endpoint';
        }
        return this.withDeclaredModelInfo(info, modelName);
    }

    /**
     * The card of the model a request goes to, looked up only when the
     * request sets thinking on or off: the card says which thinking shape the
     * model takes and how it is turned off. Cached like every card, so this
     * costs one request per model.
     */
    private async thinkingCard(options: ChatOptions | undefined): Promise<AnthropicModelInfo | undefined> {
        if (resolveThinking(options?.thinking, this.options.thinking) === undefined) return undefined;
        return this.modelCard(options?.model ?? this.options.model);
    }

    /**
     * Whether `error` is the API rejecting the `temperature` this request
     * sent. The model is remembered, so later requests (and the retry of this
     * one) leave `temperature` out.
     */
    private temperatureRejected(body: AnthropicRequest, error: unknown): boolean {
        if (body.temperature === undefined) return false;
        if (!(error instanceof LLMHttpError) || error.status !== 400 || !TEMPERATURE_REJECTED.test(error.body)) {
            return false;
        }
        this.modelsRejectingTemperature.add(body.model);
        console.warn(`[anthropic] ${body.model} does not accept \`temperature\`; requests to it are sent without one`);
        return true;
    }

    /**
     * Which change a rejected request calls for before it is sent again:
     * `temperature` the model does not take (learned, so the next build leaves
     * it out), or replayed thinking on an endpoint that may not take it (the
     * next build sends none). Undefined when the error is not one of these.
     */
    private retryAfter(body: AnthropicRequest, error: unknown): 'temperature' | 'no-replay' | undefined {
        if (this.temperatureRejected(body, error)) return 'temperature';
        if (carriesReplayedThinking(body) && error instanceof LLMHttpError && error.status === 400) return 'no-replay';
        return undefined;
    }

    /**
     * A request with replayed thinking was rejected and the same request
     * without it went through: this endpoint does not take replayed thinking,
     * so this client stops sending it.
     */
    private noteThinkingReplayRejected(): void {
        if (this.thinkingReplayRejected) return;
        this.thinkingReplayRejected = true;
        console.warn('[anthropic] The endpoint rejected replayed thinking blocks; requests are sent without them');
    }

    /**
     * Send a Messages request built by `build`, sending it again after a
     * rejection {@link retryAfter} recognizes (at most twice). An error on a
     * request that no longer replays thinking is thrown as it is.
     */
    private async sendMessages<T>(
        build: (replay: boolean) => AnthropicRequest,
        send: (body: AnthropicRequest) => Promise<T>,
    ): Promise<T> {
        let replay = true;
        let droppedReplay = false;
        for (let attempt = 0; ; attempt++) {
            const body = build(replay);
            try {
                const result = await send(body);
                if (droppedReplay) this.noteThinkingReplayRejected();
                return result;
            } catch (error) {
                const change = attempt < 2 ? this.retryAfter(body, error) : undefined;
                if (!change) throw error;
                if (change === 'no-replay') {
                    replay = false;
                    droppedReplay = true;
                }
            }
        }
    }

    /**
     * Stream a Messages request, sending it again after a rejection
     * {@link retryAfter} recognizes, as {@link sendMessages} does. The API
     * rejects before any event, so a request is only sent again before data.
     */
    private async *streamMessages(
        url: string,
        build: (replay: boolean) => AnthropicRequest,
        signal: AbortSignal | undefined,
    ): AsyncGenerator<string, void, unknown> {
        let replay = true;
        let droppedReplay = false;
        for (let attempt = 0; ; attempt++) {
            const body = build(replay);
            let received = false;
            try {
                for await (const chunk of httpStream(url, {
                    method: 'POST',
                    headers: this.buildAnthropicHeaders(body),
                    body,
                    signal,
                    timeout: this.options.timeout ?? 120000,
                })) {
                    if (!received && droppedReplay) this.noteThinkingReplayRejected();
                    received = true;
                    yield chunk;
                }
                return;
            } catch (error) {
                const change = !received && attempt < 2 ? this.retryAfter(body, error) : undefined;
                if (!change) throw error;
                if (change === 'no-replay') {
                    replay = false;
                    droppedReplay = true;
                }
            }
        }
    }

    /**
     * Keep the signed thinking blocks of a response, keyed by the tool call
     * each group came before. Unsigned thinking cannot be sent back.
     */
    private rememberThinking(content: readonly AnthropicContentBlock[]): void {
        let pending: AnthropicReplayedThinking[] = [];
        for (const block of content) {
            if (block.type === 'thinking') {
                if (block.signature) pending.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
            } else if (block.type === 'redacted_thinking') {
                if (block.data) pending.push({ type: 'redacted_thinking', data: block.data });
            } else if (block.type === 'tool_use' && pending.length > 0) {
                this.thinkingByToolUseId.delete(block.id);
                this.thinkingByToolUseId.set(block.id, pending);
                pending = [];
            }
        }
        for (const id of this.thinkingByToolUseId.keys()) {
            if (this.thinkingByToolUseId.size <= MAX_REPLAYED_TOOL_CALLS) break;
            this.thinkingByToolUseId.delete(id);
        }
    }

    /** The model's card, from the cache or `GET /v1/models/{id}`; undefined when unavailable. */
    private async modelCard(model: string): Promise<AnthropicModelInfo | undefined> {
        if (!model) return undefined;
        const cached = this.modelCards.get(model);
        if (cached !== undefined) return cached ?? undefined;
        try {
            const response = await httpRequest<AnthropicModelInfo>(
                `${this.baseUrl}/v1/models/${encodeURIComponent(model)}`,
                { headers: this.buildAnthropicHeaders(), timeout: 5000 },
            );
            this.modelCards.set(model, response.data);
            return response.data;
        } catch (error) {
            // No such card: a server without the route, or an id it does not
            // list. Anything else (auth, network, 5xx) may pass, so ask again.
            if (error instanceof LLMHttpError && error.status === 404) this.modelCards.set(model, null);
            return undefined;
        }
    }

    // ========================================================================
    // Internal: Request Building
    // ========================================================================

    /**
     * Build a Messages request. With `replay`, a request that turns thinking
     * on puts the kept thinking blocks back in front of their tool calls and
     * asks the API to drop (not reject) any block whose conversation changed.
     */
    private buildRequestBody(
        messages: LLMChatMessage[],
        options: ChatOptions | undefined,
        stream: boolean,
        card?: AnthropicModelInfo,
        replay = false,
    ): AnthropicRequest {
        // Extract system prompt from messages
        const systemMessages = messages.filter((m) => m.role === 'system');
        const nonSystemMessages = messages.filter((m) => m.role !== 'system');

        const systemPrompt =
            systemMessages.length > 0
                ? systemMessages
                      .map((m) => (typeof m.content === 'string' ? m.content : this.extractText(m.content)))
                      .join('\n\n')
                : undefined;

        // Cache both the stable system prefix and growing conversation. Automatic
        // caching moves the last breakpoint forward without rewriting history.
        let system: AnthropicRequest['system'] = systemPrompt;
        if (options?.enablePromptCaching && systemPrompt) {
            system = [
                {
                    type: 'text',
                    text: systemPrompt,
                    cache_control: { type: 'ephemeral' },
                },
            ];
        }

        // Convert tools from OpenAI format to Anthropic format
        const tools =
            options?.tools ?? (Object.keys(this.toolRegistry).length > 0 ? this.getToolDefinitions() : undefined);
        const anthropicTools = tools?.map((t) => this.convertToolDef(t));

        // Map tool_choice
        let toolChoice: AnthropicRequest['tool_choice'];
        if (options?.toolChoice === 'required') {
            toolChoice = { type: 'any' };
        } else if (options?.toolChoice === 'none') {
            toolChoice = { type: 'auto' }; // Anthropic doesn't have 'none', closest is 'auto'
        } else if (options?.toolChoice === 'auto') {
            toolChoice = { type: 'auto' };
        }

        // Unified thinking flag. Per-call overrides model config. The model card
        // says which shape the model takes: adaptive thinking when it lists
        // `adaptive` (the level becomes `output_config.effort`; a bare `true`
        // leaves the model's default effort), otherwise, or with no card,
        // extended thinking where the level sets `budget_tokens` (kept <
        // max_tokens). `false` sends the card's off switch (`disabled`, or
        // `between_tools`); a model whose card lists neither always thinks, and
        // nothing is sent. The API forbids a custom temperature while thinking
        // is on, so it is omitted in that case (the required default of 1
        // applies), and for models that rejected it before.
        const model = options?.model ?? this.options.model;
        const thinking = resolveThinking(options?.thinking, this.options.thinking);
        const thinkingOn = thinking?.enabled === true;
        const adaptive = thinkingOn && card?.capabilities?.thinking?.types?.adaptive?.supported === true;
        const effort = adaptive && card && thinking?.level ? effortForLevel(thinking.level, card) : undefined;
        const offSwitch = thinking?.enabled === false ? thinkingOffSwitch(card) : undefined;
        const temperature = this.modelsRejectingTemperature.has(model) ? undefined : options?.temperature;
        const requestedMax = options?.maxTokens ?? 4096;
        // Extended thinking requires budget_tokens >= 1024 AND < max_tokens, so when
        // thinking is on we bump max_tokens to guarantee headroom for the answer.
        // Adaptive thinking gets the same room, so switching shape changes no limit.
        const budget = thinkingOn ? anthropicThinkingBudget(thinking?.level, requestedMax) : 0;
        const maxTokens = thinkingOn ? Math.max(requestedMax, budget + 1024) : requestedMax;

        // Replayed thinking only goes with thinking on: a request without a
        // thinking object has nowhere to put `block_binding`, and an
        // `adaptive` or `enabled` one is what the API takes it with.
        const replayThinking = replay && thinkingOn && !this.thinkingReplayRejected;
        const { messages: conversation, replayed } = this.convertMessages(nonSystemMessages, replayThinking);
        const blockBinding = replayed > 0 ? { block_binding: { prefix_mismatch_behavior: 'drop_block' as const } } : {};
        if (options?.enablePromptCaching) {
            // Per-turn runtime context may be replaced instead of retained in
            // history. Checkpoint assistant prefixes BEFORE that volatile tail.
            // Keep the latest two so a rewritten/merged last reply can fall back
            // one boundary. System + two history + automatic = at most 4 slots.
            let remaining = 2;
            for (let i = conversation.length - 1; i >= 0 && remaining > 0; i--) {
                const message = conversation[i]!;
                if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
                for (let j = message.content.length - 1; j >= 0; j--) {
                    const block = message.content[j]!;
                    // Thinking blocks cannot carry an explicit cache marker.
                    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
                    message.content[j] = { ...block, cache_control: { type: 'ephemeral' } };
                    remaining--;
                    break;
                }
            }
        }

        const body: AnthropicRequest = {
            model,
            messages: conversation,
            max_tokens: maxTokens,
            ...(system && { system }),
            ...(options?.enablePromptCaching ? { cache_control: { type: 'ephemeral' as const } } : {}),
            ...(anthropicTools?.length && { tools: anthropicTools }),
            ...(toolChoice && { tool_choice: toolChoice }),
            ...(stream && { stream: true }),
            ...(adaptive
                ? {
                      // Summarized, so `reasoning` keeps text: newer models default to omitting it.
                      thinking: { type: 'adaptive' as const, display: 'summarized' as const, ...blockBinding },
                      ...(effort && { output_config: { effort } }),
                  }
                : thinkingOn
                  ? { thinking: { type: 'enabled' as const, budget_tokens: budget, ...blockBinding } }
                  : {
                        ...(offSwitch && { thinking: { type: offSwitch } }),
                        ...(temperature !== undefined && { temperature }),
                    }),
        };

        return body;
    }

    // ========================================================================
    // Internal: Message Conversion
    // ========================================================================

    /**
     * Convert our canonical LLMChatMessage[] to Anthropic's message format.
     * Key conversions:
     *   - 'tool' role messages → merged into preceding user message as tool_result blocks
     *   - assistant messages with tool_calls → assistant message with tool_use blocks
     *   - multimodal content → Anthropic image blocks
     */
    private convertMessages(
        messages: LLMChatMessage[],
        replayThinking = false,
    ): { messages: AnthropicMessage[]; replayed: number } {
        const result: AnthropicMessage[] = [];
        let replayed = 0;

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i]!;

            if (msg.role === 'assistant') {
                // Build content blocks for assistant
                const blocks: AnthropicContentBlock[] = [];

                // Add text content if present
                const text = typeof msg.content === 'string' ? msg.content : this.extractText(msg.content);
                if (text) {
                    blocks.push({ type: 'text', text });
                }

                // Convert tool_calls to tool_use blocks. With replay, each call's
                // kept thinking goes back where the API sent it: the first call's
                // at the start of the turn, a later call's right before it.
                if (msg.tool_calls) {
                    msg.tool_calls.forEach((tc, index) => {
                        let input: Record<string, unknown> = {};
                        try {
                            input = JSON.parse(tc.function.arguments);
                        } catch {
                            // Keep empty object if parse fails
                        }
                        const thinking = replayThinking ? this.thinkingByToolUseId.get(tc.id) : undefined;
                        if (thinking) {
                            blocks.splice(index === 0 ? 0 : blocks.length, 0, ...thinking);
                            replayed += thinking.length;
                        }
                        blocks.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.function.name,
                            input,
                        });
                    });
                }

                if (blocks.length > 0) {
                    result.push({ role: 'assistant', content: blocks });
                }
            } else if (msg.role === 'tool') {
                // Anthropic needs tool results inside user messages
                const toolResultBlock: AnthropicToolResultBlock = {
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id ?? '',
                    content: typeof msg.content === 'string' ? msg.content : this.extractText(msg.content),
                };

                // Collect consecutive tool results
                const toolResults: AnthropicContentBlock[] = [toolResultBlock];
                while (i + 1 < messages.length && messages[i + 1]!.role === 'tool') {
                    i++;
                    const nextMsg = messages[i]!;
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: nextMsg.tool_call_id ?? '',
                        content:
                            typeof nextMsg.content === 'string' ? nextMsg.content : this.extractText(nextMsg.content),
                    });
                }

                result.push({ role: 'user', content: toolResults });
            } else if (msg.role === 'user') {
                const blocks = this.convertUserContent(msg.content);
                result.push({ role: 'user', content: blocks });
            }
        }

        // Anthropic requires alternating user/assistant messages.
        // Merge consecutive same-role messages if needed.
        return { messages: this.ensureAlternating(result), replayed };
    }

    /**
     * Convert user message content (string or multimodal) to Anthropic blocks.
     */
    private convertUserContent(content: LLMMessageContent): AnthropicContentBlock[] {
        if (typeof content === 'string') {
            return [{ type: 'text', text: content }];
        }

        const blocks: AnthropicContentBlock[] = [];
        for (const part of content as LLMContentPart[]) {
            if (part.type === 'text') {
                blocks.push({ type: 'text', text: part.text });
            } else if (part.type === 'audio') {
                // Anthropic does not yet support audio input — skip silently
                this.debugLog('[Anthropic] Audio content dropped — not supported');
            } else if (part.type === 'image_url') {
                const url = part.image_url.url;
                if (url.startsWith('data:')) {
                    // Extract base64 data from data URI
                    const match = url.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        blocks.push({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: match[1],
                                data: match[2],
                            },
                        });
                    }
                } else {
                    // URL-based image
                    blocks.push({
                        type: 'image',
                        source: {
                            type: 'url',
                            url,
                        },
                    });
                }
            }
        }
        return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
    }

    /**
     * Ensure messages alternate between user and assistant roles.
     * Anthropic requires strict alternation. Merge consecutive same-role messages.
     */
    private ensureAlternating(messages: AnthropicMessage[]): AnthropicMessage[] {
        if (messages.length <= 1) return messages;

        const merged: AnthropicMessage[] = [messages[0]!];

        for (let i = 1; i < messages.length; i++) {
            const current = messages[i]!;
            const last = merged[merged.length - 1]!;

            if (current.role === last.role) {
                // Merge content arrays
                const lastContent = Array.isArray(last.content)
                    ? last.content
                    : [{ type: 'text' as const, text: last.content }];
                const currentContent = Array.isArray(current.content)
                    ? current.content
                    : [{ type: 'text' as const, text: current.content }];

                merged[merged.length - 1] = {
                    role: current.role,
                    content: [...lastContent, ...currentContent],
                };
            } else {
                merged.push(current);
            }
        }

        return merged;
    }

    // ========================================================================
    // Internal: Response Parsing
    // ========================================================================

    /**
     * Parse Anthropic's response format into our canonical LLMChatResponse.
     */
    private parseAnthropicResponse(data: AnthropicResponse): LLMChatResponse {
        let textContent = '';
        let reasoning: string | undefined;
        const toolCalls: LLMToolCall[] = [];

        for (const block of data.content) {
            if (block.type === 'text') {
                textContent += block.text;
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id,
                    type: 'function',
                    function: {
                        name: block.name,
                        arguments: JSON.stringify(block.input),
                    },
                });
            } else if (block.type === 'thinking') {
                reasoning = (reasoning ?? '') + block.thinking;
            }
        }

        const usage = this.toUsage(data.usage);

        return {
            message: {
                role: 'assistant',
                content: textContent,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            },
            reasoning,
            usage,
            provider: 'anthropic',
        };
    }

    // ========================================================================
    // Internal: Helpers
    // ========================================================================

    private toUsage(raw: Partial<AnthropicUsage>): TokenUsageInfo {
        // Anthropic input_tokens excludes cache reads AND writes. Normalize to
        // the same inclusive prompt size used by the other providers.
        const inputTokens =
            (raw.input_tokens ?? 0) + (raw.cache_read_input_tokens ?? 0) + (raw.cache_creation_input_tokens ?? 0);
        const outputTokens = raw.output_tokens ?? 0;
        return {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            ...(raw.cache_read_input_tokens !== undefined ? { cachedTokens: raw.cache_read_input_tokens } : {}),
            ...(raw.cache_creation_input_tokens !== undefined
                ? { cacheWriteTokens: raw.cache_creation_input_tokens }
                : {}),
        };
    }

    /** Convert OpenAI-format tool definition to Anthropic format */
    private convertToolDef(tool: LLMToolDefinition): AnthropicToolDef {
        return {
            name: tool.function.name,
            description: tool.function.description,
            input_schema: {
                type: 'object',
                properties: tool.function.parameters.properties,
                required: tool.function.parameters.required,
            },
        };
    }

    /** Extract text from multimodal content */
    private extractText(content: LLMMessageContent): string {
        if (typeof content === 'string') return content;
        return (content as LLMContentPart[])
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('');
    }
}
