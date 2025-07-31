/**
 * Test tool calling functionality with free local models
 */

import { AIModelFactory, ToolBuilder } from '../index';

async function testToolCallingLocal() {
    console.log('🛠️  Testing Universal LLM Client Tool Calling with Local Models\n');

    // Create models for testing (using models with good tool calling support)
    const models = {
        // Test with Ollama - qwen3:8b has excellent tool calling support
        ollama: AIModelFactory.createOllamaChatModelWithTools('qwen3:8b'),
        // Test with LM Studio - qwen/qwen3-8b for tool calling
        lmstudio: AIModelFactory.createOpenAIChatModelWithTools('qwen/qwen3-8b', 'http://localhost:1234/v1')
    };

    console.log('📋 Test 1: Basic Calculator Tool\n');
    
    for (const [provider, model] of Object.entries(models)) {
        console.log(`\n🔧 Testing ${provider} (checking if server is available):`);
        
        try {
            await model.ensureReady();
            
            const response = await model.chat([
                { role: 'user', content: 'What is 25 * 4 + 10? Please use the calculator tool to solve this mathematically.' }
            ], {}, { 
                tool_choice: 'auto' 
            });

            console.log(`Response: ${response.content}`);
            
            if (response.tool_calls) {
                console.log(`🔨 Tool calls made:`, response.tool_calls.length);
                for (const toolCall of response.tool_calls) {
                    console.log(`  - ${toolCall.function.name}: ${toolCall.function.arguments}`);
                }
            } else {
                console.log('ℹ️  No tool calls made - model may have calculated directly');
            }
        } catch (error) {
            if ((error as Error).message.includes('ECONNREFUSED') || (error as Error).message.includes('fetch failed')) {
                console.error(`❌ ${provider} server not running - skipping tests for this provider`);
            } else {
                console.error(`❌ Error with ${provider}:`, (error as Error).message);
            }
        }
    }

    // Test automatic tool execution with calculator
    console.log('\n\n📋 Test 2: Automatic Tool Execution\n');
    
    const ollamaModel = models.ollama;
    
    try {
        console.log('🔧 Testing automatic tool execution with Ollama:');
        
        const response = await ollamaModel.chatWithTools([
            { 
                role: 'user', 
                content: 'Calculate 15 * 8 + 32, then tell me what time it is right now' 
            }
        ]);

        console.log('✅ Final response:', response.content);
    } catch (error) {
        console.error('❌ Error:', (error as Error).message);
    }

    // Test multiple tools
    console.log('\n\n📋 Test 3: Multiple Tool Usage\n');
    
    try {
        console.log('🔧 Testing multiple tools with Ollama:');
        
        // Register additional useful tools
        const randomNumberTool = ToolBuilder.createTool<{ min: number; max: number; count?: number }>(
            'generate_random_numbers',
            'Generate random numbers within a range',
            {
                properties: {
                    min: { type: 'number', description: 'Minimum value' },
                    max: { type: 'number', description: 'Maximum value' },
                    count: { type: 'number', description: 'How many numbers to generate', default: 1 }
                },
                required: ['min', 'max']
            },
            (args) => {
                const count = args.count || 1;
                const numbers: any[] = [];
                for (let i = 0; i < count; i++) {
                    numbers.push(Math.floor(Math.random() * (args.max - args.min + 1)) + args.min);
                }
                return { numbers, count: numbers.length };
            }
        );

        const textTool = ToolBuilder.createTool<{ text: string; operation: 'uppercase' | 'lowercase' | 'reverse' }>(
            'text_transform',
            'Transform text in various ways',
            {
                properties: {
                    text: { type: 'string', description: 'Text to transform' },
                    operation: { 
                        type: 'string', 
                        enum: ['uppercase', 'lowercase', 'reverse'],
                        description: 'Type of transformation' 
                    }
                },
                required: ['text', 'operation']
            },
            (args) => {
                let result = args.text;
                switch (args.operation) {
                    case 'uppercase':
                        result = args.text.toUpperCase();
                        break;
                    case 'lowercase':
                        result = args.text.toLowerCase();
                        break;
                    case 'reverse':
                        result = args.text.split('').reverse().join('');
                        break;
                }
                return { original: args.text, transformed: result, operation: args.operation };
            }
        );

        ollamaModel.registerTools([randomNumberTool, textTool]);
        
        const response = await ollamaModel.chatWithTools([
            { 
                role: 'user', 
                content: 'First calculate 100 / 4, then generate 3 random numbers between 1 and 10, and finally convert the text "hello world" to uppercase' 
            }
        ]);

        console.log('✅ Final response:', response.content);
    } catch (error) {
        console.error('❌ Error:', (error as Error).message);
    }

    // Test custom tool
    console.log('\n\n📋 Test 4: Custom Tool Registration\n');
    
    try {
        // Register a custom tool
        const customTool = ToolBuilder.createTool<{ city: string; country?: string }>(
            'get_city_info',
            'Get information about a city',
            {
                properties: {
                    city: { type: 'string', description: 'Name of the city' },
                    country: { type: 'string', description: 'Country the city is in' }
                },
                required: ['city']
            },
            (args) => ({
                city: args.city,
                country: args.country || 'Unknown',
                population: Math.floor(Math.random() * 10000000) + 100000,
                weather: 'Sunny',
                timezone: 'UTC+0',
                founded: Math.floor(Math.random() * 2000) + 1
            })
        );

        ollamaModel.registerTool(
            customTool.name,
            customTool.description,
            customTool.parameters,
            customTool.handler
        );

        console.log('🔧 Testing custom tool:');
        
        const response = await ollamaModel.chatWithTools([
            { 
                role: 'user', 
                content: 'Can you get information about Paris, France?' 
            }
        ]);

        console.log('✅ Custom tool response:', response.content);
    } catch (error) {
        console.error('❌ Error:', (error as Error).message);
    }

    // Test tool choice options
    console.log('\n\n📋 Test 5: Tool Choice Control\n');
    
    try {
        console.log('🔧 Testing forced tool usage:');
        
        const response = await ollamaModel.chat([
            { role: 'user', content: 'Tell me about the weather today' }
        ], {}, { 
            tool_choice: { type: 'function', function: { name: 'get_current_time' } }
        });

        console.log('✅ Forced tool response:', response.content);
        if (response.tool_calls) {
            console.log('🔨 Tool used:', response.tool_calls[0]?.function.name);
        }
    } catch (error) {
        console.error('❌ Error:', (error as Error).message);
    }

    // Clean up
    Object.values(models).forEach(model => model.dispose());
    
    console.log('\n✅ Tool calling tests completed!');
}

// Add error handling for the main test
async function runTests() {
    try {
        await testToolCallingLocal();
    } catch (error) {
        console.error('💥 Test suite failed:', (error as Error).message);
        console.error(error);
    }
}

// Run the tests
if (require.main === module) {
    runTests();
}

export { testToolCallingLocal };
