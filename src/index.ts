/**
 * Universal LLM Client v3
 *
 * A universal LLM client with transparent provider failover,
 * streaming tool execution, pluggable reasoning, and native observability.
 *
 * @module @akaito/universal-llm-client
 */

// ============================================================================
// Public API — The Universal Client
// ============================================================================

export { AIModel } from './ai-model.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export {
    // Enums
    AIModelApiType,
    AIModelType,
    // Config
    type AIModelConfig,
    type ProviderConfig,
    type LLMClientOptions,
    // Messages
    type LLMChatMessage,
    type LLMMessageContent,
    type LLMContentPart,
    type LLMTextContent,
    type LLMImageContent,
    // Responses
    type LLMChatResponse,
    type TokenUsageInfo,
    // Tools
    type LLMToolCall,
    type LLMToolDefinition,
    type LLMFunction,
    type ToolHandler,
    type ToolExecutionResult,
    type ToolRegistry,
    type ToolRegistryEntry,
    // Options
    type ChatOptions,
    // Model info
    type ModelMetadata,
    // Helpers
    textContent,
    imageContent,
    multimodalMessage,
    extractTextContent,
    hasImages,
} from './interfaces.js';

// ============================================================================
// Observability
// ============================================================================

export {
    type Auditor,
    type AuditEvent,
    type AuditEventType,
    NoopAuditor,
    ConsoleAuditor,
    BufferedAuditor,
} from './auditor.js';

// ============================================================================
// Stream Decoding
// ============================================================================

export {
    type StreamDecoder,
    type DecodedEvent,
    type DecoderCallback,
    type DecoderType,
    type DecoderOptions,
    createDecoder,
    PassthroughDecoder,
    StandardChatDecoder,
    InterleavedReasoningDecoder,
} from './stream-decoder.js';

// ============================================================================
// Tool Utilities
// ============================================================================

export {
    ToolBuilder,
    ToolExecutor,
    createTimeTool,
    createRandomNumberTool,
} from './tools.js';

// ============================================================================
// HTTP Utilities (for advanced use cases)
// ============================================================================

export {
    httpRequest,
    httpStream,
    parseNDJSON,
    parseSSE,
    buildHeaders,
    type HttpRequestOptions,
    type HttpResponse,
} from './http.js';

// ============================================================================
// MCP Integration
// ============================================================================

export {
    MCPToolBridge,
    type MCPBridgeConfig,
    type MCPServerConfig,
    type MCPTool,
} from './mcp.js';
