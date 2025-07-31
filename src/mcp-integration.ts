/**
 * MCP (Model Context Protocol) Integration for Universal LLM Client
 * 
 * This module provides integration with MCP servers, allowing the Universal LLM Client
 * to automatically discover and use tools from MCP servers defined in the standard
 * .vscode/mcp.json configuration file.
 * 
 * Based on the MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
 */

import { spawn, ChildProcess } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { ToolBuilder } from './tools.js';
import type { ToolHandler } from './interfaces.js';
import type { AIModel } from './universal-llm-client.js';

// MCP Protocol types based on the TypeScript SDK
interface MCPTool {
    name: string;
    description?: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
}

interface MCPToolResult {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}

interface MCPServer {
    command: string;
    args: string[];
    type: 'stdio';
    env?: Record<string, string>;
}

interface MCPConfig {
    servers: Record<string, MCPServer>;
    inputs?: any[];
}

interface MCPRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: any;
}

interface MCPResponse {
    jsonrpc: '2.0';
    id?: number;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

/**
 * MCP Client that manages connections to MCP servers
 */
export class MCPClient {
    private servers: Map<string, MCPServerConnection> = new Map();
    private requestId = 1;

    /**
     * Load MCP configuration from standard .vscode/mcp.json file
     */
    async loadConfig(configPath?: string): Promise<MCPConfig> {
        const defaultPath = join(process.cwd(), '.vscode', 'mcp.json');
        const path = configPath || defaultPath;
        
        try {
            const content = await readFile(path, 'utf-8');
            // For now, just parse as standard JSON (no comments)
            return JSON.parse(content) as MCPConfig;
        } catch (error) {
            throw new Error(`Failed to load MCP config from ${path}: ${error}`);
        }
    }

    /**
     * Connect to all servers defined in the MCP config
     */
    async connect(config?: MCPConfig): Promise<void> {
        if (!config) {
            config = await this.loadConfig();
        }

        const connectionPromises = Object.entries(config.servers).map(async ([name, serverConfig]) => {
            try {
                const connection = new MCPServerConnection(name, serverConfig);
                await connection.connect();
                this.servers.set(name, connection);
                console.log(`✅ Connected to MCP server: ${name}`);
            } catch (error) {
                console.error(`❌ Failed to connect to MCP server ${name}:`, error);
            }
        });

        await Promise.all(connectionPromises);
    }

    /**
     * Get all available tools from all connected servers
     */
    async getAllTools(): Promise<MCPTool[]> {
        const allTools: MCPTool[] = [];
        
        for (const [serverName, connection] of this.servers) {
            try {
                const tools = await connection.listTools();
                // Prefix tool names with server name to avoid conflicts
                const prefixedTools = tools.map(tool => ({
                    ...tool,
                    name: `${serverName}_${tool.name}`,
                    description: `[${serverName}] ${tool.description || tool.name}`
                }));
                allTools.push(...prefixedTools);
            } catch (error) {
                console.error(`Failed to get tools from ${serverName}:`, error);
            }
        }

        return allTools;
    }

    /**
     * Execute a tool by name
     */
    async executeTool(toolName: string, args: any): Promise<MCPToolResult> {
        // Parse server name from prefixed tool name
        const [serverName, ...toolNameParts] = toolName.split('_');
        const actualToolName = toolNameParts.join('_');
        
        const connection = this.servers.get(serverName);
        if (!connection) {
            throw new Error(`Server ${serverName} not found`);
        }

        return connection.callTool(actualToolName, args);
    }

    /**
     * Disconnect from all servers
     */
    async disconnect(): Promise<void> {
        const disconnectPromises = Array.from(this.servers.values()).map(
            connection => connection.disconnect()
        );
        
        await Promise.all(disconnectPromises);
        this.servers.clear();
    }
}

/**
 * Individual MCP server connection
 */
class MCPServerConnection {
    private process: ChildProcess | null = null;
    private requestId = 1;
    private pendingRequests = new Map<number, (response: MCPResponse) => void>();
    private isInitialized = false;

    constructor(
        private name: string,
        private config: MCPServer
    ) {}

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            // Handle Windows command execution
            const isWindows = process.platform === 'win32';
            let command = this.config.command;
            let args = this.config.args;
            
            if (isWindows && command === 'npx') {
                command = 'cmd';
                args = ['/c', 'npx', ...args];
            }
            
            this.process = spawn(command, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: isWindows,
                env: { ...process.env, ...this.config.env }
            });

            if (!this.process.stdin || !this.process.stdout || !this.process.stderr) {
                reject(new Error('Failed to create stdio pipes'));
                return;
            }

            // Handle process output
            let buffer = '';
            this.process.stdout.on('data', (data) => {
                buffer += data.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const response = JSON.parse(line) as MCPResponse;
                            this.handleResponse(response);
                        } catch (error) {
                            console.error(`Failed to parse MCP response: ${line}`);
                        }
                    }
                }
            });

            this.process.stderr?.on('data', (data) => {
                console.error(`MCP server ${this.name} stderr:`, data.toString());
            });

            this.process.on('error', (error) => {
                reject(new Error(`Process error: ${error.message}`));
            });

            this.process.on('exit', (code) => {
                console.log(`MCP server ${this.name} exited with code ${code}`);
            });

            // Initialize the connection
            this.initialize().then(resolve).catch(reject);
        });
    }

    private async initialize(): Promise<void> {
        // Send initialize request
        const response = await this.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {
                tools: {}
            },
            clientInfo: {
                name: 'universal-llm-client',
                version: '1.0.0'
            }
        });

        if (response.error) {
            throw new Error(`Initialization failed: ${response.error.message}`);
        }

        // Send initialized notification
        this.sendNotification('notifications/initialized');
        this.isInitialized = true;
    }

    async listTools(): Promise<MCPTool[]> {
        if (!this.isInitialized) {
            throw new Error('Connection not initialized');
        }

        const response = await this.sendRequest('tools/list');
        
        if (response.error) {
            throw new Error(`Failed to list tools: ${response.error.message}`);
        }

        return response.result?.tools || [];
    }

    async callTool(toolName: string, args: any): Promise<MCPToolResult> {
        if (!this.isInitialized) {
            throw new Error('Connection not initialized');
        }

        const response = await this.sendRequest('tools/call', {
            name: toolName,
            arguments: args
        });

        if (response.error) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${response.error.message}`
                }],
                isError: true
            };
        }

        return response.result;
    }

    private sendRequest(method: string, params?: any): Promise<MCPResponse> {
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin) {
                reject(new Error('Process not connected'));
                return;
            }

            const id = this.requestId++;
            const request: MCPRequest = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };

            this.pendingRequests.set(id, resolve);
            
            // Set timeout for request
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request timeout for method: ${method}`));
                }
            }, 30000);

            try {
                this.process.stdin.write(JSON.stringify(request) + '\n');
            } catch (error) {
                this.pendingRequests.delete(id);
                reject(error);
            }
        });
    }

    private sendNotification(method: string, params?: any): void {
        if (!this.process?.stdin) return;

        const notification = {
            jsonrpc: '2.0',
            method,
            params
        };

        try {
            this.process.stdin.write(JSON.stringify(notification) + '\n');
        } catch (error) {
            console.error(`Failed to send notification ${method}:`, error);
        }
    }

    private handleResponse(response: MCPResponse): void {
        if (response.id !== undefined) {
            const resolver = this.pendingRequests.get(response.id);
            if (resolver) {
                this.pendingRequests.delete(response.id);
                resolver(response);
            }
        }
    }

    async disconnect(): Promise<void> {
        if (this.process) {
            try {
                // Send graceful shutdown signal first
                this.process.stdin?.end();
                
                // Wait a bit for graceful shutdown
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Force kill if still running
                if (!this.process.killed) {
                    this.process.kill('SIGTERM');
                    
                    // Wait a bit more
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Force kill if still running
                    if (!this.process.killed) {
                        this.process.kill('SIGKILL');
                    }
                }
            } catch (error) {
                console.warn(`Warning during process cleanup: ${error}`);
            }
            
            this.process = null;
        }
        this.pendingRequests.clear();
        this.isInitialized = false;
    }
}

/**
 * MCP Integration for Universal LLM Client
 */
export class MCPIntegration {
    private mcpClient: MCPClient;

    constructor() {
        this.mcpClient = new MCPClient();
    }

    /**
     * Connect to MCP servers and register all tools with the AI model
     */
    async connectAndRegisterTools(model: AIModel, configPath?: string): Promise<void> {
        try {
            console.log('🔌 Connecting to MCP servers...');
            await this.mcpClient.connect(configPath ? await this.mcpClient.loadConfig(configPath) : undefined);
            
            console.log('🛠️  Discovering MCP tools...');
            const mcpTools = await this.mcpClient.getAllTools();
            
            console.log(`📦 Found ${mcpTools.length} MCP tools`);
            
            // Convert MCP tools to Universal LLM Client tool format
            for (const mcpTool of mcpTools) {
                const toolHandler: ToolHandler = async (args: any) => {
                    try {
                        const result = await this.mcpClient.executeTool(mcpTool.name, args);
                        
                        if (result.isError) {
                            return {
                                error: true,
                                message: result.content[0]?.text || 'Unknown MCP error'
                            };
                        }
                        
                        // Extract text from MCP response
                        const textContent = result.content
                            .filter(item => item.type === 'text')
                            .map(item => item.text)
                            .join('\n');
                        
                        try {
                            // Try to parse as JSON if possible
                            return JSON.parse(textContent);
                        } catch {
                            // Return as plain text if not valid JSON
                            return { result: textContent };
                        }
                    } catch (error) {
                        return {
                            error: true,
                            message: `MCP tool execution failed: ${error}`
                        };
                    }
                };

                // Register the tool directly with the AI model
                model.registerTool(
                    mcpTool.name,
                    mcpTool.description || mcpTool.name,
                    mcpTool.inputSchema,
                    toolHandler
                );
                
                console.log(`✅ Registered MCP tool: ${mcpTool.name}`);
            }
            
            console.log('🎉 MCP integration complete!');
        } catch (error) {
            console.error('❌ MCP integration failed:', error);
            throw error;
        }
    }

    /**
     * Disconnect from all MCP servers
     */
    async disconnect(): Promise<void> {
        await this.mcpClient.disconnect();
    }

    /**
     * Get the underlying MCP client for advanced usage
     */
    getMCPClient(): MCPClient {
        return this.mcpClient;
    }
}

/**
 * Convenience function to create an AI model with MCP tools pre-loaded
 */
export async function createModelWithMCP(
    modelFactory: () => AIModel,
    mcpConfigPath?: string
): Promise<{ model: AIModel; mcpIntegration: MCPIntegration }> {
    const model = modelFactory();
    const mcpIntegration = new MCPIntegration();
    
    await mcpIntegration.connectAndRegisterTools(model, mcpConfigPath);
    
    return { model, mcpIntegration };
}
