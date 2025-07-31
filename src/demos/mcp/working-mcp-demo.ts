/**
 * Working MCP MongoDB Demo
 */

import { AIModelFactory } from './factory';
import { createModelWithMCP } from './mcp-integration';
import type { LLMChatMessage } from './interfaces';

async function workingMCPDemo() {
    console.log('🚀 Working MCP MongoDB Demo');
    console.log('===========================');
    
    let mcpIntegration;
    
    try {
        // Create model with MCP tools
        console.log('🔌 Setting up AI model with MongoDB tools...');
        const result = await createModelWithMCP(() => {
            return AIModelFactory.createOllamaChatModel('qwen3:8b');
        });
        
        const model = result.model;
        mcpIntegration = result.mcpIntegration;
        
        console.log('✅ AI model ready with MongoDB capabilities!');
        
        // Simple database exploration
        console.log('\n🔍 Asking AI to explore the database...');
        
        const messages: LLMChatMessage[] = [{
            role: 'user',
            content: 'Please list all databases in our MongoDB instance and tell me what you find.'
        }];
        
        const response = await model.chatWithTools(messages);
        
        console.log('\n🤖 AI Response:');
        console.log(response.content);
        
        if (response.tool_calls && response.tool_calls.length > 0) {
            console.log('\n🛠️  MongoDB Tools Used:');
            response.tool_calls.forEach((call, index) => {
                console.log(`  ${index + 1}. ${call.function.name}`);
            });
        }
        
    } catch (error) {
        console.error('❌ Demo failed:', error);
    } finally {
        // Clean up
        if (mcpIntegration) {
            console.log('\n🔌 Cleaning up...');
            await mcpIntegration.disconnect();
            console.log('✅ Disconnected from MongoDB MCP server');
        }
    }
    
    console.log('\n🎉 Demo completed successfully!');
}

// Run the demo
workingMCPDemo().catch(console.error);
