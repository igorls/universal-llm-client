/**
 * MCP MongoDB Integration Demo
 *
 * This demo showcases how to integrate MongoDB operations through MCP
 * (Model Context Protocol) with the Universal LLM Client.
 */

import { AIModelFactory } from '../../factory';
import { MCPIntegration, createModelWithMCP } from '../../mcp-integration';
import type { LLMChatMessage } from '../../interfaces';
import { join } from 'node:path';
import {readFile} from 'fs/promises';

/**
 * Demo 1: Basic MCP Connection and Tool Discovery
 */
async function basicMCPDemo() {
    console.log('\n🎯 Demo 1: Basic MCP Connection and Tool Discovery');
    console.log('=' .repeat(60));

    try {
        // Create MCP integration instance
        const mcpIntegration = new MCPIntegration();

        // Create a model
        const model = AIModelFactory.createOllamaChatModel('qwen3:8b');

        // Connect to MCP servers and register tools
        await mcpIntegration.connectAndRegisterTools(model);

        console.log('✅ MCP integration successful!');
        console.log('📋 MongoDB tools are now available to the AI model');

        // Clean up
        await mcpIntegration.disconnect();

    } catch (error) {
        console.error('❌ Basic MCP demo failed:', error);
    }
}

/**
 * Demo 2: MongoDB Database Operations through MCP
 */
async function mongoDBOperationsDemo() {
    console.log('\n🎯 Demo 2: MongoDB Database Operations through MCP');
    console.log('=' .repeat(60));

    try {
        // Create model with MCP tools using convenience function
        const { model, mcpIntegration } = await createModelWithMCP(() => {
            return AIModelFactory.createOllamaChatModel('qwen3:8b');
        });

        // Test basic database queries
        console.log('\n🔍 Asking AI to explore the database...');

        const messages: LLMChatMessage[] = [{
            role: 'user',
            content: `Please help me explore the MongoDB database. First, list all available databases,
                     then for the main database, show me the available collections.
                     Finally, give me a count of documents in the users collection if it exists.`
        }];

        const response = await model.chatWithTools(messages);

        console.log('\n🤖 AI Response:');
        console.log(response.content);

        if (response.tool_calls && response.tool_calls.length > 0) {
            console.log('\n🛠️  Tools Used:');
            response.tool_calls.forEach((call, index) => {
                console.log(`  ${index + 1}. ${call.function.name}`);
                console.log(`     Arguments: ${call.function.arguments}`);
            });
        }

        // Clean up
        await mcpIntegration.disconnect();

    } catch (error) {
        console.error('❌ MongoDB operations demo failed:', error);
    }
}

/**
 * Demo 3: Complex MongoDB Query with AI Analysis
 */
async function complexMongoQueryDemo() {
    console.log('\n🎯 Demo 3: Complex MongoDB Query with AI Analysis');
    console.log('=' .repeat(60));

    try {
        const { model, mcpIntegration } = await createModelWithMCP(() => {
            return AIModelFactory.createOllamaChatModel('qwen3:8b');
        });

        console.log('\n🧠 Asking AI to perform complex database analysis...');

        const messages: LLMChatMessage[] = [{
            role: 'user',
            content: `I need to analyze user activity in our system. Can you:
                     1. First check what collections are available in the main database
                     2. Count the total number of users
                     3. If there's a conversations collection, aggregate the data to show user activity patterns
                     4. Provide insights about the data you found`
        }];

        const response = await model.chatWithTools(messages);

        console.log('\n🤖 AI Analysis:');
        console.log(response.content);

        if (response.tool_calls && response.tool_calls.length > 0) {
            console.log('\n📊 Database Operations Performed:');
            response.tool_calls.forEach((call, index) => {
                console.log(`\n  Operation ${index + 1}: ${call.function.name}`);
                console.log(`  Purpose: ${call.function.name.includes('list') ? 'Discovery' :
                           call.function.name.includes('count') ? 'Counting' :
                           call.function.name.includes('aggregate') ? 'Analysis' : 'Query'}`);
                console.log(`  Arguments: ${call.function.arguments}`);
            });
        }

        await mcpIntegration.disconnect();

    } catch (error) {
        console.error('❌ Complex MongoDB query demo failed:', error);
    }
}

/**
 * Demo 4: Data Insertion and Validation
 */
async function dataInsertionDemo() {
    console.log('\n🎯 Demo 4: Data Insertion and Validation');
    console.log('=' .repeat(60));

    try {
        const { model, mcpIntegration } = await createModelWithMCP(() => {
            return AIModelFactory.createOllamaChatModel('qwen3:8b');
        });

        console.log('\n💾 Asking AI to insert test data...');

        const messages: LLMChatMessage[] = [{
            role: 'user',
            content: `Please help me add some test user data to the database.
                     First check if there's a 'test_users' collection, and if not, create it.
                     Then insert 3 sample user records with fields like name, email, age, and created_date.
                     After insertion, verify the data was added correctly by counting the documents.`
        }];

        const response = await model.chatWithTools(messages);

        console.log('\n🤖 AI Response:');
        console.log(response.content);

        if (response.tool_calls && response.tool_calls.length > 0) {
            console.log('\n📝 Database Modifications:');
            response.tool_calls.forEach((call, index) => {
                console.log(`\n  Step ${index + 1}: ${call.function.name}`);

                if (call.function.name.includes('insert')) {
                    try {
                        const args = JSON.parse(call.function.arguments);
                        console.log(`  📄 Documents to insert: ${args.documents?.length || 0}`);
                        if (args.documents) {
                            args.documents.forEach((doc: any, i: number) => {
                                console.log(`    ${i + 1}. ${doc.name || 'Unknown'} (${doc.email || 'No email'})`);
                            });
                        }
                    } catch (e) {
                        console.log(`  📄 Arguments: ${call.function.arguments}`);
                    }
                }
            });
        }

        await mcpIntegration.disconnect();

    } catch (error) {
        console.error('❌ Data insertion demo failed:', error);
    }
}

/**
 * Demo 5: Error Handling and Fallbacks
 */
async function errorHandlingDemo() {
    console.log('\n🎯 Demo 5: Error Handling and Fallbacks');
    console.log('=' .repeat(60));

    try {
        const { model, mcpIntegration } = await createModelWithMCP(() => {
            return AIModelFactory.createOllamaChatModel('qwen3:8b');
        });

        console.log('\n🚨 Testing AI error handling with invalid queries...');

        const messages: LLMChatMessage[] = [{
            role: 'user',
            content: `Try to query a collection called 'nonexistent_collection' in a database called 'fake_db'.
                     When this fails, please explain what went wrong and suggest alternative approaches
                     to explore the actual available databases and collections.`
        }];

        const response = await model.chatWithTools(messages);

        console.log('\n🤖 AI Error Handling:');
        console.log(response.content);

        if (response.tool_calls && response.tool_calls.length > 0) {
            console.log('\n🔍 Error Recovery Process:');
            response.tool_calls.forEach((call, index) => {
                console.log(`\n  Attempt ${index + 1}: ${call.function.name}`);
                console.log(`     Arguments: ${call.function.arguments}`);
            });
        }

        await mcpIntegration.disconnect();

    } catch (error) {
        console.error('❌ Error handling demo failed:', error);
    }
}

/**
 * Run all MCP MongoDB demos
 */
async function runAllMCPDemos() {
    console.log('🚀 Starting MCP MongoDB Integration Demos');
    console.log('==========================================');

    // Check if MCP config exists

    try {
        const mcpConfigPath = join(process.cwd(), '.vscode', 'mcp.json');
        await readFile(mcpConfigPath, 'utf-8');
        console.log('✅ MCP configuration found');
    } catch {
        console.log('⚠️  MCP configuration not found - demos will use mock data');
        console.log('   To use real MongoDB MCP server, ensure .vscode/mcp.json is configured');
    }

    // Run all demos
    await basicMCPDemo();
    await mongoDBOperationsDemo();
    await complexMongoQueryDemo();
    await dataInsertionDemo();
    await errorHandlingDemo();

    console.log('\n🎉 All MCP MongoDB demos completed!');
    console.log('\n📋 Summary:');
    console.log('• MCP integration allows seamless database operations through AI');
    console.log('• Tools are automatically discovered and registered');
    console.log('• AI can perform complex multi-step database workflows');
    console.log('• Error handling and recovery is built-in');
    console.log('• Perfect for building AI-powered database assistants');
}

// Export the demos
export {
    basicMCPDemo,
    mongoDBOperationsDemo,
    complexMongoQueryDemo,
    dataInsertionDemo,
    errorHandlingDemo,
    runAllMCPDemos
};

// Run demos if this file is executed directly
if (require.main === module) {
    runAllMCPDemos().catch(console.error);
}
