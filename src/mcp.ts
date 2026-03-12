/**
 * Universal LLM Client v3 — MCP Integration
 *
 * Native MCP tool discovery and execution bridge.
 * Uses @modelcontextprotocol/sdk as a peer dependency.
 *
 * Supports:
 *  - Stdio transport (Node/Bun/Deno — spawns server processes)
 *  - Streamable HTTP transport (all runtimes including browsers)
 *
 * Usage:
 *   const mcp = new MCPToolBridge({
 *       servers: {
 *           filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', './'] },
 *           weather: { url: 'https://mcp.example.com/weather' },
 *       }
 *   });
 *   await mcp.connect();
 *   await mcp.registerTools(model); // or registerTools(model)
 *   // ... use model.chatWithTools() — MCP tools are now callable
 *   await mcp.disconnect();
 */

import type { AIModel } from './ai-model.js';
import type { LLMFunction, ToolHandler } from './interfaces.js';
import type { Auditor } from './auditor.js';
import { NoopAuditor } from './auditor.js';

// ============================================================================
// MCP Types
// ============================================================================

export interface MCPServerConfig {
    /** Stdio transport: command to spawn the MCP server */
    command?: string;
    /** Stdio transport: arguments for the command */
    args?: string[];
    /** Stdio transport: environment variables for the spawned process */
    env?: Record<string, string>;
    /** HTTP transport: URL of the remote MCP server */
    url?: string;
    /** HTTP transport: additional headers for requests */
    headers?: Record<string, string>;
}

export interface MCPBridgeConfig {
    /** Named MCP server configurations */
    servers: Record<string, MCPServerConfig>;
    /** Auditor for observability */
    auditor?: Auditor;
}

export interface MCPTool {
    /** Server this tool came from */
    serverName: string;
    /** Tool name (as reported by the server) */
    name: string;
    /** Full qualified name (serverName:toolName) */
    qualifiedName: string;
    /** Tool description */
    description: string;
    /** JSON Schema for tool input */
    inputSchema: Record<string, unknown>;
}

// ============================================================================
// Internal: SDK types (to avoid hard dependency)
// ============================================================================

interface MCPClientLike {
    connect(transport: unknown): Promise<void>;
    close(): Promise<void>;
    listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
    callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{ content: Array<{ type: string; text?: string }> }>;
}

// ============================================================================
// MCPToolBridge
// ============================================================================

export class MCPToolBridge {
    private config: MCPBridgeConfig;
    private auditor: Auditor;
    private clients: Map<string, MCPClientLike> = new Map();
    private transports: Map<string, unknown> = new Map();
    private discoveredTools: MCPTool[] = [];
    private connected = false;

    constructor(config: MCPBridgeConfig) {
        this.config = config;
        this.auditor = config.auditor ?? new NoopAuditor();
    }

    // ========================================================================
    // Connection Lifecycle
    // ========================================================================

    /**
     * Connect to all configured MCP servers and discover their tools.
     * Requires @modelcontextprotocol/sdk to be installed.
     */
    async connect(): Promise<void> {
        if (this.connected) return;

        // Dynamic import of MCP SDK (peer dependency)
        let sdk: {
            Client: new (info: { name: string; version: string }, opts?: { capabilities?: Record<string, unknown> }) => MCPClientLike;
            StdioClientTransport?: new (opts: { command: string; args?: string[]; env?: Record<string, string> }) => unknown;
            StreamableHTTPClientTransport?: new (url: URL, opts?: { requestInit?: { headers: Record<string, string> } }) => unknown;
        };

        try {
            // @ts-ignore — peer dependency, may not be installed
            sdk = await import('@modelcontextprotocol/sdk/client/index.js');
        } catch {
            throw new Error(
                'MCP integration requires @modelcontextprotocol/sdk.\n' +
                'Install it: bun add @modelcontextprotocol/sdk'
            );
        }

        const entries = Object.entries(this.config.servers);

        for (const [serverName, serverConfig] of entries) {
            try {
                const client = new sdk.Client(
                    { name: 'universal-llm-client', version: '3.0.0' },
                    { capabilities: {} },
                );

                let transport: unknown;

                if (serverConfig.url) {
                    // HTTP transport (all runtimes)
                    if (!sdk.StreamableHTTPClientTransport) {
                        // Try separate import path
                        // @ts-ignore — peer dependency, may not be installed
                        const httpModule = await import('@modelcontextprotocol/sdk/client/streamableHttp.js').catch(() => null);
                        if (!httpModule?.StreamableHTTPClientTransport) {
                            throw new Error('StreamableHTTPClientTransport not available in this SDK version');
                        }
                        transport = new httpModule.StreamableHTTPClientTransport(
                            new URL(serverConfig.url),
                            serverConfig.headers ? { requestInit: { headers: serverConfig.headers } } : undefined,
                        );
                    } else {
                        transport = new sdk.StreamableHTTPClientTransport(
                            new URL(serverConfig.url),
                            serverConfig.headers ? { requestInit: { headers: serverConfig.headers } } : undefined,
                        );
                    }
                } else if (serverConfig.command) {
                    // Stdio transport (Node/Bun/Deno only)
                    if (!sdk.StdioClientTransport) {
                        // @ts-ignore — peer dependency, may not be installed
                        const stdioModule = await import('@modelcontextprotocol/sdk/client/stdio.js').catch(() => null);
                        if (!stdioModule?.StdioClientTransport) {
                            throw new Error(
                                'Stdio transport not available. This is expected in browser environments.\n' +
                                'Use HTTP transport (url) instead, or run in Node/Bun/Deno.'
                            );
                        }
                        transport = new stdioModule.StdioClientTransport({
                            command: serverConfig.command,
                            args: serverConfig.args,
                            env: serverConfig.env,
                        });
                    } else {
                        transport = new sdk.StdioClientTransport({
                            command: serverConfig.command,
                            args: serverConfig.args,
                            env: serverConfig.env,
                        });
                    }
                } else {
                    throw new Error(`MCP server "${serverName}" must have either "url" or "command" configured`);
                }

                await client.connect(transport);
                this.clients.set(serverName, client);
                this.transports.set(serverName, transport);

                // Discover tools
                const toolList = await client.listTools();
                for (const tool of toolList.tools) {
                    this.discoveredTools.push({
                        serverName,
                        name: tool.name,
                        qualifiedName: `${serverName}:${tool.name}`,
                        description: tool.description ?? '',
                        inputSchema: tool.inputSchema,
                    });
                }

                this.auditor.record({
                    timestamp: Date.now(),
                    type: 'response',
                    metadata: {
                        event: 'mcp_connected',
                        server: serverName,
                        toolCount: toolList.tools.length,
                    },
                });
            } catch (error) {
                this.auditor.record({
                    timestamp: Date.now(),
                    type: 'error',
                    error: error instanceof Error ? error.message : String(error),
                    metadata: { event: 'mcp_connect_failed', server: serverName },
                });
                throw error;
            }
        }

        this.connected = true;
    }

    // ========================================================================
    // Tool Registration
    // ========================================================================

    /**
     * Register all discovered MCP tools with an AIModel instance.
     * Each MCP tool becomes a callable tool that forwards execution
     * to the appropriate MCP server.
     */
    async registerTools(model: AIModel): Promise<void> {
        if (!this.connected) {
            await this.connect();
        }

        const tools = this.discoveredTools.map(mcpTool => ({
            name: mcpTool.qualifiedName,
            description: mcpTool.description,
            parameters: this.convertInputSchema(mcpTool.inputSchema),
            handler: this.createToolHandler(mcpTool),
        }));

        model.registerTools(tools);
    }

    /**
     * Get all discovered MCP tools (for inspection).
     */
    getTools(): ReadonlyArray<MCPTool> {
        return this.discoveredTools;
    }

    // ========================================================================
    // Disconnect
    // ========================================================================

    /**
     * Disconnect from all MCP servers and clean up.
     */
    async disconnect(): Promise<void> {
        for (const [serverName, client] of this.clients) {
            try {
                await client.close();
            } catch (error) {
                this.auditor.record({
                    timestamp: Date.now(),
                    type: 'error',
                    error: error instanceof Error ? error.message : String(error),
                    metadata: { event: 'mcp_disconnect_failed', server: serverName },
                });
            }
        }
        this.clients.clear();
        this.transports.clear();
        this.discoveredTools = [];
        this.connected = false;
    }

    // ========================================================================
    // Internal
    // ========================================================================

    private createToolHandler(mcpTool: MCPTool): ToolHandler {
        return async (args: unknown) => {
            const client = this.clients.get(mcpTool.serverName);
            if (!client) {
                throw new Error(`MCP server "${mcpTool.serverName}" is not connected`);
            }

            const start = Date.now();
            this.auditor.record({
                timestamp: start,
                type: 'tool_call',
                metadata: {
                    event: 'mcp_tool_call',
                    server: mcpTool.serverName,
                    tool: mcpTool.name,
                },
            });

            try {
                const result = await client.callTool({
                    name: mcpTool.name,
                    arguments: args as Record<string, unknown> | undefined,
                });

                // Extract text content from MCP response
                const textParts = result.content
                    .filter(c => c.type === 'text' && c.text)
                    .map(c => c.text);

                const output = textParts.length === 1 ? textParts[0] : textParts.join('\n');

                this.auditor.record({
                    timestamp: Date.now(),
                    type: 'tool_result',
                    metadata: {
                        event: 'mcp_tool_result',
                        server: mcpTool.serverName,
                        tool: mcpTool.name,
                        duration: Date.now() - start,
                    },
                });

                return output;
            } catch (error) {
                this.auditor.record({
                    timestamp: Date.now(),
                    type: 'error',
                    error: error instanceof Error ? error.message : String(error),
                    metadata: {
                        event: 'mcp_tool_error',
                        server: mcpTool.serverName,
                        tool: mcpTool.name,
                    },
                });
                throw error;
            }
        };
    }

    private convertInputSchema(schema: Record<string, unknown>): LLMFunction['parameters'] {
        return {
            type: 'object',
            properties: (schema['properties'] as Record<string, unknown>) ?? {},
            required: schema['required'] as string[] | undefined,
        };
    }
}
