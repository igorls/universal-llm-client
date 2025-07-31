/**
 * Simple demonstration of tool calling functionality
 */

import { AIModelFactory, ToolBuilder } from './index';

async function demoToolCalling() {
    console.log('🛠️  Universal LLM Client - Tool Calling Demo\n');

    // Create a model with good tool calling support
    const model = AIModelFactory.createOllamaChatModelWithTools('qwen3:8b');
    
    console.log('📋 Demo 1: Simple Calculator Tool\n');
    
    try {
        await model.ensureReady();
        console.log('✅ Model ready\n');
        
        // Test basic calculator
        const response1 = await model.chatWithTools([
            { role: 'user', content: 'Calculate 123 * 456 for me please' }
        ]);

        console.log('Calculator result:', response1.content);
        console.log('---\n');

        // Test time tool
        console.log('📋 Demo 2: Current Time Tool\n');
        
        const response2 = await model.chatWithTools([
            { role: 'user', content: 'What time is it right now?' }
        ]);

        console.log('Time result:', response2.content);
        console.log('---\n');

        // Test custom tool
        console.log('📋 Demo 3: Custom Tool - Password Generator\n');
        
        const passwordTool = ToolBuilder.createTool<{ length: number; includeSymbols?: boolean }>(
            'generate_password',
            'Generate a secure password',
            {
                properties: {
                    length: { type: 'number', description: 'Password length' },
                    includeSymbols: { type: 'boolean', description: 'Include special symbols' }
                },
                required: ['length']
            },
            (args) => {
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';
                const charset = args.includeSymbols ? chars + symbols : chars;
                
                let password = '';
                for (let i = 0; i < args.length; i++) {
                    password += charset.charAt(Math.floor(Math.random() * charset.length));
                }
                
                return {
                    password,
                    length: password.length,
                    hasSymbols: args.includeSymbols || false
                };
            }
        );

        model.registerTool(
            passwordTool.name,
            passwordTool.description,
            passwordTool.parameters,
            passwordTool.handler
        );

        const response3 = await model.chatWithTools([
            { role: 'user', content: 'Generate a secure 16-character password with symbols' }
        ]);

        console.log('Password generation result:', response3.content);
        console.log('---\n');

        // Test multiple tools in one request
        console.log('📋 Demo 4: Multiple Tools in One Request\n');
        
        const response4 = await model.chatWithTools([
            { 
                role: 'user', 
                content: 'Please do three things: 1) Calculate 789 + 123, 2) Tell me the current time, 3) Generate a 12-character password' 
            }
        ]);

        console.log('Multiple tools result:', response4.content);
        console.log('---\n');

        // Test manual tool execution (without auto-execution)
        console.log('📋 Demo 5: Manual Tool Control\n');
        
        const response5 = await model.chat([
            { role: 'user', content: 'What is 999 / 3?' }
        ], {}, { tool_choice: 'auto' });

        console.log('Manual response content:', response5.content);
        
        if (response5.tool_calls) {
            console.log('Tools that would be called:');
            response5.tool_calls.forEach((call, index) => {
                console.log(`  ${index + 1}. ${call.function.name}: ${call.function.arguments}`);
            });
        }

    } catch (error) {
        console.error('❌ Demo failed:', (error as Error).message);
    } finally {
        model.dispose();
        console.log('\n✅ Demo completed!');
    }
}

// Run the demo
if (require.main === module) {
    demoToolCalling().catch(console.error);
}

export { demoToolCalling };
