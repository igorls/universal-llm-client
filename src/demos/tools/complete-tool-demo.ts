/**
 * Complete tool calling demonstration showing manual vs automatic execution
 */

import { AIModelFactory, ToolBuilder } from './index';

async function completeToolDemo() {
    console.log('🚀 Complete Tool Calling Demo - Manual vs Automatic\n');

    const model = AIModelFactory.createOllamaChatModel('qwen3:8b');
    
    // Simple calculator tool for clear demonstration
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
            try {
                const result = Function(`"use strict"; return (${args.expression})`)();
                return { 
                    expression: args.expression, 
                    result, 
                    answer: `${args.expression} = ${result}` 
                };
            } catch (error) {
                return { expression: args.expression, error: 'Invalid expression' };
            }
        }
    );

    const timeTool = ToolBuilder.createTool<{ format?: string }>(
        'get_time',
        'Get current date and time',
        {
            properties: {
                format: { type: 'string', description: 'Date format preference' }
            }
        },
        (args) => {
            const now = new Date();
            return {
                iso: now.toISOString(),
                formatted: now.toLocaleString(),
                day: now.toLocaleDateString('en-US', { weekday: 'long' }),
                date: now.toLocaleDateString(),
                time: now.toLocaleTimeString()
            };
        }
    );

    model.registerTools([calcTool, timeTool]);

    try {
        await model.ensureReady();

        console.log('═══════════════════════════════════════════════════════════════');
        console.log('📋 MANUAL TOOL DETECTION (tools detected but not executed)');
        console.log('═══════════════════════════════════════════════════════════════\n');

        // Manual tool detection - shows thinking, detects tools but doesn't execute
        const manualResponse = await model.chat([
            { role: 'user', content: 'What is 25 * 8 + 15?' }
        ], {}, { tool_choice: 'auto' });

        console.log('Response:', manualResponse.content);
        if (manualResponse.tool_calls) {
            console.log(`\n🔍 Tools detected: ${manualResponse.tool_calls.length}`);
            manualResponse.tool_calls.forEach((call, i) => {
                console.log(`  ${i + 1}. ${call.function.name}: ${call.function.arguments}`);
            });
        }

        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log('🚀 AUTOMATIC TOOL EXECUTION (tools executed automatically)');
        console.log('═══════════════════════════════════════════════════════════════\n');

        // Automatic tool execution - executes tools and provides final answer
        const autoResponse = await model.chatWithTools([
            { role: 'user', content: 'What is 25 * 8 + 15?' }
        ]);

        console.log('Final Response:', autoResponse.content);

        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log('⏰ TIME TOOL DEMONSTRATION');
        console.log('═══════════════════════════════════════════════════════════════\n');

        const timeResponse = await model.chatWithTools([
            { role: 'user', content: 'What time is it right now?' }
        ]);

        console.log('Time Response:', timeResponse.content);

        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log('🔧 MULTIPLE TOOLS IN ONE REQUEST');
        console.log('═══════════════════════════════════════════════════════════════\n');

        const multiResponse = await model.chatWithTools([
            { role: 'user', content: 'Calculate 100 / 4 and tell me what time it is' }
        ]);

        console.log('Multi-tool Response:', multiResponse.content);

        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log('💬 NO TOOLS NEEDED');
        console.log('═══════════════════════════════════════════════════════════════\n');

        const chatResponse = await model.chatWithTools([
            { role: 'user', content: 'What is your favorite color?' }
        ]);

        console.log('Chat Response:', chatResponse.content);

    } catch (error) {
        console.error('❌ Demo failed:', error);
    } finally {
        model.dispose();
        console.log('\n✅ Complete tool calling demo finished!');
    }
}

// Export and run
export { completeToolDemo };

if (require.main === module) {
    completeToolDemo().catch(console.error);
}
