/**
 * MCP MongoDB Demo - Working Demo
 */

import { AIModelFactory } from './factory';
import { createModelWithMCP } from './mcp-integration';
import type { LLMChatMessage } from './interfaces';

async function runMCPMongoDemo() {
    console.log('🚀 Starting MCP MongoDB Demo');
    console.log('============================');
    
    let mcpIntegration;
    
    try {
        // Create model with MCP tools
        console.log('🔌 Creating model with MCP integration...');
        const result = await createModelWithMCP(() => {
            return AIModelFactory.createOllamaChatModel('qwen3:8b');
        });
        
        const model = result.model;
        mcpIntegration = result.mcpIntegration;
        
        console.log('✅ MCP integration successful!');
        
        // Test simple database query
        console.log('\n🔍 Asking AI to explore the database...');
        
        const messages: LLMChatMessage[] = [{
            role: 'user',
            content: 'Please list all available databases in our MongoDB instance and tell me what you find.'
        }];
        
        const response = await model.chatWithTools(messages);
        
        console.log('\n🤖 AI Response:');
        console.log(response.content);
        
        if (response.tool_calls && response.tool_calls.length > 0) {
            console.log('\n🛠️  Tools Used:');
            response.tool_calls.forEach((call, index) => {
                console.log(`  ${index + 1}. ${call.function.name}`);
                try {
                    const args = JSON.parse(call.function.arguments);
                    console.log(`     Arguments: ${JSON.stringify(args, null, 2)}`);
                } catch {
                    console.log(`     Arguments: ${call.function.arguments}`);
                }
            });
        }
        
    } catch (error) {
        console.error('❌ Demo failed:', error);
    } finally {
        // Always clean up the MCP connection
        if (mcpIntegration) {
            console.log('\n🔌 Disconnecting from MCP servers...');
            await mcpIntegration.disconnect();
            console.log('✅ MCP servers disconnected');
        }
    }
    
    console.log('\n🎉 Demo completed!');
}

// Run the demo
runMCPMongoDemo().catch(console.error);
