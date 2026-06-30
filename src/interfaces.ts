/**
 * Universal LLM Client v3 — Core Interfaces
 *
 * All types, enums, and helper functions used throughout the library.
 * Zero dependencies — pure TypeScript types.
 */

// ============================================================================
// Enums
// ============================================================================

export enum AIModelType {
    Chat = 'chat',
    Embedding = 'embedding',
}

export enum AIModelApiType {
    Ollama = 'ollama',
    OpenAI = 'openai',
    Google = 'google',
    Vertex = 'vertex',
    LlamaCpp = 'llamacpp',
    Anthropic = 'anthropic',
}

// ============================================================================
// Model Metadata
// ============================================================================

export interface ModelMetadata {
    /** Model name as reported by provider */
    model?: string;
    /** Context window size in tokens */
    contextLength: number;
    /** Model architecture (e.g., "llama", "mistral3") */
    architecture?: string;
    /** Parameter count */
    parameterCount?: number;
    /** Model capabilities reported by provider (e.g., "tools", "vision", "thinking") */
    capabilities?: string[];
}

// ============================================================================
// Provider Configuration (user-facing)
// ============================================================================

export interface ProviderConfig {
    /** Provider type */
    type: AIModelApiType | 'ollama' | 'openai' | 'google' | 'vertex' | 'llamacpp' | 'anthropic';
    /** Provider endpoint URL (has sensible defaults per type) */
    url?: string;
    /** API key or Bearer token */
    apiKey?: string;
    /** Override model name for this specific provider */
    model?: string;
    /** Explicit priority (default: array order, lower = higher priority) */
    priority?: number;
    /** Vertex AI region (e.g., "us-central1") */
    region?: string;
    /** Google API version (default: "v1beta") */
    apiVersion?: 'v1' | 'v1beta';
    /**
     * Extra headers merged into requests, applied by providers that use
     * `buildHeaders` — **OpenAI-compatible and Ollama**. Google/Vertex and
     * Anthropic build their own auth headers and ignore this. Useful for Azure
     * (api-key), custom gateways, or non-standard auth. Merged after the default
     * auth header (later entries win).
     */
    headers?: Record<string, string>;

    /**
     * Extra query parameters appended to request URLs — **OpenAI-compatible
     * provider only**. Useful for Azure OpenAI (e.g. { 'api-version': '2024-10-21' }).
     */
    queryParams?: Record<string, string>;

    /**
     * Override the name of the header that carries the API key (default:
     * "Authorization") — **OpenAI-compatible and Ollama only** (via `buildHeaders`).
     * Common alternative for Azure and some gateways: "api-key".
     */
    authHeader?: string;

    /**
     * Prefix placed before the apiKey value in the auth header (OpenAI-compatible
     * and Ollama only). Default: "Bearer " when authHeader is Authorization (or
     * unset), otherwise "". Set to "" explicitly for "api-key: <yourkey>" style auth.
     */
    authPrefix?: string;

    /**
     * For OpenAI-compatible providers only: the URL path segment to append after the base URL.
     * Default: "/v1".
     * Set to "" (or "/") to disable the automatic append. This is required when supplying
     * a full Azure deployment URL such as ".../deployments/my-deploy".
     */
    apiBasePath?: string;
}

// ============================================================================
// Thinking / Reasoning control
// ============================================================================

/**
 * Unified reasoning-effort level. Mapped to each provider's native control:
 * Gemini 3.x `thinkingConfig.thinkingLevel`, OpenAI `reasoning_effort`,
 * Gemini 2.5 `thinkingBudget`, Anthropic `budget_tokens`, vLLM/Ollama on/off.
 */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

// ============================================================================
// AIModel Configuration (user-facing)
// ============================================================================

export interface AIModelConfig {
    /** Model name (used across all providers unless overridden) */
    model: string;
    /** Ordered list of providers (first = highest priority) */
    providers: ProviderConfig[];
    /** Default parameters for all requests (temperature, top_p, etc.) */
    defaultParameters?: Record<string, unknown>;
    /** Enable thinking/reasoning — `true`/`false` or a level ('minimal' | 'low' | 'medium' | 'high'). */
    thinking?: boolean | ThinkingLevel;
    /** Request timeout in ms (default: 30000) */
    timeout?: number;
    /** Retries per provider before failover (default: 2) */
    retries?: number;
    /** Observability hooks */
    auditor?: import('./auditor.js').Auditor;
    /** Enable debug logging */
    debug?: boolean;
}

// ============================================================================
// Internal Client Options
// ============================================================================

export interface LLMClientOptions {
    /** Model name */
    model: string;
    /** Base URL for the API */
    url: string;
    /** API type for protocol variations */
    apiType: AIModelApiType;
    /** Model type (chat or embedding) */
    modelType?: AIModelType;
    /** Default parameters for requests */
    defaultParameters?: Record<string, unknown>;
    /** Enable thinking/reasoning — `true`/`false` or a level ('minimal' | 'low' | 'medium' | 'high'). */
    thinking?: boolean | ThinkingLevel;
    /** Request timeout in ms */
    timeout?: number;
    /** Number of retries for failed requests */
    retries?: number;
    /** API key for authenticated endpoints */
    apiKey?: string;
    /** Enable debug logging */
    debug?: boolean;
    /** Vertex AI region */
    region?: string;
    /** Google API version */
    apiVersion?: 'v1' | 'v1beta';
    /**
     * Force the DiffusionGemma native channel protocol on/off for
     * OpenAI-compatible backends (skip_special_tokens:false + client-side
     * reasoning/tool-call parsing). Auto-detected from the model name when
     * omitted. See gemma-diffusion.ts.
     */
    gemmaNativeProtocol?: boolean;
    /**
     * Extra headers merged for every request from this provider instance.
     * Populated from ProviderConfig.headers for advanced auth / gateway scenarios
     * (Azure api-key style, custom x- headers, etc.).
     */
    extraHeaders?: Record<string, string>;

    /** Extra query parameters appended to request URLs (from ProviderConfig.queryParams). */
    queryParams?: Record<string, string>;

    /** Auth header name override (from ProviderConfig.authHeader). */
    authHeader?: string;

    /** Auth value prefix (from ProviderConfig.authPrefix). */
    authPrefix?: string;

    /**
     * For openai-compatible clients: the sub-path to append (from ProviderConfig.apiBasePath).
     * Defaults to "/v1"; `undefined` keeps that default. Set to "" or "/" to disable
     * the append (when the base URL already contains the full path).
     */
    apiBasePath?: string;
}

// ============================================================================
// Multimodal Content Types
// ============================================================================

export interface LLMTextContent {
    type: 'text';
    text: string;
}

export interface LLMImageContent {
    type: 'image_url';
    image_url: {
        url: string;
        detail?: 'auto' | 'low' | 'high';
    };
}

export interface LLMAudioContent {
    type: 'audio';
    audio: {
        /** Raw base64-encoded audio data */
        data: string;
        /** MIME type (e.g. 'audio/ogg', 'audio/wav', 'audio/mp3') */
        mimeType: string;
    };
}

export type LLMContentPart = LLMTextContent | LLMImageContent | LLMAudioContent;
export type LLMMessageContent = string | LLMContentPart[];

// ============================================================================
// Chat Message Types
// ============================================================================

export interface LLMChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: LLMMessageContent;
    tool_call_id?: string;
    tool_calls?: LLMToolCall[];
}

// ============================================================================
// Tool Types
// ============================================================================

export interface LLMToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
    /**
     * Gemini 3.x thought signature — encrypted reasoning context.
     * Must be echoed back exactly when sending conversation history
     * during multi-turn function calling. Mandatory for Gemini 3,
     * optional for Gemini 2.5, ignored by other providers.
     */
    thoughtSignature?: string;
}

export interface LLMFunction {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
    };
}

export interface LLMToolDefinition {
    type: 'function';
    function: LLMFunction;
}

export interface ToolExecutionResult {
    tool_call_id: string;
    output: unknown;
    error?: string;
    duration?: number;
}

export type ToolHandler = (args: unknown) => Promise<unknown> | unknown;

export interface ToolRegistryEntry {
    definition: LLMFunction;
    handler: ToolHandler;
}

export interface ToolRegistry {
    [toolName: string]: ToolRegistryEntry;
}

// ============================================================================
// Chat Options (per-call overrides)
// ============================================================================

/**
 * Response format for structured output.
 * 
 * For json_schema mode, use: { type: 'json_schema', json_schema: { name, schema, strict } }
 * For json_object mode (legacy), use: { type: 'json_object' }
 */
export interface ResponseFormat {
    /** Response format type */
    type: 'json_object' | 'json_schema';
    /** JSON Schema definition (required for json_schema type) */
    json_schema?: {
        /** Name of the schema (for LLM guidance) */
        name: string;
        /** Schema description (optional, for LLM guidance) */
        description?: string;
        /** The JSON Schema */
        schema: Record<string, unknown>;
        /** Enable strict mode (required for reliable structured output) */
        strict?: boolean;
    };
}

/**
 * Output options for structured output in chat responses.
 * 
 * When provided, the response will include a `structured` property with
 * the validated, typed result. This is the recommended way to request
 * structured output via the chat() method.
 * 
 * @example
 * ```typescript
 * const UserSchema = z.object({
 *   name: z.string(),
 *   age: z.number(),
 * });
 * 
 * const response = await model.chat(messages, {
 *   output: { schema: UserSchema },
 * });
 * 
 * // response.structured is typed as { name: string, age: number }
 * console.log(response.structured?.name);
 * ```
 */
export interface OutputOptions<T = unknown> {
    /**
     * Schema configuration for structured output.
     * Use `fromZod()` from `universal-llm-client/zod` to create from a Zod schema,
     * or provide a raw SchemaConfig with jsonSchema + optional validate function.
     */
    schema?: import('./structured-output.js').SchemaConfig<T>;
    
    /**
     * Raw JSON Schema for structured output.
     * Alternative to `schema` when you have a pre-defined schema.
     */
    jsonSchema?: import('./structured-output.js').JSONSchema;
    
    /**
     * Optional name for the schema.
     * Used by providers like OpenAI for better LLM guidance.
     */
    name?: string;
    
    /**
     * Optional description for the schema.
     * Used by providers like OpenAI for better LLM guidance.
     */
    description?: string;

    /**
     * Whether to use strict mode for schema validation (OpenAI only).
     * When true, OpenAI enforces the schema exactly (no additional properties,
     * limited schema subset). Defaults to `true`.
     */
    strict?: boolean;
}

export interface ChatOptions {
    /** Override temperature */
    temperature?: number;
    /** Max tokens to generate */
    maxTokens?: number;
    /**
     * Enable/disable/level model thinking for this request, overriding the
     * model-level `thinking` config. `true`/`false` or a level
     * ('minimal' | 'low' | 'medium' | 'high'). Mapped per provider: Gemini
     * `thinkingLevel`/`thinkingBudget`, OpenAI `reasoning_effort`, vLLM
     * `enable_thinking`, Anthropic `budget_tokens`, Ollama `think`.
     */
    thinking?: boolean | ThinkingLevel;
    /** Tool definitions (auto-populated from registry if not set) */
    tools?: LLMToolDefinition[];
    /** Tool choice mode */
    toolChoice?: 'none' | 'auto' | 'required';
    /** Additional provider-specific parameters */
    parameters?: Record<string, unknown>;
    /** Abort signal for cancellation (forwarded to HTTP layer) */
    signal?: AbortSignal;
    /** Enable/disable tool execution for chatWithTools */
    executeTools?: boolean;
    /**
     * Enable provider-side prompt caching when supported.
     * - Anthropic: Adds cache_control: { type: 'ephemeral' } to the system prompt block (most common high-impact pattern).
     * - Other providers: May be passed through via parameters/headers or ignored; consult provider docs.
     */
    enablePromptCaching?: boolean;
    /** Maximum tool execution rounds (default: 10) */
    maxIterations?: number;
    /**
     * Stream decoder selection. Accepts:
     * - A built-in type name: 'passthrough' | 'standard-chat' | 'interleaved-reasoning'
     * - A custom type name registered via `registerDecoder()`
     * - A pre-built `StreamDecoder` instance for full control
     */
    decoder?: import('./stream-decoder.js').DecoderType | string | import('./stream-decoder.js').StreamDecoder;
    
    // ========================================================================
    // Structured Output Options
    // ========================================================================
    
    /**
     * Structured output options for chat responses.
     * When provided, the response will include a `structured` property
     * with the validated result.
     * 
     * **Note**: `output` and `tools` cannot be used together.
     * If both are provided, an error will be thrown.
     * 
     * @example
     * ```typescript
     * const response = await model.chat(messages, {
     *   output: { schema: UserSchema },
     * });
     * console.log(response.structured);
     * ```
     */
    output?: OutputOptions;
    
    /**
     * Schema configuration for structured output.
     * When provided, the response is validated against this schema.
     * 
     * @deprecated Use `output.schema` or `generateStructured()` instead.
     */
    schema?: import('./structured-output.js').SchemaConfig<unknown>;
    
    /**
     * Raw JSON Schema for structured output.
     * Alternative to `schema` when you have a pre-defined schema.
     * 
     * @deprecated Use `output.jsonSchema` or `generateStructured()` instead.
     */
    jsonSchema?: import('./structured-output.js').JSONSchema;
    
    /**
     * Name for the schema (optional, used for LLM guidance).
     * Required by some providers (e.g., OpenAI strict mode).
     * 
     * @deprecated Use `output.name` or `generateStructured()` instead.
     */
    schemaName?: string;
    
    /**
     * Description for the schema (optional, used for LLM guidance).
     * 
     * @deprecated Use `output.description` or `generateStructured()` instead.
     */
    schemaDescription?: string;
    
    /**
     * Response format for structured output (legacy json_object mode).
     * For new code, prefer `output` or `generateStructured()`.
     * 
     * Use { type: 'json_object' } for legacy JSON mode without schema validation.
     */
    responseFormat?: ResponseFormat;

    // ========================================================================
    // Inference Tier Selection
    // ========================================================================

    /** Inference tier selection (provider-specific; Google supports 'flex' and 'priority').
     *  - 'flex': 50% cost reduction, best-effort, higher latency (background tasks)
     *  - 'priority': Premium pricing, lowest latency, highest reliability (interactive)
     *  - 'standard': Default behavior (omitted from request) */
    serviceTier?: 'flex' | 'priority' | 'standard';
}

// ============================================================================
// Token Usage
// ============================================================================

export interface TokenUsageInfo {
    inputTokens: number;
    /**
     * Visible output tokens (the streamed `text` content). For providers
     * that bill thinking separately (Google Gemini), this excludes the
     * reasoning trace — see `reasoningTokens`.
     */
    outputTokens: number;
    totalTokens: number;
    cachedTokens?: number;
    /**
     * Server-side reasoning/thinking tokens that were generated but not
     * yielded as visible text. Currently populated by the Google provider
     * from `usageMetadata.thoughtsTokenCount` for thinking-enabled models.
     * Other providers may roll thinking into `outputTokens` (Ollama) or
     * stream it as `thinking` events (the universal client surfaces these
     * via `DecodedEvent { type: 'thinking' }`); consult the provider.
     */
    reasoningTokens?: number;
    /**
     * Total request duration in milliseconds. Server-measured where the
     * provider reports it (Ollama `total_duration`); otherwise client-measured
     * wall-clock (OpenAI-compatible / vLLM return no timing in `usage`).
     */
    durationMs?: number;
    /**
     * Decode throughput in output tokens/second. Server-precise for Ollama
     * (`eval_count / eval_duration`); derived from `outputTokens / durationMs`
     * for providers without server-side timing (OpenAI-compatible / vLLM).
     */
    tokensPerSecond?: number;
}

// ============================================================================
// Response Types
// ============================================================================

export interface LLMChatResponse<T = unknown> {
    message: LLMChatMessage;
    /** Provider finish reason when available (e.g. Ollama done_reason, Google finishReason) */
    finishReason?: string;
    /** Reasoning/thinking content from the model (if supported) */
    reasoning?: string;
    /** Token usage info */
    usage?: TokenUsageInfo;
    /** Tool execution trace (populated by chatWithTools) */
    toolExecutions?: ToolExecutionResult[];
    /** Which provider served this response */
    provider?: string;
    /**
     * Validated structured output when `output` parameter is provided to chat().
     * This is the same type as inferred from the schema provided in `output.schema`.
     * 
     * Undefined when:
     * - No `output` parameter was provided
     * - Structured output validation failed (throws StructuredOutputError instead)
     * 
     * @example
     * ```typescript
     * const response = await model.chat(messages, {
     *   output: { schema: UserSchema },
     * });
     * if (response.structured) {
     *   console.log(response.structured.name); // Fully typed!
     * }
     * ```
     */
    structured?: T;
    /** Which inference tier actually served this response (from provider response headers, e.g. x-gemini-service-tier) */
    serviceTier?: 'flex' | 'priority' | 'standard';
}

// ============================================================================
// Provider Response Types (internal)
// ============================================================================

export interface OllamaResponse {
    model: string;
    created_at: string;
    message: {
        role: string;
        content: string;
        thinking?: string;
        tool_calls?: LLMToolCall[];
    };
    done: boolean;
    done_reason?: string;
    /** Total request time in nanoseconds. */
    total_duration?: number;
    /** Model load time in nanoseconds. */
    load_duration?: number;
    prompt_eval_count?: number;
    eval_count?: number;
    /** Prompt evaluation time in nanoseconds. */
    prompt_eval_duration?: number;
    /** Generation time in nanoseconds. */
    eval_duration?: number;
}

export interface OpenAIResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: string;
            content: string | null;
            /**
             * Chain-of-thought from reasoning models exposed via a dedicated
             * field (vLLM `--reasoning-parser`, DeepSeek-R1, etc.). vLLM uses
             * `reasoning_content`; some gateways use `reasoning`.
             */
            reasoning?: string;
            reasoning_content?: string;
            tool_calls?: LLMToolCall[];
        };
        finish_reason: string;
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
            audio_tokens?: number;
        };
    };
}

export interface OllamaModelInfo {
    name: string;
    size: number;
    digest: string;
    details: {
        format: string;
        family: string;
        families: string[];
        parameter_size: string;
        quantization_level: string;
    };
    modified_at: string;
}

export interface OpenAIModelInfo {
    id: string;
    object: string;
    created: number;
    owned_by: string;
}

// ============================================================================
// Google API Types
// ============================================================================

export interface GooglePart {
    text?: string;
    functionCall?: {
        name?: string;
        args?: Record<string, unknown>;
    };
    functionResponse?: {
        name: string;
        response: Record<string, unknown>;
    };
    inlineData?: {
        mimeType: string;
        data: string;
    };
    /** True when this part is a reasoning summary (requires `includeThoughts`). */
    thought?: boolean;
    /** Gemini 3.x thought signature — must be echoed back on functionCall parts */
    thoughtSignature?: string;
}

export interface GoogleContent {
    role: 'user' | 'model' | 'function';
    parts: GooglePart[];
}

export interface GoogleGenerationConfig {
    responseMimeType?: string;
    temperature?: number;
    maxOutputTokens?: number;
    topK?: number;
    topP?: number;
    thinkingConfig?: {
        thinkingBudget?: number;
    };
}

export interface GoogleFunctionDeclaration {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export interface GoogleToolConfig {
    functionCallingConfig?: {
        mode: 'AUTO' | 'ANY' | 'NONE';
        allowedFunctionNames?: string[];
    };
}

export interface GoogleRequest {
    contents: GoogleContent[];
    generationConfig?: GoogleGenerationConfig;
    systemInstruction?: { parts: Array<{ text: string }> };
    tools?: Array<{
        functionDeclarations: GoogleFunctionDeclaration[];
    }>;
    toolConfig?: GoogleToolConfig;
    /** Inference tier: FLEX (50% off, best-effort) or PRIORITY (premium, highest reliability) */
    service_tier?: 'FLEX' | 'PRIORITY' | 'STANDARD';
}

export interface GoogleCandidate {
    content: {
        parts: GooglePart[];
        role: string;
    };
    finishReason?: string;
    index: number;
}

export interface GoogleResponse {
    candidates: GoogleCandidate[];
    usageMetadata?: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
        cachedContentTokenCount?: number;
        /**
         * Server-side reasoning tokens emitted by Gemini thinking models
         * (e.g. 2.5 Pro / 3.x Pro). Counted toward billing as output but
         * not included in `candidatesTokenCount` and not streamed as text.
         */
        thoughtsTokenCount?: number;
    };
}

// ============================================================================
// Deep Research (Gemini interactions API)
// ============================================================================

/** Options for an agentic Deep Research interaction (Gemini-only). */
export interface DeepResearchOptions {
    /** Research agent id (default 'deep-research-preview-04-2026'). */
    agent?: string;
    /** Tools the agent may use, e.g. 'google_search', 'url_context', 'code_execution'. */
    tools?: string[];
    /** Emit intermediate reasoning ('auto') or not ('none'). Default 'auto'. */
    thinkingSummaries?: 'auto' | 'none';
    /** Continue a prior interaction (follow-up question). */
    previousInteractionId?: string;
    /** Poll interval in ms while awaiting completion (default 5000). */
    pollIntervalMs?: number;
    /** Overall timeout in ms before giving up the poll loop (default 600000). */
    timeoutMs?: number;
    /** Abort signal forwarded to every request. */
    signal?: AbortSignal;
}

/** One intermediate step in a Deep Research interaction. */
export interface DeepResearchStep {
    type?: string;
    content?: Array<{ text?: string;[k: string]: unknown }>;
    [k: string]: unknown;
}

/** Terminal (or last-polled) state of a Deep Research interaction. */
export interface DeepResearchResult {
    id: string;
    status: 'in_progress' | 'completed' | 'failed' | string;
    /** Final research report (`output_text`) when completed. */
    report?: string;
    steps?: DeepResearchStep[];
    error?: unknown;
    /** The raw last interaction object from the API. */
    raw?: unknown;
}

/** Streaming Deep Research event (from `step.delta` updates). */
export type DeepResearchEvent =
    | { type: 'thought'; content: string }
    | { type: 'text'; content: string }
    | { type: 'image'; content: unknown }
    | { type: 'status'; status: string };

// ============================================================================
// Helper Functions
// ============================================================================

/** Create a text content part */
export function textContent(text: string): LLMTextContent {
    return { type: 'text', text };
}

/** Create an image content part from base64 data or URL */
export function imageContent(
    base64DataOrUrl: string,
    mimeType: string = 'image/jpeg',
    detail?: 'auto' | 'low' | 'high',
): LLMImageContent {
    const url = base64DataOrUrl.startsWith('data:') || base64DataOrUrl.startsWith('http')
        ? base64DataOrUrl
        : `data:${mimeType};base64,${base64DataOrUrl}`;
    return {
        type: 'image_url',
        image_url: { url, detail },
    };
}

/** Create a multimodal user message with text and images */
export function multimodalMessage(
    text: string,
    images: string[],
    mimeType: string = 'image/jpeg',
): LLMChatMessage {
    const content: LLMContentPart[] = [
        textContent(text),
        ...images.map(img => imageContent(img, mimeType)),
    ];
    return { role: 'user', content };
}

/** Extract text content from a message content value */
export function extractTextContent(content: LLMMessageContent): string {
    if (typeof content === 'string') return content;
    return content
        .filter((part): part is LLMTextContent => part.type === 'text')
        .map(part => part.text)
        .join('');
}

/** Check if message content contains images */
export function hasImages(content: LLMMessageContent): boolean {
    if (typeof content === 'string') return false;
    return content.some(part => part.type === 'image_url');
}

/** Create an audio content part from raw base64 data */
export function audioContent(base64Data: string, mimeType: string): LLMAudioContent {
    return {
        type: 'audio',
        audio: { data: base64Data, mimeType },
    };
}

/** Check if message content contains audio */
export function hasAudio(content: LLMMessageContent): boolean {
    if (typeof content === 'string') return false;
    return content.some(part => part.type === 'audio');
}
