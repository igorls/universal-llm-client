/**
 * Simple MCP Connection Test
 */

import { AIModelFactory } from "../factory";
import { MCPIntegration } from "../mcp-integration";

async function testMCPConnection() {
    console.log('🔌 Testing MCP Connection...');
    
    try {
        const mcpIntegration = new MCPIntegration();
        const model = AIModelFactory.createOllamaChatModel('qwen3:8b');
        
        console.log('Attempting to connect to MCP servers...');
        await mcpIntegration.connectAndRegisterTools(model);
        
        console.log('✅ MCP connection successful!');
        
        // Clean up
        await mcpIntegration.disconnect();
        console.log('✅ Disconnected successfully');
        
    } catch (error) {
        console.error('❌ MCP connection failed:', error);
    }
}

testMCPConnection();
