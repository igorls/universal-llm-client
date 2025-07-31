/**
 * Debug test specifically for LM Studio tool calling with OpenAI API
 */

async function testLMStudioTools() {
    console.log('🔧 Testing LM Studio Tool Calling with OpenAI API\n');

    // Create LM Studio model using OpenAI-compatible API
    const model = AIModelFactory.createOpenAIChatModel(
        'qwen/qwen3-8b',  // Tool-trained model
        'http://192.168.100.136:1234/v1'  // LM Studio URL
    );

    // Create simple test tools (same as our router test)
    const testTools = [
        ToolBuilder.createTool<{ expression: string }>(
            'calculate',
            'Perform mathematical calculations',
            {
                properties: {
                    expression: {
                        type: 'string',
                        description: 'Mathematical expression to evaluate'
                    }
                },
                required: ['expression']
            },
            (args) => {
                try {
                    const result = eval(args.expression); // Safe for testing
                    console.log(`🔧 Tool executed: calculate(${args.expression}) = ${result}`);
                    return `The result of ${args.expression} is ${result}`;
                } catch (error) {
                    console.log(`❌ Tool error: calculate(${args.expression}) failed`);
                    return `Error calculating ${args.expression}: ${error}`;
                }
            }
        ),

        ToolBuilder.createTool<{ location: string }>(
            'get_weather',
            'Get weather information',
            {
                properties: {
                    location: {
                        type: 'string',
                        description: 'City and state/country'
                    }
                },
                required: ['location']
            },
            (args) => {
                console.log(`🔧 Tool executed: get_weather(${args.location})`);
                return `The weather in ${args.location} is sunny and 72°F.`;
            }
        )
    ];

    // Register tools
    model.registerTools(testTools);

    console.log('📝 Registered tools:', testTools.map(t => t.name).join(', '));
    console.log('');

    try {
        await model.ensureReady();
        console.log('✅ LM Studio model ready\n');

        // Test 1: Basic calculation
        console.log('🧮 Test 1: Basic Calculation');
        console.log('Question: What is 15 multiplied by 23?');

        const response1 = await model.chatWithTools([
            { role: 'user', content: 'What is 15 multiplied by 23? Use the calculate tool.' }
        ]);

        console.log('Response:', response1.message?.content || 'No content');
        console.log('Usage:', response1.usage);
        console.log('');

        // Test 2: Weather query
        console.log('🌤️ Test 2: Weather Query');
        console.log('Question: Weather in San Francisco');

        const response2 = await model.chatWithTools([
            { role: 'user', content: 'What is the weather in San Francisco, CA?' }
        ]);

        console.log('Response:', response2.message?.content || 'No content');
        console.log('');

        // Test 3: Manual tool call inspection (without auto-execution)
        console.log('🔍 Test 3: Manual Tool Call Inspection');
        console.log('Question: Calculate 100 / 4 (without auto-execution)');

        const response3 = await model.chat([
            { role: 'user', content: 'Calculate 100 divided by 4 using the calculate tool.' }
        ], {}, {
            tool_choice: 'auto',
            executeTools: false  // Don't auto-execute
        });

        console.log('Response content:', response3.message?.content || 'No content');
        console.log('Tool calls detected:', response3.message?.tool_calls?.length || 0);

        if (response3.message?.tool_calls) {
            response3.message.tool_calls.forEach((call, i) => {
                console.log(`  Tool ${i + 1}: ${call.function.name}(${call.function.arguments})`);
            });
        }
        console.log('');

        // Test 4: Different tool_choice settings
        console.log('🎯 Test 4: Different tool_choice Settings');

        const testCases = [
            { choice: 'auto', desc: 'Auto (let model decide)' },
            { choice: 'required', desc: 'Required (force tool use)' },
            { choice: { type: 'function', function: { name: 'calculate' } }, desc: 'Specific tool' }
        ];

        for (const testCase of testCases) {
            console.log(`Testing tool_choice: ${testCase.desc}`);
            try {
                const response = await model.chat([
                    { role: 'user', content: 'What is 50 + 50?' }
                ], {}, {
                    tool_choice: testCase.choice as any,
                    executeTools: false
                });

                console.log(`  Content: ${response.message?.content?.substring(0, 100) || 'No content'}${(response.message?.content?.length || 0) > 100 ? '...' : ''}`);
                console.log(`  Tool calls: ${response.message?.tool_calls?.length || 0}`);

            } catch (error) {
                console.log(`  Error: ${(error as Error).message}`);
            }
            console.log('');
        }

    } catch (error) {
        console.error('❌ Test failed:', (error as Error).message);
        console.error('Stack:', (error as Error).stack);
    } finally {
        model.dispose();
        console.log('🏁 Test completed!\n');
    }
}

// Run the test
if (require.main === module) {
    testLMStudioTools().catch(console.error);
}

export { testLMStudioTools };
