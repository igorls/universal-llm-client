/**
 * Unified thinking/reasoning resolution shared by all providers.
 *
 * Applications set a single `thinking` value — `true`/`false` or a level
 * ('minimal' | 'low' | 'medium' | 'high') — at the model level and/or per call.
 * Each provider maps the resolved intent to its native control (Gemini
 * `thinkingLevel`/`thinkingBudget`, OpenAI `reasoning_effort`, vLLM
 * `enable_thinking`, Anthropic `budget_tokens`, Ollama `think`).
 */
import type { ThinkingLevel } from './interfaces.js';

export interface ResolvedThinking {
    /** Whether reasoning should be enabled at all. */
    enabled: boolean;
    /** Explicit level when the user provided one (absent for a bare `true`). */
    level?: ThinkingLevel;
}

const LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high'];

function isLevel(v: unknown): v is ThinkingLevel {
    return typeof v === 'string' && LEVELS.includes(v);
}

/**
 * Resolve the effective thinking intent from a per-call value (highest
 * precedence) and the model-level config value. Returns `undefined` when
 * neither is set, so providers omit the control entirely (and don't perturb
 * servers that reject unknown fields).
 */
export function resolveThinking(
    perCall: boolean | ThinkingLevel | undefined,
    config: boolean | ThinkingLevel | undefined,
): ResolvedThinking | undefined {
    const value = perCall ?? config;
    if (value === undefined) return undefined;
    if (value === false) return { enabled: false };
    if (value === true) return { enabled: true };
    if (isLevel(value)) return { enabled: true, level: value };
    return undefined; // unknown string — ignore defensively
}

/** Heuristic: OpenAI reasoning models use `reasoning_effort` (o-series, GPT-5). */
export function isOpenAIReasoningModel(model: string): boolean {
    return /^(o\d|gpt-5)/i.test(model);
}

/**
 * Hosted, OpenAI-*compatible* gateways that validate the request body strictly
 * and reject unknown fields with HTTP 400 — just like official OpenAI. The
 * `chat_template_kwargs` knob (below) is a self-hosted vLLM/SGLang extension and
 * must NOT be sent to these. Matched as case-insensitive host substrings.
 */
const STRICT_OPENAI_COMPAT_HOSTS: readonly string[] = [
    'api.openai.com',
    'api.cerebras.ai',
    'api.groq.com',
    'api.fireworks.ai',
    'api.together.xyz',
    'api.together.ai',
    'api.mistral.ai',
    'api.deepseek.com',
    'api.perplexity.ai',
    'openrouter.ai',
    'api.x.ai',
];

/**
 * Whether an OpenAI-compatible endpoint accepts the vLLM/SGLang
 * `chat_template_kwargs` extension (used to toggle `enable_thinking`).
 *
 * This is a self-hosted-server feature. Commercial hosted gateways that expose
 * an OpenAI-compatible surface (OpenAI, Cerebras, Groq, Fireworks, Together,
 * Mistral, DeepSeek, OpenRouter, …) reject unknown body fields, so we only send
 * it to endpoints not on the strict list (assumed self-hosted vLLM/Qwen). When
 * the URL is unknown/empty we default to permissive (self-hosted) behavior to
 * preserve the prior contract for local servers.
 */
export function supportsChatTemplateKwargs(url: string | undefined): boolean {
    const u = (url ?? '').toLowerCase();
    return !STRICT_OPENAI_COMPAT_HOSTS.some((host) => u.includes(host));
}

/**
 * Whether the endpoint is a hosted, strictly-validating OpenAI-compatible
 * gateway (official OpenAI + the gateways in {@link STRICT_OPENAI_COMPAT_HOSTS}).
 * These reject `reasoning_effort` alongside function tools on
 * `/v1/chat/completions` unless it is `'none'` (HTTP 400). Inverse of
 * {@link supportsChatTemplateKwargs}; an unknown/empty URL is treated as NOT
 * strict (assumed self-hosted), matching the permissive default there.
 */
export function isStrictOpenAICompatHost(url: string | undefined): boolean {
    const u = (url ?? '').toLowerCase();
    return STRICT_OPENAI_COMPAT_HOSTS.some((host) => u.includes(host));
}

/**
 * Gemini 2.5 `thinkingBudget` for a level. 0 disables, -1 is dynamic, and the
 * Flash range is 0–24576. A bare `true` (no level) maps to dynamic (-1).
 */
export function geminiThinkingBudget(level: ThinkingLevel | undefined): number {
    switch (level) {
        case 'minimal': return 512;
        case 'low': return 2048;
        case 'medium': return 8192;
        case 'high': return 24576;
        default: return -1; // enabled without an explicit level → dynamic
    }
}

/**
 * Anthropic extended-thinking `budget_tokens` for a level, kept >= 1024 (the
 * API minimum) and < `maxTokens` (the API requires headroom for the answer).
 */
export function anthropicThinkingBudget(level: ThinkingLevel | undefined, maxTokens: number): number {
    const base = level === 'high' ? 16384
        : level === 'medium' ? 4096
        : level === 'low' ? 1024
        : level === 'minimal' ? 1024
        : 2048; // bare `true`
    return Math.max(1024, Math.min(base, maxTokens - 1024));
}
