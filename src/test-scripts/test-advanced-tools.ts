/**
 * Advanced tool calling examples and demonstrations
 */

import { AIModelFactory, ToolBuilder } from '../index';

async function advancedToolCallingDemo() {
    console.log('🚀 Advanced Tool Calling Demonstration\n');

    // Create an Ollama model with tools
    const model = AIModelFactory.createOllamaChatModelWithTools('llama3.2:3b');

    // Add some advanced custom tools
    const weatherTool = ToolBuilder.createTool<{ city: string; units?: 'celsius' | 'fahrenheit' }>(
        'get_weather',
        'Get current weather for a city',
        {
            properties: {
                city: { type: 'string', description: 'City name' },
                units: { 
                    type: 'string', 
                    enum: ['celsius', 'fahrenheit'], 
                    description: 'Temperature units',
                    default: 'celsius'
                }
            },
            required: ['city']
        },
        async (args) => {
            // Simulate API call delay
            await new Promise(resolve => setTimeout(resolve, 500));
            
            const temp = args.units === 'fahrenheit' ? 
                Math.floor(Math.random() * 40) + 50 : 
                Math.floor(Math.random() * 25) + 5;
                
            return {
                city: args.city,
                temperature: temp,
                units: args.units || 'celsius',
                condition: ['sunny', 'cloudy', 'rainy', 'snowy'][Math.floor(Math.random() * 4)],
                humidity: Math.floor(Math.random() * 40) + 40,
                wind_speed: Math.floor(Math.random() * 20) + 5
            };
        }
    );

    const stockTool = ToolBuilder.createTool<{ symbol: string }>(
        'get_stock_price',
        'Get current stock price for a symbol',
        {
            properties: {
                symbol: { type: 'string', description: 'Stock symbol (e.g., AAPL, GOOGL)' }
            },
            required: ['symbol']
        },
        async (args) => {
            await new Promise(resolve => setTimeout(resolve, 300));
            
            return {
                symbol: args.symbol.toUpperCase(),
                price: (Math.random() * 500 + 50).toFixed(2),
                change: ((Math.random() - 0.5) * 10).toFixed(2),
                change_percent: ((Math.random() - 0.5) * 5).toFixed(1),
                currency: 'USD',
                last_updated: new Date().toISOString()
            };
        }
    );

    const fileAnalyzerTool = ToolBuilder.createTool<{ filename: string; content: string }>(
        'analyze_file',
        'Analyze file content and provide statistics',
        {
            properties: {
                filename: { type: 'string', description: 'Name of the file' },
                content: { type: 'string', description: 'File content to analyze' }
            },
            required: ['filename', 'content']
        },
        (args) => {
            const lines = args.content.split('\n');
            const words = args.content.split(/\s+/).filter(w => w.length > 0);
            const chars = args.content.length;
            
            return {
                filename: args.filename,
                statistics: {
                    lines: lines.length,
                    words: words.length,
                    characters: chars,
                    characters_no_spaces: args.content.replace(/\s/g, '').length,
                    avg_words_per_line: (words.length / lines.length).toFixed(1),
                    longest_line: Math.max(...lines.map(l => l.length)),
                    shortest_line: Math.min(...lines.map(l => l.length))
                },
                analysis: {
                    file_type: args.filename.split('.').pop() || 'unknown',
                    estimated_reading_time: Math.ceil(words.length / 200), // minutes
                    complexity_score: Math.min(10, Math.ceil(words.length / 100))
                }
            };
        }
    );

    // Register advanced tools
    model.registerTools([weatherTool, stockTool, fileAnalyzerTool]);

    console.log('📋 Demo 1: Multi-step planning with tools\n');
    
    try {
        console.log('🤖 AI planning a vacation...');
        
        const response = await model.chatWithTools([
            { 
                role: 'user', 
                content: 'I\'m planning a trip to Tokyo and New York. Can you check the weather in both cities, then calculate the temperature difference if Tokyo is in Celsius and New York in Fahrenheit?' 
            }
        ]);

        console.log('✅ Travel planning response:', response.content);
    } catch (error) {
        console.error('❌ Error:', (error as Error).message);
    }

    console.log('\n📋 Demo 2: Financial analysis with tools\n');
    
    try {
        console.log('💰 AI analyzing stock portfolio...');
        
        const response = await model.chatWithTools([
            { 
                role: 'user', 
                content: 'Check the current prices for AAPL, GOOGL, and TSLA stocks, then calculate the total value if I own 10 shares of each' 
            }
        ]);

        console.log('✅ Portfolio analysis:', response.content);
    } catch (error) {
        console.error('❌ Error:', (error as Error).message);
    }

    console.log('\n📋 Demo 3: Content analysis workflow\n');
    
    try {
        console.log('📄 AI analyzing document...');
        
        const sampleCode = `
function calculateTotal(items) {
    let total = 0;
    for (let i = 0; i < items.length; i++) {
        total += items[i].price * items[i].quantity;
    }
    return total;
}

const cart = [
    { name: 'laptop', price: 999, quantity: 1 },
    { name: 'mouse', price: 25, quantity: 2 }
];

console.log('Total:', calculateTotal(cart));
`;

        const response = await model.chatWithTools([
            { 
                role: 'user', 
                content: `Analyze this JavaScript code and tell me about its complexity and functionality:\n\n${sampleCode}` 
            }
        ]);

        console.log('✅ Code analysis:', response.content);
    } catch (error) {
        console.error('❌ Error:', (error as Error).message);
    }

    console.log('\n📋 Demo 4: Complex mathematical operations\n');
    
    try {
        console.log('🧮 AI solving complex math problems...');
        
        const response = await model.chatWithTools([
            { 
                role: 'user', 
                content: 'Calculate the compound interest for $10,000 invested at 5% annually for 10 years using the formula A = P(1 + r)^t, then generate 5 random numbers between 1 and 100 and find their average' 
            }
        ]);

        console.log('✅ Math analysis:', response.content);
    } catch (error) {
        console.error('❌ Error:', (error as Error).message);
    }

    console.log('\n📋 Demo 5: Tool error handling\n');
    
    try {
        console.log('⚠️  Testing error scenarios...');
        
        // Create a tool that might fail
        const unreliableTool = ToolBuilder.createTool<{ data: string }>(
            'unreliable_operation',
            'An operation that might fail',
            {
                properties: {
                    data: { type: 'string', description: 'Input data' }
                },
                required: ['data']
            },
            (args) => {
                if (Math.random() < 0.5) {
                    throw new Error('Simulated tool failure');
                }
                return { success: true, processed: args.data };
            }
        );

        model.registerTool(
            unreliableTool.name,
            unreliableTool.description,
            unreliableTool.parameters,
            unreliableTool.handler
        );

        const response = await model.chat([
            { 
                role: 'user', 
                content: 'Try to process some data with the unreliable operation tool' 
            }
        ], {}, { 
            tools: [{ type: 'function', function: unreliableTool }],
            tool_choice: { type: 'function', function: { name: 'unreliable_operation' } }
        });

        console.log('✅ Error handling response:', response.content);
        if (response.tool_calls) {
            console.log('🔨 Tool calls attempted:', response.tool_calls.length);
        }
    } catch (error) {
        console.error('❌ Error:', (error as Error).message);
    }

    // Clean up
    model.dispose();
    
    console.log('\n🎉 Advanced tool calling demonstration completed!');
}

// Performance benchmark
async function benchmarkToolExecution() {
    console.log('\n⚡ Tool Execution Performance Benchmark\n');
    
    const model = AIModelFactory.createOllamaChatModelWithTools('llama3.2:3b');
    
    const iterations = 5;
    const times: number[] = [];
    
    for (let i = 0; i < iterations; i++) {
        console.log(`🏃 Run ${i + 1}/${iterations}`);
        
        const start = Date.now();
        
        try {
            await model.chatWithTools([
                { 
                    role: 'user', 
                    content: 'Calculate 50 * 25, get the current time, and generate 2 random numbers between 1 and 50' 
                }
            ]);
            
            const elapsed = Date.now() - start;
            times.push(elapsed);
            console.log(`  ⏱️  ${elapsed}ms`);
        } catch (error) {
            console.log(`  ❌ Failed: ${(error as Error).message}`);
        }
    }
    
    if (times.length > 0) {
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        const min = Math.min(...times);
        const max = Math.max(...times);
        
        console.log(`\n📊 Performance Results:`);
        console.log(`  Average: ${avg.toFixed(0)}ms`);
        console.log(`  Min: ${min}ms`);
        console.log(`  Max: ${max}ms`);
        console.log(`  Variance: ${(max - min)}ms`);
    }
    
    model.dispose();
}

// Main demo runner
async function runAdvancedDemo() {
    try {
        await advancedToolCallingDemo();
        await benchmarkToolExecution();
    } catch (error) {
        console.error('💥 Demo failed:', (error as Error).message);
        console.error(error);
    }
}

// Export for use
export { advancedToolCallingDemo, benchmarkToolExecution };

// Run if called directly
if (require.main === module) {
    runAdvancedDemo();
}
