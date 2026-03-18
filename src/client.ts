/**
 * Universal LLM Client v3 — Base LLM Client
 *
 * Abstract base class for all LLM providers.
 * Handles tool registration, execution, and the autonomous
 * multi-turn tool execution loop.
 */

import type {
    LLMClientOptions,
    LLMChatMessage,
    LLMChatResponse,
    LLMToolDefinition,
    LLMToolCall,
    LLMFunction,
    ToolRegistry,
    ToolHandler,
    ToolExecutionResult,
    ChatOptions,
    ModelMetadata,
} from './interfaces.js';
import {
    StructuredOutputError,
    type StructuredOutputOptions,
    type SchemaConfig,
} from './structured-output.js';
import type { DecodedEvent } from './stream-decoder.js';
import type { Auditor } from './auditor.js';
import { NoopAuditor } from './auditor.js';

// ============================================================================
// Abstract Base Client
// ============================================================================

export abstract class BaseLLMClient {
    protected options: LLMClientOptions;
    protected toolRegistry: ToolRegistry = {};
    protected auditor: Auditor;
    protected debug: boolean;

    constructor(options: LLMClientOptions, auditor?: Auditor) {
        this.options = options;
        this.auditor = auditor ?? new NoopAuditor();
        this.debug = options.debug ?? false;
    }

    // ========================================================================
    // Abstract Methods (implemented by providers)
    // ========================================================================

    /** Send a chat request and get a response */
    abstract chat(
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): Promise<LLMChatResponse>;

    /** Stream a chat response as decoded events */
    abstract chatStream(
        messages: LLMChatMessage[],
        options?: ChatOptions,
    ): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>;

    /** Get available models */
    abstract getModels(): Promise<string[]>;

    /** Generate embeddings for text */
    abstract embed(text: string): Promise<number[]>;

    /** Generate embeddings for multiple texts */
    async embedArray(texts: string[]): Promise<number[][]> {
        return Promise.all(texts.map(t => this.embed(t)));
    }

    /**
     * Get metadata about a model (context length, architecture, etc.)
     * Override per-provider for accurate data.
     */
    async getModelInfo(_modelName?: string): Promise<ModelMetadata> {
        return { contextLength: 8192 }; // Conservative default
    }

    // ========================================================================
    // Tool Registration
    // ========================================================================

    /**
     * Sanitize tool name for LLM compatibility.
     * LLM APIs require function names matching [a-zA-Z0-9_-].
     * Module-prefixed names like "@core/computer:list_windows" are cleaned.
     */
    private sanitizeToolName(name: string): string {
        return name
            .replace(/^@[^:]+:/, '')           // Strip module prefix
            .replace(/[^a-zA-Z0-9_-]/g, '_')   // Replace illegal chars
            .replace(/_+/g, '_')               // Collapse
            .replace(/^_|_$/g, '');            // Trim
    }

    /** Register a tool/function callable by the model */
    registerTool(
        name: string,
        description: string,
        parameters: LLMFunction['parameters'],
        handler: ToolHandler,
    ): void {
        const safeName = this.sanitizeToolName(name);
        this.toolRegistry[name] = {
            definition: { name: safeName, description, parameters },
            handler,
        };
        // Index by sanitized name for reverse lookup
        if (safeName !== name && !this.toolRegistry[safeName]) {
            this.toolRegistry[safeName] = this.toolRegistry[name]!;
        }
        this.debugLog(`Registered tool: ${name} (LLM name: ${safeName})`);
    }

    /** Register multiple tools at once */
    registerTools(
        tools: Array<{
            name: string;
            description: string;
            parameters: LLMFunction['parameters'];
            handler: ToolHandler;
        }>,
    ): void {
        for (const tool of tools) {
            this.registerTool(tool.name, tool.description, tool.parameters, tool.handler);
        }
    }

    /** Get all registered tool definitions (deduplicated by sanitized name) */
    getToolDefinitions(): LLMToolDefinition[] {
        const seen = new Set<string>();
        const defs: LLMToolDefinition[] = [];
        for (const { definition } of Object.values(this.toolRegistry)) {
            if (seen.has(definition.name)) continue;
            seen.add(definition.name);
            defs.push({ type: 'function' as const, function: definition });
        }
        return defs;
    }

    // ========================================================================
    // Tool Execution
    // ========================================================================

    /** Execute a single tool call with fuzzy name matching */
    async executeTool(toolCall: LLMToolCall): Promise<ToolExecutionResult> {
        const toolName = toolCall.function.name;
        const start = Date.now();
        let tool = this.toolRegistry[toolName];

        // Fuzzy lookup: try suffix match (LLM stripped module prefix)
        if (!tool) {
            const entries = Object.entries(this.toolRegistry);
            const bySuffix = entries.find(([k]) => k.endsWith(`:${toolName}`));
            if (bySuffix) {
                tool = bySuffix[1];
                this.debugLog(`Fuzzy tool match: "${toolName}" → "${bySuffix[0]}"`);
            }

            // Try prefix match: if only one tool in that module, use it
            if (!tool) {
                const byPrefix = entries.filter(([k]) => k.startsWith(`${toolName}:`));
                if (byPrefix.length === 1) {
                    tool = byPrefix[0]![1];
                    this.debugLog(`Fuzzy tool match (single): "${toolName}" → "${byPrefix[0]![0]}"`);
                }
            }
        }

        if (!tool) {
            const result: ToolExecutionResult = {
                tool_call_id: toolCall.id,
                output: null,
                error: `Unknown tool: ${toolName}`,
                duration: Date.now() - start,
            };
            this.auditor.record({
                timestamp: Date.now(),
                type: 'tool_result',
                toolExecution: result,
                error: result.error,
            });
            return result;
        }

        this.auditor.record({
            timestamp: Date.now(),
            type: 'tool_call',
            metadata: { toolName, arguments: toolCall.function.arguments },
        });

        try {
            const args = JSON.parse(toolCall.function.arguments);
            const output = await tool.handler(args);
            const result: ToolExecutionResult = {
                tool_call_id: toolCall.id,
                output,
                duration: Date.now() - start,
            };
            this.auditor.record({
                timestamp: Date.now(),
                type: 'tool_result',
                toolExecution: result,
            });
            return result;
        } catch (error) {
            const result: ToolExecutionResult = {
                tool_call_id: toolCall.id,
                output: null,
                error: error instanceof Error ? error.message : String(error),
                duration: Date.now() - start,
            };
            this.auditor.record({
                timestamp: Date.now(),
                type: 'tool_result',
                toolExecution: result,
                error: result.error,
            });
            return result;
        }
    }

    /** Execute multiple tool calls in parallel */
    async executeTools(toolCalls: LLMToolCall[]): Promise<ToolExecutionResult[]> {
        return Promise.all(toolCalls.map(tc => this.executeTool(tc)));
    }

    // ========================================================================
    // Chat with Tools (multi-turn autonomous loop)
    // ========================================================================

    /**
     * Chat with automatic tool execution.
     * Continues until the model stops calling tools or max iterations reached.
     * Returns the complete execution trace in `toolExecutions`.
     */
    async chatWithTools(
        messages: LLMChatMessage[],
        options?: ChatOptions & { maxIterations?: number },
    ): Promise<LLMChatResponse> {
        const maxIterations = options?.maxIterations ?? 10;
        const conversationMessages = [...messages];
        const allToolExecutions: ToolExecutionResult[] = [];
        let iterations = 0;

        while (iterations < maxIterations) {
            const response = await this.chat(conversationMessages, {
                ...options,
                tools: this.getToolDefinitions(),
            });

            // If no tool calls, return with full trace
            if (!response.message.tool_calls?.length) {
                return {
                    ...response,
                    toolExecutions: allToolExecutions.length > 0 ? allToolExecutions : undefined,
                };
            }

            // Add assistant message with tool calls
            conversationMessages.push(response.message);

            // Execute tools in parallel
            const toolResults = await this.executeTools(response.message.tool_calls);
            allToolExecutions.push(...toolResults);

            // Add tool results as messages
            for (const result of toolResults) {
                conversationMessages.push({
                    role: 'tool',
                    content: typeof result.output === 'string'
                        ? result.output
                        : JSON.stringify(result.output),
                    tool_call_id: result.tool_call_id,
                });
            }

            iterations++;
        }

        // Max iterations — final call without tools
        const finalResponse = await this.chat(conversationMessages);
        return {
            ...finalResponse,
            toolExecutions: allToolExecutions,
        };
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /** Set the model name at runtime */
    setModel(modelName: string): void {
        this.options.model = modelName;
        this.debugLog(`Model switched to: ${modelName}`);
    }

    /** Get the current model name */
    get model(): string {
        return this.options.model;
    }

    /** Get the base URL */
    get url(): string {
        return this.options.url;
    }

    /** Set the auditor instance */
    setAuditor(auditor: Auditor): void {
        this.auditor = auditor;
    }

    protected debugLog(message: string, data?: unknown): void {
        if (this.debug) {
            console.log(`[LLM:${this.options.model}] ${message}`, data ?? '');
        }
    }

    /**
     * Generate a unique ID for tool calls when the provider doesn't provide one.
     */
    protected generateToolCallId(): string {
        return `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    // ========================================================================
    // Structured Output Helpers (shared across all providers)
    // ========================================================================

    /**
     * Extract schema options from ChatOptions.
     * Returns null if no schema is provided.
     * Returns a SchemaConfig if a schema was found.
     */
    protected extractSchemaOptions(options?: ChatOptions): (StructuredOutputOptions<unknown> & { schemaConfig: SchemaConfig<unknown> }) | null {
        if (!options) return null;

        if (options.schema) {
            return {
                schemaConfig: options.schema,
                name: options.schemaName,
                description: options.schemaDescription,
            };
        }

        if (options.jsonSchema) {
            // Raw JSON Schema without validation
            const config: SchemaConfig<unknown> = {
                jsonSchema: options.jsonSchema,
            };
            return {
                schemaConfig: config,
                name: options.schemaName,
                description: options.schemaDescription,
            };
        }

        return null;
    }

    /**
     * Validate structured response using a SchemaConfig.
     * Throws StructuredOutputError on failure.
     */
    protected validateStructuredResponse(content: string, config: SchemaConfig<unknown>): void {
        if (!content) {
            throw new StructuredOutputError(
                'Empty response from LLM',
                { rawOutput: content },
            );
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            const syntaxError = error instanceof SyntaxError
                ? error
                : new SyntaxError(String(error));
            throw new StructuredOutputError(
                `Failed to parse JSON: ${syntaxError.message}`,
                { rawOutput: content, cause: syntaxError },
            );
        }

        if (config.validate) {
            try {
                config.validate(parsed);
            } catch (error) {
                const validationError = error instanceof Error ? error : new Error(String(error));
                throw new StructuredOutputError(
                    `Validation failed: ${validationError.message}`,
                    { rawOutput: content, cause: validationError },
                );
            }
        }
    }
}
