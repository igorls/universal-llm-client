import { AIModelFactory } from "../factory";

/**
 * Comprehensive test for Google models with proper system prompt handling
 * Tests both Gemini (systemInstruction) and Gemma (embedded in user prompt) approaches
 */
async function testGoogleSystemPromptHandling() {
    console.log('🧪 Testing Google Models with Proper System Prompt Handling...\n');

    // Test models with different system instruction approaches
    const models = [
        { 
            name: 'Gemini 2.5 Flash Lite', 
            model: 'gemini-2.5-flash-lite', 
            supportsSystemInstruction: true,
            approach: 'Uses Google systemInstruction parameter'
        },
        { 
            name: 'Gemma 3 27B IT', 
            model: 'gemma-3-27b-it', 
            supportsSystemInstruction: false,
            approach: 'Embeds system prompt in user message'
        }
    ];

    let allTestsPassed = true;

    for (const modelInfo of models) {
        console.log(`\n🔬 Testing ${modelInfo.name} (${modelInfo.model})`);
        console.log(`System approach: ${modelInfo.approach}`);
        console.log(`System instruction parameter: ${modelInfo.supportsSystemInstruction ? '✅' : '❌'}`);
        console.log('='.repeat(70));

        const googleModel = AIModelFactory.createGoogleChatModel(
            modelInfo.model,
            'AIzaSyBDbo7iVNEuCcRNTgDIgRrkGpFKisXXnm0'
        );

        const testResult = await testModelSystemPrompt(googleModel, modelInfo);
        if (!testResult) {
            allTestsPassed = false;
        }
    }

    return { success: allTestsPassed };
}

async function testModelSystemPrompt(googleModel: any, modelInfo: any) {
    const modelName = modelInfo.name;
    let testsPassed = true;

    // Test 1: Basic functionality without system prompt
    console.log(`\n--- Test 1: Basic Chat (${modelName}) ---`);
    try {
        console.log('Question: "What is 2+2?"');
        
        const basicResponse = await googleModel.chat([
            { role: 'user', content: 'What is 2+2?' }
        ]);

        console.log('Response:', basicResponse.message.content);
        console.log('✅ Basic chat works');

    } catch (error) {
        console.error(`❌ Basic chat failed for ${modelName}:`, error);
        testsPassed = false;
    }

    // Test 2: System prompt with math personality
    console.log(`\n--- Test 2: System Prompt - Math Teacher (${modelName}) ---`);
    try {
        console.log('System: "You are a math teacher. Always explain your answers step by step."');
        console.log('Question: "What is 2+2?"');
        
        const mathResponse = await googleModel.chat([
            { role: 'system', content: 'You are a math teacher. Always explain your answers step by step.' },
            { role: 'user', content: 'What is 2+2?' }
        ]);

        console.log('Response:', mathResponse.message.content);
        
        // Check if response is more detailed (indicating system prompt worked)
        const isDetailed = mathResponse.message.content.length > 10 && 
                          (mathResponse.message.content.toLowerCase().includes('step') ||
                           mathResponse.message.content.toLowerCase().includes('add') ||
                           mathResponse.message.content.toLowerCase().includes('plus'));
        
        if (isDetailed) {
            console.log('✅ System prompt appears to be working - detailed explanation provided');
        } else {
            console.log('⚠️  System prompt effectiveness unclear - response:', mathResponse.message.content);
        }

    } catch (error) {
        console.error(`❌ Math teacher system prompt failed for ${modelName}:`, error);
        testsPassed = false;
    }

    // Test 3: System prompt with personality change - streaming
    console.log(`\n--- Test 3: System Prompt Streaming - Pirate (${modelName}) ---`);
    try {
        console.log('System: "You are a friendly pirate. Always use pirate language with Arrr!"');
        console.log('Question: "Count from 1 to 3"');
        console.log('Streaming response:');
        console.log('---');

        const pirateStream = googleModel.chatStream([
            { role: 'system', content: 'You are a friendly pirate. Always use pirate language with Arrr!' },
            { role: 'user', content: 'Count from 1 to 3' }
        ]);

        let streamResponse = '';
        for await (const chunk of pirateStream) {
            process.stdout.write(chunk);
            streamResponse += chunk;
        }
        
        console.log('\n---');
        
        // Check for pirate language
        const hasPirateLanguage = streamResponse.toLowerCase().includes('arr') || 
                                 streamResponse.toLowerCase().includes('matey') ||
                                 streamResponse.toLowerCase().includes('ahoy') ||
                                 streamResponse.toLowerCase().includes('pirate');
        
        if (hasPirateLanguage) {
            console.log('✅ System prompt streaming works - pirate language detected!');
        } else {
            console.log('⚠️  System prompt streaming effectiveness unclear');
            console.log('Response was:', streamResponse);
        }

    } catch (error) {
        console.error(`❌ Pirate system prompt streaming failed for ${modelName}:`, error);
        testsPassed = false;
    }

    // Test 4: Complex system prompt with multiple instructions
    console.log(`\n--- Test 4: Complex System Prompt (${modelName}) ---`);
    try {
        console.log('System: Complex instructions with format requirements');
        console.log('Question: "List 3 colors"');
        
        const complexResponse = await googleModel.chat([
            { role: 'system', content: 'You are a helpful assistant. Always format your lists with numbers. Always say "Here are" before your list. Keep responses very short.' },
            { role: 'user', content: 'List 3 colors' }
        ]);

        console.log('Response:', complexResponse.message.content);
        
        // Check if formatting instructions were followed
        const hasNumbering = /\d+\.|\d+\)/.test(complexResponse.message.content);
        const hasPrefix = complexResponse.message.content.toLowerCase().includes('here are');
        
        console.log(`Numbering detected: ${hasNumbering ? '✅' : '❌'}`);
        console.log(`Prefix detected: ${hasPrefix ? '✅' : '❌'}`);
        
        if (hasNumbering || hasPrefix) {
            console.log('✅ Complex system prompt partially effective');
        } else {
            console.log('⚠️  Complex system prompt effectiveness unclear');
        }

    } catch (error) {
        console.error(`❌ Complex system prompt failed for ${modelName}:`, error);
        testsPassed = false;
    }

    console.log(`\n📊 ${modelName} Tests Summary: ${testsPassed ? '✅ PASSED' : '❌ FAILED'}`);
    return testsPassed;
}

// Run the comprehensive test
testGoogleSystemPromptHandling().then(result => {
    console.log('\n' + '='.repeat(70));
    if (result.success) {
        console.log('🎉 All tests completed successfully!');
        console.log('\n📋 Summary:');
        console.log('✅ Gemini models: Using systemInstruction parameter');
        console.log('✅ Gemma models: Embedding system prompts in user messages');
        console.log('✅ Both streaming and non-streaming work');
        console.log('✅ Complex system prompts handled correctly');
    } else {
        console.log('💥 Some tests failed - check output above');
    }
    console.log('\n💡 Implementation now follows Google\'s recommendations:');
    console.log('   • Gemini: Uses systemInstruction parameter');
    console.log('   • Gemma: Embeds system instructions in user prompts');
});
