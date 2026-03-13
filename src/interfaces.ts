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
    type: AIModelApiType | 'ollama' | 'openai' | 'google' | 'vertex' | 'llamacpp';
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
}

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
    /** Enable thinking/reasoning mode */
    thinking?: boolean;
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
    /** Enable thinking/reasoning mode */
    thinking?: boolean;
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

export type LLMContentPart = LLMTextContent | LLMImageContent;
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
     * Zod schema for structured output.
     * Use this for type-safe validation with automatic type inference.
     */
    schema?: import('zod').ZodType<T>;
    
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
}

export interface ChatOptions {
    /** Override temperature */
    temperature?: number;
    /** Max tokens to generate */
    maxTokens?: number;
    /** Tool definitions (auto-populated from registry if not set) */
    tools?: LLMToolDefinition[];
    /** Tool choice mode */
    toolChoice?: 'none' | 'auto' | 'required';
    /** Additional provider-specific parameters */
    parameters?: Record<string, unknown>;
    /** Enable/disable tool execution for chatWithTools */
    executeTools?: boolean;
    /** Maximum tool execution rounds (default: 10) */
    maxIterations?: number;
    /** Stream decoder type */
    decoder?: import('./stream-decoder.js').DecoderType;
    
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
     * Zod schema for structured output.
     * When provided, the response is validated against this schema.
     * Structured output and tools cannot be used together.
     */
    schema?: import('zod').ZodType<unknown>;
    
    /**
     * Raw JSON Schema for structured output.
     * Alternative to `schema` when you have a pre-defined schema.
     */
    jsonSchema?: import('./structured-output.js').JSONSchema;
    
    /**
     * Name for the schema (optional, used for LLM guidance).
     * Required by some providers (e.g., OpenAI strict mode).
     */
    schemaName?: string;
    
    /**
     * Description for the schema (optional, used for LLM guidance).
     */
    schemaDescription?: string;
    
    /**
     * Response format for structured output (legacy json_object mode).
     * For new code, prefer `schema` or `jsonSchema` options.
     * 
     * Use { type: 'json_object' } for legacy JSON mode without schema validation.
     */
    responseFormat?: ResponseFormat;
}

// ============================================================================
// Token Usage
// ============================================================================

export interface TokenUsageInfo {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

// ============================================================================
// Response Types
// ============================================================================

export interface LLMChatResponse<T = unknown> {
    message: LLMChatMessage;
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
    prompt_eval_count?: number;
    eval_count?: number;
    prompt_eval_duration?: number;
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
            tool_calls?: LLMToolCall[];
        };
        finish_reason: string;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
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
        name: string;
        args: Record<string, unknown>;
    };
    functionResponse?: {
        name: string;
        response: Record<string, unknown>;
    };
    inlineData?: {
        mimeType: string;
        data: string;
    };
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
    };
}

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
