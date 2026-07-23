/**
 * Universal LLM Client v3 — Stream Decoder
 *
 * Pluggable interface for decoding raw LLM token streams into typed events.
 * Consumers select their strategy per-call: passthrough for raw speed,
 * standard-chat for structured tool calls, or interleaved-reasoning
 * for models that emit <think>/<progress> tags.
 */

import type { LLMToolCall } from './interfaces.js';
import { normalizeGemmaThought } from './gemma-channel.js';
import { gemmaArgsToJson, parseGemmaToolCallBody } from './gemma-diffusion.js';

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
    /** Feed native reasoning tokens from the provider, if supported */
    pushReasoning?(content: string): void;
    /** Feed structured tool calls from the provider API response, if supported */
    pushToolCalls?(calls: LLMToolCall[]): void;
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

interface BareCallParseResult {
    readonly status: 'complete' | 'incomplete' | 'invalid';
    readonly segment?: string;
    readonly name?: string;
    readonly argumentsJson?: string;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // not JSON
    }
    return null;
}

function parseLooseArguments(rawArgs: string): string | null {
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

function suffixThatPrefixes(value: string, prefix: string): string {
    const max = Math.min(value.length, prefix.length - 1);
    for (let len = max; len > 0; len--) {
        const suffix = value.slice(-len);
        if (prefix.startsWith(suffix)) return suffix;
    }
    return '';
}

function resolveKnownToolName(name: string, knownToolNames: Set<string>): string | null {
    if (knownToolNames.has(name)) return name;
    const stripped = name.replace(/^@[^:]+:/, '');
    if (stripped !== name && knownToolNames.has(stripped)) return stripped;
    const sanitized = stripped
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
    if (sanitized && knownToolNames.has(sanitized)) return sanitized;
    const tail = name.includes(':')
        ? name.slice(name.lastIndexOf(':') + 1)
        : name.includes('/')
          ? name.slice(name.lastIndexOf('/') + 1)
          : '';
    if (tail && knownToolNames.has(tail)) return tail;
    return null;
}

function parseBareCallAtStart(text: string): BareCallParseResult {
    if (!text.startsWith('call:')) return { status: 'invalid' };
    let pos = 'call:'.length;
    // Optional whitespace: Cerebras gemma-4 often emits `call: @module/path:tool {}`
    while (pos < text.length && /\s/u.test(text[pos]!)) pos++;
    if (pos >= text.length) return { status: 'incomplete' };
    const first = text[pos]!;
    if (!/[@A-Za-z_]/u.test(first)) return { status: 'invalid' };

    const nameStart = pos;
    pos++;
    // Allow `/` in module-qualified names (`@community/comfyui:comfy_list_models`)
    while (pos < text.length && /[@A-Za-z0-9_./:-]/u.test(text[pos]!)) pos++;
    const name = text.slice(nameStart, pos);
    while (pos < text.length && /\s/u.test(text[pos]!)) pos++;
    if (pos >= text.length) return { status: 'incomplete' };
    const opener = text[pos];
    if (opener !== '(' && opener !== '{') return { status: 'invalid' };
    const primaryClose = opener === '(' ? ')' : '}';
    const toleratedClose = opener === '(' ? '}' : undefined;

    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    for (let i = pos; i < text.length; i++) {
        const ch = text[i]!;
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
                const segment = text.slice(0, i + 1);
                const rawArgs = text.slice(pos + 1, i).trim();
                const argumentsJson = parseLooseArguments(rawArgs);
                if (!argumentsJson) return { status: 'invalid' };
                return { status: 'complete', segment, name, argumentsJson };
            }
        } else if (depth === 1 && toleratedClose !== undefined && ch === toleratedClose) {
            const rawArgs = text.slice(pos + 1, i).trim();
            if (rawArgs.startsWith('{')) continue;
            const argumentsJson = parseLooseArguments(rawArgs);
            if (!argumentsJson) continue;
            return { status: 'complete', segment: text.slice(0, i + 1), name, argumentsJson };
        }
    }

    return { status: 'incomplete' };
}

interface OpenerMatch {
    readonly type: 'progress' | 'gemma-thought' | 'think' | 'tool-call' | 'gemma-tool-call' | 'tool-response' | 'discard';
    readonly close: string;
}

/**
 * Match a partial `<…`-prefixed buffer against every structural opener the
 * decoder understands. Returns `matches: true` while the buffer is still a
 * viable prefix of some opener, and a `fullMatch` (with its closing token)
 * once the whole opener has arrived. This is what lets tags stream in
 * token-by-token without leaking partial markup as visible text.
 */
function checkOpenerMatch(candidate: string): { readonly matches: boolean; readonly fullMatch?: OpenerMatch } {
    // <progress>…</progress>
    if ('<progress>'.startsWith(candidate)) {
        return {
            matches: true,
            fullMatch: candidate === '<progress>' ? { type: 'progress', close: '</progress>' } : undefined,
        };
    }

    // <think>…</think>
    if ('<think>'.startsWith(candidate)) {
        return {
            matches: true,
            fullMatch: candidate === '<think>' ? { type: 'think', close: '</think>' } : undefined,
        };
    }

    // <thinking>…</thinking>
    if ('<thinking>'.startsWith(candidate)) {
        return {
            matches: true,
            fullMatch: candidate === '<thinking>' ? { type: 'think', close: '</thinking>' } : undefined,
        };
    }

    // <tool_call|>…<|tool_response>  (legacy JSON tool-call grammar)
    if ('<tool_call|>'.startsWith(candidate)) {
        return {
            matches: true,
            fullMatch: candidate === '<tool_call|>' ? { type: 'tool-call', close: '<|tool_response>' } : undefined,
        };
    }

    // <|tool_response>  (stray closer to strip)
    if ('<|tool_response>'.startsWith(candidate)) {
        return {
            matches: true,
            fullMatch: candidate === '<|tool_response>' ? { type: 'tool-response', close: '' } : undefined,
        };
    }

    // <|tool_call>call:name{…}<tool_call|>  (DiffusionGemma native tool call)
    if ('<|tool_call>'.startsWith(candidate)) {
        return {
            matches: true,
            fullMatch: candidate === '<|tool_call>' ? { type: 'gemma-tool-call', close: '<tool_call|>' } : undefined,
        };
    }

    // Stray DiffusionGemma markers that must never reach visible text:
    // unbalanced <channel|> closers and <turn|> turn terminators.
    if ('<channel|>'.startsWith(candidate)) {
        return {
            matches: true,
            fullMatch: candidate === '<channel|>' ? { type: 'discard', close: '' } : undefined,
        };
    }
    if ('<turn|>'.startsWith(candidate)) {
        return {
            matches: true,
            fullMatch: candidate === '<turn|>' ? { type: 'discard', close: '' } : undefined,
        };
    }

    // <|thought … |>  (compact Gemma thought marker)
    if ('<|thought'.startsWith(candidate)) {
        return {
            matches: true,
            fullMatch: candidate === '<|thought' ? { type: 'gemma-thought', close: '|>' } : undefined,
        };
    }

    // <|channel>\s*thought … <channel|>  (Gemma thought channel, whitespace-tolerant)
    if (candidate.startsWith('<')) {
        if ('<|channel>'.startsWith(candidate)) {
            return { matches: true };
        }
        if (candidate.startsWith('<|channel>')) {
            const suffix = candidate.slice('<|channel>'.length);
            const suffixRegex = /^\s*(t(h(o(u(g(h(t)?)?)?)?)?)?)?$/i;
            if (suffixRegex.test(suffix)) {
                const isFullMatch = /^\s*thought$/i.test(suffix);
                return {
                    matches: true,
                    fullMatch: isFullMatch ? { type: 'gemma-thought', close: '<channel|>' } : undefined,
                };
            }
        }
    }

    return { matches: false };
}

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
    private readonly knownToolNames?: Set<string>;
    private tagBuffer = '';
    private pendingText = '';
    private pendingReasoning = '';
    private inProgressTag = false;
    private progressBody = '';
    private inGemmaThought = false;
    private gemmaThoughtBody = '';
    private gemmaThoughtClose = '';
    private inThinkTag = false;
    private thinkBody = '';
    private thinkClose = '';
    private inToolCallTag = false;
    private toolCallBody = '';
    private toolCallClose = '';
    private toolCallKind: 'json' | 'gemma' = 'json';

    constructor(callback: DecoderCallback, options: DecoderOptions = {}) {
        this.callback = callback;
        this.knownToolNames = options.knownToolNames;
    }

    push(token: string): void {
        let pos = 0;

        while (pos < token.length) {
            if (this.inGemmaThought) {
                this.gemmaThoughtBody += token.slice(pos);
                const closeIdx = this.gemmaThoughtBody.indexOf(this.gemmaThoughtClose);
                if (closeIdx !== -1) {
                    const body = this.gemmaThoughtBody.slice(0, closeIdx);
                    const remainder = this.gemmaThoughtBody.slice(closeIdx + this.gemmaThoughtClose.length);
                    this.pushDecodedReasoning(normalizeGemmaThought(body));
                    this.inGemmaThought = false;
                    this.gemmaThoughtBody = '';
                    this.gemmaThoughtClose = '';
                    if (remainder) this.push(remainder);
                }
                return;
            }

            if (this.inThinkTag) {
                this.thinkBody += token.slice(pos);
                const closeIdx = this.thinkBody.indexOf(this.thinkClose);
                if (closeIdx !== -1) {
                    const body = this.thinkBody.slice(0, closeIdx);
                    const remainder = this.thinkBody.slice(closeIdx + this.thinkClose.length);
                    this.pushDecodedReasoning(normalizeGemmaThought(body));
                    this.inThinkTag = false;
                    this.thinkBody = '';
                    this.thinkClose = '';
                    if (remainder) this.push(remainder);
                }
                return;
            }

            if (this.inToolCallTag) {
                this.toolCallBody += token.slice(pos);
                const closeIdx = this.toolCallBody.indexOf(this.toolCallClose);
                if (closeIdx !== -1) {
                    const body = this.toolCallBody.slice(0, closeIdx);
                    const remainder = this.toolCallBody.slice(closeIdx + this.toolCallClose.length);

                    if (this.toolCallKind === 'gemma') {
                        // DiffusionGemma native: call:name{pseudo-json args}
                        const parsed = parseGemmaToolCallBody(body);
                        if (parsed) {
                            this.callback({
                                type: 'tool_call',
                                calls: [
                                    {
                                        id: `gemma_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                                        type: 'function',
                                        function: { name: parsed.name, arguments: parsed.argumentsJson },
                                    },
                                ],
                            });
                        }
                    } else if (body.trim()) {
                        try {
                            const normalizedJson = body.trim()
                                .replace(/'/g, '"')
                                .replace(/True/g, 'true')
                                .replace(/False/g, 'false')
                                .replace(/None/g, 'null');
                            const parsed = JSON.parse(normalizedJson);
                            const calls = Array.isArray(parsed) ? parsed : [parsed];
                            const validatedCalls: LLMToolCall[] = [];
                            for (const call of calls) {
                                if (call && typeof call === 'object' && call.name) {
                                    validatedCalls.push({
                                        id: call.id || `recovered_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                                        type: 'function',
                                        function: {
                                            name: call.name,
                                            arguments: typeof call.arguments === 'string'
                                                ? call.arguments
                                                : JSON.stringify(call.arguments ?? {}),
                                        }
                                    });
                                }
                            }
                            if (validatedCalls.length > 0) {
                                this.callback({ type: 'tool_call', calls: validatedCalls });
                            }
                        } catch {
                            // ignore
                        }
                    }

                    this.inToolCallTag = false;
                    this.toolCallBody = '';
                    this.toolCallClose = '';
                    if (remainder) this.push(remainder);
                }
                return;
            }

            if (this.inProgressTag) {
                this.progressBody += token.slice(pos);
                const closeIdx = this.progressBody.indexOf('</progress>');
                if (closeIdx !== -1) {
                    const body = this.progressBody.slice(0, closeIdx);
                    const remainder = this.progressBody.slice(closeIdx + '</progress>'.length);
                    if (body) {
                        this.callback({ type: 'progress', content: body });
                    }
                    this.inProgressTag = false;
                    this.progressBody = '';
                    if (remainder) this.push(remainder);
                }
                return;
            }

            if (this.tagBuffer.length > 0) {
                const ch = token[pos]!;
                pos++;
                this.tagBuffer += ch;
                const matchResult = checkOpenerMatch(this.tagBuffer);
                if (matchResult.matches) {
                    if (matchResult.fullMatch) {
                        const fm = matchResult.fullMatch;
                        if (fm.type === 'progress') {
                            this.inProgressTag = true;
                            this.progressBody = '';
                        } else if (fm.type === 'think') {
                            this.inThinkTag = true;
                            this.thinkBody = '';
                            this.thinkClose = fm.close;
                        } else if (fm.type === 'gemma-thought') {
                            this.inGemmaThought = true;
                            this.gemmaThoughtBody = '';
                            this.gemmaThoughtClose = fm.close;
                        } else if (fm.type === 'tool-call') {
                            this.inToolCallTag = true;
                            this.toolCallBody = '';
                            this.toolCallClose = fm.close;
                            this.toolCallKind = 'json';
                        } else if (fm.type === 'gemma-tool-call') {
                            this.inToolCallTag = true;
                            this.toolCallBody = '';
                            this.toolCallClose = fm.close;
                            this.toolCallKind = 'gemma';
                        }
                        // 'tool-response' / 'discard': nothing to open — just drop the marker
                        this.tagBuffer = '';
                    }
                    // else keep buffering (still a viable opener prefix)
                } else {
                    this.pushDecodedText(this.tagBuffer);
                    this.tagBuffer = '';
                }
                continue;
            }

            const ltIdx = token.indexOf('<', pos);
            if (ltIdx === -1) {
                this.pushDecodedText(token.slice(pos));
                return;
            }

            if (ltIdx > pos) {
                this.pushDecodedText(token.slice(pos, ltIdx));
            }
            this.tagBuffer = '<';
            pos = ltIdx + 1;
        }
    }

    private pushDecodedText(text: string): void {
        this.pendingText += text;
        this.drainBareCallBuffer('text', false);
    }

    private pushDecodedReasoning(text: string): void {
        this.pendingReasoning += text;
        this.drainBareCallBuffer('reasoning', false);
    }

    private emitVisibleText(text: string): void {
        if (!text) return;
        this.content += text;
        this.callback({ type: 'text', content: text });
    }

    private emitReasoningText(content: string): void {
        if (!content) return;
        this.reasoning += content;
        this.callback({ type: 'thinking', content });
    }

    private emitRecoveredBareCall(name: string, argumentsJson: string): void {
        this.callback({
            type: 'tool_call',
            calls: [
                {
                    id: `recovered_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                    type: 'function',
                    function: { name, arguments: argumentsJson },
                },
            ],
        });
    }

    private drainBareCallBuffer(kind: 'text' | 'reasoning', final: boolean): void {
        const emit = kind === 'text'
            ? (text: string) => this.emitVisibleText(text)
            : (text: string) => this.emitReasoningText(text);
        const knownToolNames = this.knownToolNames;
        if (!knownToolNames?.size) {
            const buffered = kind === 'text' ? this.pendingText : this.pendingReasoning;
            if (kind === 'text') this.pendingText = '';
            else this.pendingReasoning = '';
            emit(buffered);
            return;
        }

        let buffer = kind === 'text' ? this.pendingText : this.pendingReasoning;
        while (buffer.length > 0) {
            const callIdx = buffer.indexOf('call:');
            if (callIdx < 0) {
                const keep = final ? '' : suffixThatPrefixes(buffer, 'call:');
                const ready = keep ? buffer.slice(0, -keep.length) : buffer;
                emit(ready);
                buffer = keep;
                break;
            }

            if (callIdx > 0) {
                emit(buffer.slice(0, callIdx));
                buffer = buffer.slice(callIdx);
                continue;
            }

            const parsed = parseBareCallAtStart(buffer);
            if (parsed.status === 'incomplete') {
                if (!final) break;
                emit(buffer);
                buffer = '';
                break;
            }

            if (parsed.status === 'invalid' || !parsed.segment || !parsed.name || !parsed.argumentsJson) {
                emit(buffer.slice(0, 'call:'.length));
                buffer = buffer.slice('call:'.length);
                continue;
            }

            const resolvedName = resolveKnownToolName(parsed.name, knownToolNames);
            if (resolvedName) {
                this.emitRecoveredBareCall(resolvedName, parsed.argumentsJson);
            } else {
                emit(parsed.segment);
            }
            buffer = buffer.slice(parsed.segment.length);
        }

        if (kind === 'text') this.pendingText = buffer;
        else this.pendingReasoning = buffer;
    }

    /** Feed native reasoning tokens from the provider */
    pushReasoning(content: string): void {
        this.pushDecodedReasoning(content);
    }

    /** Feed structured tool calls from the provider API response */
    pushToolCalls(calls: LLMToolCall[]): void {
        this.callback({ type: 'tool_call', calls });
    }

    flush(): void {
        if (this.tagBuffer) {
            this.pushDecodedText(this.tagBuffer);
            this.tagBuffer = '';
        }
        this.drainBareCallBuffer('text', true);
        if (this.inGemmaThought) {
            this.pushDecodedReasoning(normalizeGemmaThought(this.gemmaThoughtBody));
            this.inGemmaThought = false;
            this.gemmaThoughtBody = '';
            this.gemmaThoughtClose = '';
        }
        // Treat an unclosed think/thinking block as reasoning, not visible text.
        if (this.inThinkTag) {
            this.pushDecodedReasoning(normalizeGemmaThought(this.thinkBody));
            this.inThinkTag = false;
            this.thinkBody = '';
            this.thinkClose = '';
        }
        if (this.inProgressTag) {
            if (this.progressBody) {
                this.pushDecodedText('<progress>' + this.progressBody);
            }
            this.inProgressTag = false;
            this.progressBody = '';
        }
        this.drainBareCallBuffer('reasoning', true);
        if (this.inToolCallTag) {
            this.inToolCallTag = false;
            this.toolCallBody = '';
            this.toolCallClose = '';
        }
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
// Pluggable Decoder Registry
// ============================================================================

export interface DecoderOptions {
    /** Known tool names for text-based tool call recovery */
    knownToolNames?: Set<string>;
}

/**
 * Factory function that creates a StreamDecoder instance.
 * External code registers these via `registerDecoder()`.
 */
export type DecoderFactory = (callback: DecoderCallback, options?: DecoderOptions) => StreamDecoder;

/** Internal registry of decoder factories, keyed by decoder type name */
const decoderRegistry = new Map<string, DecoderFactory>();

/**
 * Register a custom stream decoder type.
 * Once registered, it can be used via `createDecoder(name, ...)` or
 * by passing `decoderType: name` in ChatOptions.
 *
 * @example
 * ```typescript
 * import { registerDecoder } from 'universal-llm-client';
 *
 * registerDecoder('my-decoder', (callback, options) => {
 *   return new MyCustomDecoder(callback, options);
 * });
 * ```
 */
export function registerDecoder(type: string, factory: DecoderFactory): void {
    decoderRegistry.set(type, factory);
}

/**
 * Get all registered decoder type names.
 */
export function getRegisteredDecoders(): string[] {
    return Array.from(decoderRegistry.keys());
}

// Pre-register built-in decoders
registerDecoder('passthrough', (cb) => new PassthroughDecoder(cb));
registerDecoder('standard-chat', (cb, options) => new StandardChatDecoder(cb, options));
registerDecoder('interleaved-reasoning', (cb) => new InterleavedReasoningDecoder(cb));

/**
 * Create a stream decoder by type name.
 * Looks up the decoder in the registry (built-in + custom).
 *
 * @throws Error if the decoder type is not registered
 */
export function createDecoder(
    type: DecoderType | string,
    callback: DecoderCallback,
    options?: DecoderOptions,
): StreamDecoder {
    const factory = decoderRegistry.get(type);
    if (!factory) {
        const available = Array.from(decoderRegistry.keys()).join(', ');
        throw new Error(`Unknown decoder type: "${type}". Available: ${available}`);
    }
    return factory(callback, options);
}

