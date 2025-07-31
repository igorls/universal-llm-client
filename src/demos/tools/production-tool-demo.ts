/**
 * Production-ready tool calling examples
 */

import { AIModelFactory, ToolBuilder } from '../../index';

async function productionToolDemo() {
    console.log('🚀 Production Tool Calling Demo\n');

    // Use the best working model
    const model = AIModelFactory.createOllamaChatModel('qwen3:8b');
    
    // Register useful production tools
    const mathTool = ToolBuilder.createTool<{ expression: string }>(
        'advanced_math',
        'Solve complex mathematical expressions and equations',
        {
            properties: {
                expression: { 
                    type: 'string', 
                    description: 'Mathematical expression to evaluate (supports +, -, *, /, ^, sqrt, sin, cos, etc.)' 
                }
            },
            required: ['expression']
        },
        (args) => {
            try {
                // Enhanced math evaluation (in production, use a proper math library)
                let expr = args.expression.toLowerCase()
                    .replace(/\^/g, '**')
                    .replace(/sqrt\(/g, 'Math.sqrt(')
                    .replace(/sin\(/g, 'Math.sin(')
                    .replace(/cos\(/g, 'Math.cos(')
                    .replace(/tan\(/g, 'Math.tan(')
                    .replace(/log\(/g, 'Math.log(')
                    .replace(/pi/g, 'Math.PI')
                    .replace(/e\b/g, 'Math.E');
                
                const result = Function(`"use strict"; return (${expr})`)();
                
                return {
                    expression: args.expression,
                    result: result,
                    formatted: `${args.expression} = ${result}`
                };
            } catch (error) {
                return {
                    expression: args.expression,
                    error: 'Invalid mathematical expression',
                    result: null
                };
            }
        }
    );

    const dateTool = ToolBuilder.createTool<{ operation: 'current' | 'format' | 'add' | 'diff'; date?: string; format?: string; amount?: number; unit?: string }>(
        'date_calculator',
        'Perform date and time calculations',
        {
            properties: {
                operation: { 
                    type: 'string', 
                    enum: ['current', 'format', 'add', 'diff'],
                    description: 'Type of date operation' 
                },
                date: { type: 'string', description: 'Date string (ISO format)' },
                format: { type: 'string', description: 'Output format' },
                amount: { type: 'number', description: 'Amount to add/subtract' },
                unit: { type: 'string', enum: ['days', 'weeks', 'months', 'years'], description: 'Time unit' }
            },
            required: ['operation']
        },
        (args) => {
            const now = new Date();
            
            switch (args.operation) {
                case 'current':
                    return {
                        current: now.toISOString(),
                        formatted: now.toLocaleString(),
                        unix: now.getTime(),
                        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
                    };
                case 'format':
                    const date = args.date ? new Date(args.date) : now;
                    return {
                        original: args.date || 'current',
                        formatted: date.toLocaleDateString('en-US', { 
                            weekday: 'long', 
                            year: 'numeric', 
                            month: 'long', 
                            day: 'numeric' 
                        })
                    };
                case 'add':
                    const baseDate = args.date ? new Date(args.date) : now;
                    const newDate = new Date(baseDate);
                    if (args.unit === 'days') newDate.setDate(newDate.getDate() + (args.amount || 0));
                    else if (args.unit === 'weeks') newDate.setDate(newDate.getDate() + (args.amount || 0) * 7);
                    else if (args.unit === 'months') newDate.setMonth(newDate.getMonth() + (args.amount || 0));
                    else if (args.unit === 'years') newDate.setFullYear(newDate.getFullYear() + (args.amount || 0));
                    
                    return {
                        original: baseDate.toISOString(),
                        result: newDate.toISOString(),
                        added: `${args.amount} ${args.unit}`
                    };
                default:
                    return { error: 'Unsupported operation' };
            }
        }
    );

    const textTool = ToolBuilder.createTool<{ text: string; operations: string[] }>(
        'text_processor',
        'Process text with multiple operations',
        {
            properties: {
                text: { type: 'string', description: 'Text to process' },
                operations: { 
                    type: 'array', 
                    items: { 
                        type: 'string',
                        enum: ['uppercase', 'lowercase', 'reverse', 'word_count', 'char_count', 'title_case']
                    },
                    description: 'List of operations to perform' 
                }
            },
            required: ['text', 'operations']
        },
        (args) => {
            let result = args.text;
            const operations: Record<string, any> = {};
            
            args.operations.forEach(op => {
                switch (op) {
                    case 'uppercase':
                        operations[op] = result.toUpperCase();
                        break;
                    case 'lowercase':
                        operations[op] = result.toLowerCase();
                        break;
                    case 'reverse':
                        operations[op] = result.split('').reverse().join('');
                        break;
                    case 'word_count':
                        operations[op] = result.trim().split(/\s+/).length;
                        break;
                    case 'char_count':
                        operations[op] = result.length;
                        break;
                    case 'title_case':
                        operations[op] = result.replace(/\w\S*/g, (txt) => 
                            txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
                        );
                        break;
                }
            });
            
            return {
                original: args.text,
                operations: operations,
                summary: `Processed "${args.text}" with ${args.operations.length} operations`
            };
        }
    );

    // Register all tools
    model.registerTools([mathTool, dateTool, textTool]);

    console.log('🔧 Testing Production Tools...\n');

    try {
        await model.ensureReady();

        // Test 1: Advanced Math
        console.log('1️⃣ Advanced Math Tool:');
        const mathResponse = await model.chatWithTools([
            { role: 'user', content: 'Calculate sqrt(144) + 2^3 * 5' }
        ]);
        
        console.log('Response:', mathResponse.content);
        console.log('');

        // Test 2: Date Operations
        console.log('2️⃣ Date Calculator Tool:');
        const dateResponse = await model.chatWithTools([
            { role: 'user', content: 'What is the current date and time?' }
        ]);
        
        console.log('Response:', dateResponse.content);
        console.log('');

        // Test 3: Text Processing
        console.log('3️⃣ Text Processor Tool:');
        const textResponse = await model.chatWithTools([
            { role: 'user', content: 'Process the text "Hello World" - convert to uppercase, count words and characters' }
        ]);
        
        console.log('Response:', textResponse.content);
        console.log('');

        // Test 4: No Tools Required
        console.log('4️⃣ General Chat (No Tools):');
        const chatResponse = await model.chat([
            { role: 'user', content: 'Tell me a fun fact about programming' }
        ], {}, { tool_choice: 'auto' });
        
        console.log('Response:', chatResponse.content);
        if (chatResponse.tool_calls) {
            console.log('Tool calls:', chatResponse.tool_calls.length);
        } else {
            console.log('No tools needed - direct response');
        }
        console.log('');

        // Test 5: Force Tool Usage
        console.log('5️⃣ Forced Tool Usage:');
        const forcedResponse = await model.chat([
            { role: 'user', content: 'Tell me about today' }
        ], {}, { 
            tool_choice: { type: 'function', function: { name: 'date_calculator' } }
        });
        
        console.log('Response:', forcedResponse.content);
        if (forcedResponse.tool_calls) {
            console.log('Forced tool call:', forcedResponse.tool_calls[0]?.function.name);
            console.log('Note: Tool was called but not executed - use chatWithTools for automatic execution');
        }

    } catch (error) {
        console.error('❌ Error:', (error as Error).message);
    } finally {
        model.dispose();
        console.log('\n✅ Production demo completed!');
    }
}

// Export for use in other files
export { productionToolDemo };

// Run if called directly
if (require.main === module) {
    productionToolDemo().catch(console.error);
}
