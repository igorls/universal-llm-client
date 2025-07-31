/**
 * Debug tool calling execution
 */

import { AIModelFactory, ToolBuilder } from './index';

async function debugToolCalling() {
    console.log('🔍 Debug Tool Calling Execution\n');

    const model = AIModelFactory.createOllamaChatModel('qwen3:8b');
    
    // Simple calculator tool
    const calcTool = ToolBuilder.createTool<{ expression: string }>(
        'calculator',
        'Calculate mathematical expressions',
        {
            properties: {
                expression: { type: 'string', description: 'Math expression to evaluate' }
            },
            required: ['expression']
        },
        (args) => {
            console.log('🔧 TOOL EXECUTING: calculator with', args);
            try {
                const result = Function(`"use strict"; return (${args.expression})`)();
                return { expression: args.expression, result, answer: `${args.expression} = ${result}` };
            } catch (error) {
                return { expression: args.expression, error: 'Invalid expression', result: null };
            }
        }
    );

    model.registerTool(calcTool.name, calcTool.description, calcTool.parameters, calcTool.handler);

    try {
        await model.ensureReady();

        console.log('📋 Test 1: Manual Tool Call Detection\n');
        
        const response1 = await model.chat([
            { role: 'user', content: 'What is 5 + 3?' }
        ], {}, { tool_choice: 'auto' });

        console.log('Response content:', response1.content);
        console.log('Tool calls detected:', response1.tool_calls?.length || 0);
        
        if (response1.tool_calls) {
            console.log('Tool call details:');
            response1.tool_calls.forEach((call, index) => {
                console.log(`  ${index + 1}. ${call.function.name}: ${call.function.arguments}`);
                console.log(`  Raw tool call:`, JSON.stringify(call, null, 2));
            });
            
            // Manual tool execution
            console.log('\n🔧 Manual Tool Execution:');
            for (const toolCall of response1.tool_calls) {
                try {
                    const args = JSON.parse(toolCall.function.arguments);
                    console.log('Parsed arguments:', args);
                    const result = await calcTool.handler(args);
                    console.log('Tool result:', result);
                } catch (error) {
                    console.log('Tool execution error:', error);
                }
            }
        }

        console.log('\n📋 Test 2: Automatic Tool Execution\n');
        
        const response2 = await model.chatWithTools([
            { role: 'user', content: 'Calculate 10 * 7 for me' }
        ]);

        console.log('Automatic response:', response2.content);

    } catch (error) {
        console.error('❌ Debug failed:', error);
    } finally {
        model.dispose();
    }
}

// Run the debug
if (require.main === module) {
    debugToolCalling().catch(console.error);
}
