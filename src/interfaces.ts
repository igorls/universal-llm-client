export enum AIModelType {
    Chat = 'chat',
    Embedding = 'embedding',
}

export enum AIModelApiType {
    Ollama = 'ollama',
    OpenAI = 'openai',
    Google = 'google',
    LlamaCpp = 'llamacpp',
}

export interface AIModelOptions {
    model: string;
    modelType?: AIModelType;
    url: string;
    hostname?: string;
    apiType: AIModelApiType
    defaultParameters?: Record<string, any>;
    thinking?: boolean;
    // Request timeout
    timeout?: number;
    // Number of retries for failed requests
    retries?: number;
    apiKey?: string; // For OpenAI-compatible APIs that require authentication
    debug?: boolean; // Enable verbose debugging logs
    // Undici Agent configuration (useful for testing)
    agentOptions?: {
        connections?: number;
        pipelining?: number;
        keepAliveTimeout?: number;
        keepAliveMaxTimeout?: number;
        headersTimeout?: number;
        bodyTimeout?: number;
        connectTimeout?: number;
    };
}

export interface LLMChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_call_id?: string; // For tool response messages
    tool_calls?: LLMToolCall[]; // For assistant messages with tool calls
}

export interface LLMToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string; // JSON string
    };
}

export interface LLMFunction {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
}

export interface LLMToolDefinition {
    type: 'function';
    function: LLMFunction;
}

export interface LLMTool {
    name: string;
    description: string;
    parameters?: Record<string, any>;
}

export interface LLMChatRequest {
    messages: LLMChatMessage[];
    parameters?: Record<string, any>;
    tools?: LLMToolDefinition[];
    tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
}

// Tool execution result
export interface ToolExecutionResult {
    tool_call_id: string;
    output: any;
    error?: string;
}

// Tool handler type
export type ToolHandler = (args: any) => Promise<any> | any;

// Tool registry
export interface ToolRegistry {
    [toolName: string]: {
        definition: LLMFunction;
        handler: ToolHandler;
    };
}

export interface OllamaResponse {
    model: string;
    created_at: string;
    message: {
        role: string;
        content: string;
        tool_calls?: LLMToolCall[];
    };
    done: boolean;
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

export interface GooglePart {
    text?: string;
    functionCall?: {
        name: string;
        args: Record<string, any>;
    };
    functionResponse?: {
        name: string;
        response: Record<string, any>;
    };
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
}

export interface GoogleFunctionDeclaration {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, any>;
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

export interface TokenUsageInfo {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

export interface LLMChatResponse {
    message: LLMChatMessage;
    usage?: TokenUsageInfo;
}
