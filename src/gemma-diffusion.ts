/**
 * DiffusionGemma (vLLM) native-protocol adapter.
 *
 * Trimmed vLLM builds that serve DiffusionGemma ship with NO reasoning parser
 * and NO tool-call parser module, and they reject OpenAI-style `tools` unless
 * `--tool-call-parser` is configured. Everything therefore has to be handled
 * client-side, against the model's native channel format (visible only when
 * the request sets `skip_special_tokens: false`):
 *
 *   <|channel>thought ...reasoning... <channel|>          reasoning channel
 *   <|tool_call>call:name{k:<|"|>v<|"|>,n:3}<tool_call|>  tool call
 *
 * Tool-call arguments are NOT JSON: keys are bare, strings are wrapped in the
 * <|"|> quote token, numbers/booleans are bare (see the model's
 * chat_template.jinja `format_argument` macro). `gemmaArgsToJson` converts
 * that into a standard JSON string.
 *
 * Request-side protocol (implemented in the OpenAI provider):
 *   - always send `skip_special_tokens: false`
 *   - send `tools` with `tool_choice: 'none'` — vLLM still renders the
 *     declarations into the chat template, it just skips its (absent) parser
 *   - send history tool turns structurally (assistant `tool_calls` +
 *     `role: 'tool'` messages) — the chat template renders them natively
 */

import { extractGemmaThoughtChannels } from './gemma-channel.js';

export interface GemmaParsedToolCall {
    readonly name: string;
    /** JSON-encoded arguments object, ready for LLMToolCall.function.arguments */
    readonly argumentsJson: string;
}

export interface GemmaDiffusionParsed {
    /** Final answer with reasoning, tool-call blocks and special tokens removed */
    readonly content: string;
    readonly reasoning: string;
    readonly toolCalls: readonly GemmaParsedToolCall[];
}

/** Models that speak this native protocol when served by vLLM. */
export function isGemmaDiffusionModel(model: string): boolean {
    return /diffusion[-_]?gemma/i.test(model);
}

/**
 * Request params that must accompany a DiffusionGemma model call so the native
 * protocol tokens (thought channels, `<|tool_call>` markers) survive to the
 * decoder instead of being stripped by the server's `skip_special_tokens`
 * default.
 */
export const GEMMA_DIFFUSION_REQUEST_PARAMS: Readonly<Record<string, unknown>> = {
    skip_special_tokens: false,
};

// Grammar tolerance: models that learned the textual `call:name({...})` form
// (observed live — a poisoned-history session emitted
// `<|tool_call>call:sessions({action: "list"})<tool_call|>`) wrap the brace
// body in parentheses. Accept the optional (...) wrapper instead of silently
// swallowing the call.
const TOOL_CALL_BLOCK =
    /<\|tool_call>\s*call:([a-zA-Z0-9_.-]+)\s*(?:\(\s*)?\{([\s\S]*?)\}(?:\s*\))?\s*<tool_call\|>/g;

/**
 * Residual control tokens that may leak into text output — including stray
 * unbalanced channel markers (the model occasionally emits an extra
 * <channel|> closer mid-answer).
 */
const RESIDUAL_SPECIAL = /<\|?(?:turn|think|image|audio|video|tool_response|tool_call|tool|channel)\b[^>]*?\|?>|<(?:turn|channel|tool_response|tool_call|tool)\|>/g;

const QUOTE_TOKEN = '<|"|>';

/**
 * Convert the Gemma template's pseudo-JSON argument syntax to a JSON string.
 * Lenient by design: bare words that aren't numbers/booleans become strings,
 * since the model occasionally omits the quote token.
 */
export function gemmaArgsToJson(body: string): string {
    // Argument bodies arrive without their outer braces (the regex strips them)
    const src = `{${body}}`;
    let i = 0;
    const n = src.length;

    function skipWs(): void {
        while (i < n && /\s/.test(src[i]!)) i++;
    }

    function parseQuoted(): string {
        // positioned at the start of QUOTE_TOKEN
        i += QUOTE_TOKEN.length;
        const end = src.indexOf(QUOTE_TOKEN, i);
        const raw = end === -1 ? src.slice(i) : src.slice(i, end);
        i = end === -1 ? n : end + QUOTE_TOKEN.length;
        return raw;
    }

    function parseStringQuote(): string {
        const quote = src[i]!;
        i++;
        let out = '';
        let escaped = false;
        while (i < n) {
            const ch = src[i]!;
            i++;
            if (escaped) {
                out += ch;
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === quote) {
                break;
            } else {
                out += ch;
            }
        }
        return out;
    }

    function parseBare(stops: string): string {
        const start = i;
        while (i < n && !stops.includes(src[i]!) && !src.startsWith(QUOTE_TOKEN, i)) i++;
        return src.slice(start, i).trim();
    }

    function parseValue(): string {
        skipWs();
        if (src.startsWith(QUOTE_TOKEN, i)) return JSON.stringify(parseQuoted());
        const c = src[i];
        if (c === '"' || c === "'") return JSON.stringify(parseStringQuote());
        if (c === '{') return parseObject();
        if (c === '[') return parseArray();
        const bare = parseBare(',}]');
        if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(bare)) return bare;
        if (bare === 'true' || bare === 'false' || bare === 'null') return bare;
        return JSON.stringify(bare);
    }

    function parseObject(): string {
        i++; // consume {
        const parts: string[] = [];
        skipWs();
        while (i < n && src[i] !== '}') {
            skipWs();
            const key = src.startsWith(QUOTE_TOKEN, i) ? parseQuoted() : parseBare(':');
            skipWs();
            if (src[i] === ':') i++;
            const value = parseValue();
            parts.push(`${JSON.stringify(key.trim())}:${value}`);
            skipWs();
            if (src[i] === ',') i++;
            skipWs();
        }
        i++; // consume }
        return `{${parts.join(',')}}`;
    }

    function parseArray(): string {
        i++; // consume [
        const parts: string[] = [];
        skipWs();
        while (i < n && src[i] !== ']') {
            parts.push(parseValue());
            skipWs();
            if (src[i] === ',') i++;
            skipWs();
        }
        i++; // consume ]
        return `[${parts.join(',')}]`;
    }

    skipWs();
    return parseObject();
}

/**
 * Parse a complete raw DiffusionGemma output into reasoning, tool calls and
 * clean answer text.
 */
/**
 * Parse a single DiffusionGemma tool-call body of the form
 * `call:name{pseudo-json}` into a normalized `{name, argumentsJson}`.
 * Returns null when the body doesn't match the grammar. Used by the stream
 * decoder to recover native `<|tool_call>…<tool_call|>` calls token-by-token.
 */
export function parseGemmaToolCallBody(body: string): GemmaParsedToolCall | null {
    const m =
        body.match(/^\s*call:([a-zA-Z0-9_.-]+)\s*\{([\s\S]*)\}\s*$/) ??
        // Parenthesized textual form: call:name({...}) — seen from models that
        // learned the pseudo-call style from history.
        body.match(/^\s*call:([a-zA-Z0-9_.-]+)\s*\(\s*\{([\s\S]*)\}\s*\)\s*$/);
    if (!m) return null;
    return { name: m[1]!, argumentsJson: gemmaInnerArgsToJson(m[2]!) };
}

/**
 * Argument bodies may be REAL JSON (double-quoted keys — the textual
 * `call:name({"k": "v"})` form) or Gemma pseudo-JSON (bare keys, quote
 * tokens). Try strict JSON first; gemmaArgsToJson double-encodes quoted keys.
 */
function gemmaInnerArgsToJson(inner: string): string {
    try {
        return JSON.stringify(JSON.parse(`{${inner}}`));
    } catch {
        return gemmaArgsToJson(inner);
    }
}

export function parseGemmaDiffusionOutput(raw: string): GemmaDiffusionParsed {
    if (!raw) return { content: raw, reasoning: '', toolCalls: [] };

    const toolCalls: GemmaParsedToolCall[] = [];
    let text = raw.replace(TOOL_CALL_BLOCK, (_m, name: string, args: string) => {
        toolCalls.push({ name, argumentsJson: gemmaInnerArgsToJson(args) });
        return '';
    });

    const channels = extractGemmaThoughtChannels(text);
    text = channels.content;

    // Unterminated thought channel (model hit max_tokens mid-reasoning)
    let reasoning = channels.reasoning;
    const danglingThought = text.match(/<\|channel>\s*thought\s*\r?\n?([\s\S]*)$/i);
    if (danglingThought) {
        reasoning = reasoning ? `${reasoning}\n\n${danglingThought[1]!.trim()}` : danglingThought[1]!.trim();
        text = text.slice(0, danglingThought.index);
    }

    text = text.replace(RESIDUAL_SPECIAL, '');

    return {
        content: text.trim(),
        reasoning,
        toolCalls,
    };
}
