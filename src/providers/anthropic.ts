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

type AnthropicContentBlock = (
    | AnthropicTextBlock
    | AnthropicImageBlock
    | AnthropicToolUseBlock
    | AnthropicToolResultBlock
    | AnthropicThinkingBlock
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
    readonly thinking?: { readonly type: 'enabled'; readonly budget_tokens: number } | { readonly type: 'disabled' };
}

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
        readonly thinking?: { readonly supported?: boolean };
    };
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

    constructor(options: LLMClientOptions, auditor?: Auditor) {
        const url = (options.url || 'https://api.anthropic.com').replace(/\/+$/, '');
        super({ ...options, url }, auditor);
        this.baseUrl = url;
    }

    // ========================================================================
    // Headers
    // ========================================================================

    private buildAnthropicHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
        };
        if (this.options.apiKey) {
            headers['x-api-key'] = this.options.apiKey;
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
        const body = this.buildRequestBody(messages, resolvedOptions, false);

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'request',
            provider: 'anthropic',
            model: this.options.model,
        });

        const response = await httpRequest<AnthropicResponse>(url, {
            method: 'POST',
            headers: this.buildAnthropicHeaders(),
            body,
            signal: resolvedOptions?.signal,
            timeout: this.options.timeout ?? 60000,
        });

        const data = response.data;
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
        const body = this.buildRequestBody(messages, resolvedOptions, true);

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
            }
        > = new Map();

        let usage: TokenUsageInfo | undefined;
        let rawUsage: Partial<AnthropicUsage> = {};

        const stream = httpStream(url, {
            method: 'POST',
            headers: this.buildAnthropicHeaders(),
            body,
            signal: resolvedOptions?.signal,
            timeout: this.options.timeout ?? 120000,
        });

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

    private buildRequestBody(
        messages: LLMChatMessage[],
        options: ChatOptions | undefined,
        stream: boolean,
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

        // Unified thinking flag → Anthropic extended thinking. Per-call overrides
        // model config; the level sets `budget_tokens` (kept < max_tokens). The
        // API forbids a custom temperature while thinking is enabled, so it is
        // omitted in that case (the required default of 1 applies).
        const thinking = resolveThinking(options?.thinking, this.options.thinking);
        const thinkingOn = thinking?.enabled === true;
        const requestedMax = options?.maxTokens ?? 4096;
        // Extended thinking requires budget_tokens >= 1024 AND < max_tokens, so when
        // thinking is on we bump max_tokens to guarantee headroom for the answer.
        const budget = thinkingOn ? anthropicThinkingBudget(thinking?.level, requestedMax) : 0;
        const maxTokens = thinkingOn ? Math.max(requestedMax, budget + 1024) : requestedMax;

        const conversation = this.convertMessages(nonSystemMessages);
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
                    if (block.type === 'thinking') continue;
                    message.content[j] = { ...block, cache_control: { type: 'ephemeral' } };
                    remaining--;
                    break;
                }
            }
        }

        const body: AnthropicRequest = {
            model: options?.model ?? this.options.model,
            messages: conversation,
            max_tokens: maxTokens,
            ...(system && { system }),
            ...(options?.enablePromptCaching ? { cache_control: { type: 'ephemeral' as const } } : {}),
            ...(anthropicTools?.length && { tools: anthropicTools }),
            ...(toolChoice && { tool_choice: toolChoice }),
            ...(stream && { stream: true }),
            ...(thinkingOn
                ? { thinking: { type: 'enabled' as const, budget_tokens: budget } }
                : options?.temperature !== undefined && { temperature: options.temperature }),
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
    private convertMessages(messages: LLMChatMessage[]): AnthropicMessage[] {
        const result: AnthropicMessage[] = [];

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

                // Convert tool_calls to tool_use blocks
                if (msg.tool_calls) {
                    for (const tc of msg.tool_calls) {
                        let input: Record<string, unknown> = {};
                        try {
                            input = JSON.parse(tc.function.arguments);
                        } catch {
                            // Keep empty object if parse fails
                        }
                        blocks.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.function.name,
                            input,
                        });
                    }
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
        return this.ensureAlternating(result);
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
