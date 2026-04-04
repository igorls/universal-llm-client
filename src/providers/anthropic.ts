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
import { httpRequest, httpStream, parseSSE } from '../http.js';
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
    readonly tool_call_id: string;
    readonly content: string | AnthropicTextBlock[];
}

interface AnthropicThinkingBlock {
    readonly type: 'thinking';
    readonly thinking: string;
    readonly signature: string;
}

type AnthropicContentBlock =
    | AnthropicTextBlock
    | AnthropicImageBlock
    | AnthropicToolUseBlock
    | AnthropicToolResultBlock
    | AnthropicThinkingBlock;

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
    readonly system?: string;
    readonly tools?: AnthropicToolDef[];
    readonly tool_choice?: { readonly type: 'auto' | 'any' | 'tool'; readonly name?: string };
    readonly stream?: boolean;
    readonly temperature?: number;
}

/** Anthropic non-streaming response */
interface AnthropicResponse {
    readonly id: string;
    readonly type: 'message';
    readonly role: 'assistant';
    readonly content: AnthropicContentBlock[];
    readonly model: string;
    readonly stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
    readonly usage: {
        readonly input_tokens: number;
        readonly output_tokens: number;
    };
}

/** Anthropic model from models list */
interface AnthropicModelInfo {
    readonly id: string;
    readonly display_name: string;
    readonly created_at: string;
    readonly type: 'model';
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
    readonly usage: {
        readonly output_tokens: number;
    };
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

// ============================================================================
// Anthropic Client
// ============================================================================

export class AnthropicClient extends BaseLLMClient {
    private readonly baseUrl: string;

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
    ): Promise<LLMChatResponse> {
        const url = `${this.baseUrl}/v1/messages`;
        const body = this.buildRequestBody(messages, options, false);

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
    ): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown> {
        const url = `${this.baseUrl}/v1/messages`;
        const body = this.buildRequestBody(messages, options, true);

        const start = Date.now();
        this.auditor.record({
            timestamp: start,
            type: 'stream_start',
            provider: 'anthropic',
            model: this.options.model,
        });

        const decoder = new StandardChatDecoder(() => {});

        // Track content blocks as they stream in
        const contentBlocks: Map<number, {
            type: string;
            text: string;
            toolId?: string;
            toolName?: string;
            inputJson?: string;
            thinking?: string;
            signature?: string;
        }> = new Map();

        let usage: TokenUsageInfo | undefined;
        let inputTokens = 0;

        const stream = httpStream(url, {
            method: 'POST',
            headers: this.buildAnthropicHeaders(),
            body,
            timeout: this.options.timeout ?? 120000,
        });

        for await (const { data } of parseSSE(stream)) {
            try {
                const event = JSON.parse(data) as AnthropicStreamEvent;

                switch (event.type) {
                    case 'message_start': {
                        inputTokens = event.message.usage?.input_tokens ?? 0;
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
                        const outputTokens = event.usage?.output_tokens ?? 0;
                        usage = {
                            inputTokens,
                            outputTokens,
                            totalTokens: inputTokens + outputTokens,
                        };
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

    override async getModels(): Promise<string[]> {
        const url = `${this.baseUrl}/v1/models`;
        try {
            const response = await httpRequest<{
                data: AnthropicModelInfo[];
            }>(url, {
                headers: this.buildAnthropicHeaders(),
                timeout: 5000,
            });
            return response.data.data.map(m => m.id);
        } catch {
            // Fallback: return well-known Claude models
            return [
                'claude-sonnet-4-20250514',
                'claude-haiku-4-20250514',
                'claude-opus-4-20250514',
            ];
        }
    }

    override async getModelInfo(_modelName?: string): Promise<ModelMetadata> {
        // Claude models support large context windows
        const model = _modelName ?? this.options.model;

        // Claude 4 models have 200K context
        if (model.includes('claude-4') || model.includes('claude-opus') ||
            model.includes('claude-sonnet') || model.includes('claude-haiku')) {
            return {
                model,
                contextLength: 200_000,
                capabilities: ['tools', 'vision', 'thinking'],
            };
        }

        return {
            model,
            contextLength: 200_000,
            capabilities: ['tools', 'vision'],
        };
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
        const systemMessages = messages.filter(m => m.role === 'system');
        const nonSystemMessages = messages.filter(m => m.role !== 'system');

        const systemPrompt = systemMessages.length > 0
            ? systemMessages
                .map(m => typeof m.content === 'string' ? m.content : this.extractText(m.content))
                .join('\n\n')
            : undefined;

        // Convert tools from OpenAI format to Anthropic format
        const tools = options?.tools ?? (
            Object.keys(this.toolRegistry).length > 0 ? this.getToolDefinitions() : undefined
        );
        const anthropicTools = tools?.map(t => this.convertToolDef(t));

        // Map tool_choice
        let toolChoice: AnthropicRequest['tool_choice'];
        if (options?.toolChoice === 'required') {
            toolChoice = { type: 'any' };
        } else if (options?.toolChoice === 'none') {
            toolChoice = { type: 'auto' }; // Anthropic doesn't have 'none', closest is 'auto'
        } else if (options?.toolChoice === 'auto') {
            toolChoice = { type: 'auto' };
        }

        const body: AnthropicRequest = {
            model: this.options.model,
            messages: this.convertMessages(nonSystemMessages),
            max_tokens: options?.maxTokens ?? 4096,
            ...(systemPrompt && { system: systemPrompt }),
            ...(anthropicTools?.length && { tools: anthropicTools }),
            ...(toolChoice && { tool_choice: toolChoice }),
            ...(stream && { stream: true }),
            ...(options?.temperature !== undefined && { temperature: options.temperature }),
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
                const text = typeof msg.content === 'string'
                    ? msg.content
                    : this.extractText(msg.content);
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
                    tool_call_id: msg.tool_call_id ?? '',
                    content: typeof msg.content === 'string'
                        ? msg.content
                        : this.extractText(msg.content),
                };

                // Collect consecutive tool results
                const toolResults: AnthropicContentBlock[] = [toolResultBlock];
                while (i + 1 < messages.length && messages[i + 1]!.role === 'tool') {
                    i++;
                    const nextMsg = messages[i]!;
                    toolResults.push({
                        type: 'tool_result',
                        tool_call_id: nextMsg.tool_call_id ?? '',
                        content: typeof nextMsg.content === 'string'
                            ? nextMsg.content
                            : this.extractText(nextMsg.content),
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

        const usage: TokenUsageInfo = {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
        };

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
            .map(p => p.text)
            .join('');
    }
}
