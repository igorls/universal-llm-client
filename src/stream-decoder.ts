/**
 * Universal LLM Client v3 — Stream Decoder
 *
 * Pluggable interface for decoding raw LLM token streams into typed events.
 * Consumers select their strategy per-call: passthrough for raw speed,
 * standard-chat for structured tool calls, or interleaved-reasoning
 * for models that emit <think>/<progress> tags.
 */

import type { LLMToolCall } from './interfaces.js';

// ============================================================================
// Decoded Event Types
// ============================================================================

/** Clean, typed events emitted by a stream decoder */
export type DecodedEvent =
    | { type: 'text'; content: string }
    | { type: 'thinking'; content: string }
    | { type: 'progress'; content: string }
    | { type: 'tool_call'; calls: LLMToolCall[] };

/** Callback invoked by the decoder as events become available */
export type DecoderCallback = (event: DecodedEvent) => void;

// ============================================================================
// Decoder Interface
// ============================================================================

/**
 * Transform raw LLM tokens into clean typed events.
 *
 * Usage:
 *   const decoder = createDecoder('standard-chat', callback);
 *   for (const token of stream) decoder.push(token);
 *   decoder.flush();
 *   const clean = decoder.getCleanContent();
 */
export interface StreamDecoder {
    /** Feed a raw token from the LLM stream */
    push(token: string): void;
    /** Signal end of stream — flush any buffered state */
    flush(): void;
    /** Get the accumulated clean text (all structural tags stripped) */
    getCleanContent(): string;
    /** Get accumulated reasoning/thinking content (if any) */
    getReasoning(): string | undefined;
}

// ============================================================================
// Decoder Types
// ============================================================================

export type DecoderType = 'passthrough' | 'standard-chat' | 'interleaved-reasoning';

// ============================================================================
// Passthrough Decoder
// ============================================================================

/**
 * Bare-bones decoder for raw text completions.
 * No parsing, no tag awareness. All tokens → text events.
 */
export class PassthroughDecoder implements StreamDecoder {
    private content = '';
    private readonly callback: DecoderCallback;

    constructor(callback: DecoderCallback) {
        this.callback = callback;
    }

    push(token: string): void {
        this.content += token;
        this.callback({ type: 'text', content: token });
    }

    flush(): void {
        // Nothing to flush — all tokens emitted immediately
    }

    getCleanContent(): string {
        return this.content;
    }

    getReasoning(): string | undefined {
        return undefined;
    }
}

// ============================================================================
// Standard Chat Decoder
// ============================================================================

/**
 * Decoder for standard LLM chat patterns — text streaming with native
 * reasoning and structured API tool calls. No text-level tag parsing.
 *
 * Streamed tokens are clean text → emitted as `text` events.
 * Native reasoning tokens → accepted via `pushReasoning()`.
 * Structured tool calls → accepted via `pushToolCalls()`.
 */
export class StandardChatDecoder implements StreamDecoder {
    private content = '';
    private reasoning = '';
    private readonly callback: DecoderCallback;

    constructor(callback: DecoderCallback) {
        this.callback = callback;
    }

    push(token: string): void {
        this.content += token;
        this.callback({ type: 'text', content: token });
    }

    /** Feed native reasoning tokens from the provider */
    pushReasoning(content: string): void {
        this.reasoning += content;
        this.callback({ type: 'thinking', content });
    }

    /** Feed structured tool calls from the provider API response */
    pushToolCalls(calls: LLMToolCall[]): void {
        this.callback({ type: 'tool_call', calls });
    }

    flush(): void {
        // Nothing to flush — all events emitted as they arrive
    }

    getCleanContent(): string {
        return this.content;
    }

    getReasoning(): string | undefined {
        return this.reasoning || undefined;
    }
}

// ============================================================================
// Interleaved Reasoning Decoder
// ============================================================================

/**
 * Decoder for models that emit interleaved reasoning tags in text.
 * Parses <think>...</think> and <progress>...</progress> tags from the
 * raw token stream and emits typed events for each.
 *
 * Handles streaming where tags may be split across chunks.
 */
export class InterleavedReasoningDecoder implements StreamDecoder {
    private buffer = '';
    private content = '';
    private reasoning = '';
    private readonly callback: DecoderCallback;
    private inThink = false;
    private inProgress = false;

    constructor(callback: DecoderCallback) {
        this.callback = callback;
    }

    push(token: string): void {
        this.buffer += token;
        this.processBuffer();
    }

    flush(): void {
        // Emit any remaining buffer content as text
        if (this.buffer.length > 0) {
            if (this.inThink) {
                this.reasoning += this.buffer;
                this.callback({ type: 'thinking', content: this.buffer });
            } else if (this.inProgress) {
                this.callback({ type: 'progress', content: this.buffer });
            } else {
                this.content += this.buffer;
                this.callback({ type: 'text', content: this.buffer });
            }
            this.buffer = '';
        }
    }

    getCleanContent(): string {
        return this.content;
    }

    getReasoning(): string | undefined {
        return this.reasoning || undefined;
    }

    private processBuffer(): void {
        let safety = 0;
        while (this.buffer.length > 0 && safety++ < 200) {
            if (this.inThink) {
                const closeIdx = this.buffer.indexOf('</think>');
                if (closeIdx === -1) {
                    // Might have partial closing tag at end
                    if (this.buffer.endsWith('<') || this.buffer.endsWith('</') ||
                        this.buffer.endsWith('</t') || this.buffer.endsWith('</th') ||
                        this.buffer.endsWith('</thi') || this.buffer.endsWith('</thin') ||
                        this.buffer.endsWith('</think')) {
                        return; // Wait for more data
                    }
                    this.reasoning += this.buffer;
                    this.callback({ type: 'thinking', content: this.buffer });
                    this.buffer = '';
                    return;
                }
                const thinkContent = this.buffer.slice(0, closeIdx);
                if (thinkContent) {
                    this.reasoning += thinkContent;
                    this.callback({ type: 'thinking', content: thinkContent });
                }
                this.buffer = this.buffer.slice(closeIdx + 8); // '</think>'.length
                this.inThink = false;
                continue;
            }

            if (this.inProgress) {
                const closeIdx = this.buffer.indexOf('</progress>');
                if (closeIdx === -1) {
                    if (this.couldBePartialTag(this.buffer, '</progress>')) return;
                    this.callback({ type: 'progress', content: this.buffer });
                    this.buffer = '';
                    return;
                }
                const progressContent = this.buffer.slice(0, closeIdx);
                if (progressContent) {
                    this.callback({ type: 'progress', content: progressContent });
                }
                this.buffer = this.buffer.slice(closeIdx + 11); // '</progress>'.length
                this.inProgress = false;
                continue;
            }

            // Look for opening tags
            const thinkIdx = this.buffer.indexOf('<think>');
            const progressIdx = this.buffer.indexOf('<progress>');

            // Find earliest tag
            const nextTag = this.findEarliest(thinkIdx, progressIdx);

            if (nextTag === -1) {
                // No complete opening tags — check for partial tag at end
                const lastAngle = this.buffer.lastIndexOf('<');
                if (lastAngle >= 0 && lastAngle > this.buffer.length - 12) {
                    // Potential partial tag — emit text before it, keep the rest
                    const textBefore = this.buffer.slice(0, lastAngle);
                    if (textBefore) {
                        this.content += textBefore;
                        this.callback({ type: 'text', content: textBefore });
                    }
                    this.buffer = this.buffer.slice(lastAngle);
                    return;
                }
                // No partial tags — emit all as text
                this.content += this.buffer;
                this.callback({ type: 'text', content: this.buffer });
                this.buffer = '';
                return;
            }

            // Emit text before the tag
            const textBefore = this.buffer.slice(0, nextTag);
            if (textBefore) {
                this.content += textBefore;
                this.callback({ type: 'text', content: textBefore });
            }

            if (nextTag === thinkIdx) {
                this.buffer = this.buffer.slice(nextTag + 7); // '<think>'.length
                this.inThink = true;
            } else {
                this.buffer = this.buffer.slice(nextTag + 10); // '<progress>'.length
                this.inProgress = true;
            }
        }
    }

    private findEarliest(a: number, b: number): number {
        if (a === -1) return b;
        if (b === -1) return a;
        return Math.min(a, b);
    }

    private couldBePartialTag(buffer: string, tag: string): boolean {
        for (let i = 1; i < tag.length; i++) {
            if (buffer.endsWith(tag.slice(0, i))) return true;
        }
        return false;
    }
}

// ============================================================================
// Factory
// ============================================================================

export interface DecoderOptions {
    /** Known tool names for text-based tool call recovery */
    knownToolNames?: Set<string>;
}

/**
 * Create a stream decoder by type.
 */
export function createDecoder(
    type: DecoderType,
    callback: DecoderCallback,
    _options?: DecoderOptions,
): StreamDecoder {
    switch (type) {
        case 'passthrough':
            return new PassthroughDecoder(callback);
        case 'standard-chat':
            return new StandardChatDecoder(callback);
        case 'interleaved-reasoning':
            return new InterleavedReasoningDecoder(callback);
        default:
            throw new Error(`Unknown decoder type: ${type}`);
    }
}
