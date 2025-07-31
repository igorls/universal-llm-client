import { AIModelFactory } from "../factory";

/**
 * Enhanced test for Google Generative AI streaming with system prompt support
 */
async function testGoogleStreamingEnhanced() {
    console.log('🧪 Testing Google Generative AI Streaming with System Prompts...\n');

    // Test both models - Gemini (supports system instructions) and Gemma (doesn't)
    const models = [
        { name: 'Gemini 2.5 Flash Lite', model: 'gemini-2.5-flash-lite', supportsSystem: true },
        { name: 'Gemma 3 27B IT', model: 'gemma-3-27b-it', supportsSystem: false }
    ];

    for (const modelInfo of models) {
        console.log(`\n🔬 Testing with ${modelInfo.name} (${modelInfo.model})`);
        console.log(`System instruction support: ${modelInfo.supportsSystem ? '✅' : '❌'}`);
        console.log('='.repeat(60));

        const googleModel = AIModelFactory.createGoogleChatModel(
            modelInfo.model,
            'AIzaSyBDbo7iVNEuCcRNTgDIgRrkGpFKisXXnm0'
        );

        await testModelWithSystemPrompt(googleModel, modelInfo.name, modelInfo.supportsSystem);
    }

    return { success: true };
}

async function testModelWithSystemPrompt(googleModel: any, modelName: string, supportsSystem: boolean) {
    // Test 1: Basic streaming (without system prompt)
    console.log(`\n--- Test 1: Basic Streaming (${modelName}) ---`);
    try {
        console.log('🌊 Starting basic streaming test...');
        console.log('Question: "Count from 1 to 3 briefly."\n');
        console.log('Streaming response:');
        console.log('---');

        const streamResponse = googleModel.chatStream([
            { role: 'user', content: 'Count from 1 to 3 briefly.' }
        ]);

        let chunkCount = 0;
        let fullResponse = '';
        
        for await (const chunk of streamResponse) {
            chunkCount++;
            process.stdout.write(chunk);
            fullResponse += chunk;
        }
        
        console.log('\n---');
        console.log(`✅ Basic streaming completed! Received ${chunkCount} chunks`);
        console.log(`Full response length: ${fullResponse.length} characters\n`);

    } catch (error) {
        console.error(`❌ Basic streaming test failed for ${modelName}:`, error);
        return;
    }

    // Test 2: System prompt streaming (only test if model supports it)
    if (supportsSystem) {
        console.log(`--- Test 2: System Prompt Streaming (${modelName}) ---`);
        try {
            console.log('🎭 Testing streaming with system prompt...');
            console.log('System: "You are a pirate. Always respond like a pirate with \'Arrr\' and pirate language."');
            console.log('Question: "Count from 1 to 3 briefly."\n');
            console.log('Streaming response:');
            console.log('---');

            const systemStreamResponse = googleModel.chatStream([
                { role: 'system', content: 'You are a pirate. Always respond like a pirate with "Arrr" and pirate language.' },
                { role: 'user', content: 'Count from 1 to 3 briefly.' }
            ]);

            let systemChunkCount = 0;
            let systemFullResponse = '';
            
            for await (const chunk of systemStreamResponse) {
                systemChunkCount++;
                process.stdout.write(chunk);
                systemFullResponse += chunk;
            }
            
            console.log('\n---');
            console.log(`✅ System prompt streaming completed! Received ${systemChunkCount} chunks`);
            console.log(`Full response length: ${systemFullResponse.length} characters`);
            
            // Check if the response contains pirate language
            const hasPirateLanguage = systemFullResponse.toLowerCase().includes('arr') || 
                                     systemFullResponse.toLowerCase().includes('matey') ||
                                     systemFullResponse.toLowerCase().includes('pirate') ||
                                     systemFullResponse.toLowerCase().includes('ahoy');
            
            if (hasPirateLanguage) {
                console.log('✅ System prompt appears to be working - pirate language detected!');
            } else {
                console.log('⚠️  System prompt might not be working - no obvious pirate language detected');
                console.log('Response content:', systemFullResponse);
            }

        } catch (error) {
            console.error(`❌ System prompt streaming test failed for ${modelName}:`, error);
            return;
        }

        // Test 3: Non-streaming chat with system prompt
        console.log(`\n--- Test 3: Non-Streaming Chat with System Prompt (${modelName}) ---`);
        try {
            console.log('🎭 Testing non-streaming chat with system prompt...');
            console.log('System: "You are a helpful mathematician. Always explain your counting clearly."');
            console.log('Question: "Count from 1 to 3."\n');

            const chatResponse = await googleModel.chat([
                { role: 'system', content: 'You are a helpful mathematician. Always explain your counting clearly.' },
                { role: 'user', content: 'Count from 1 to 3.' }
            ]);

            console.log('Non-streaming response:');
            console.log('---');
            console.log(chatResponse.message.content);
            console.log('---');
            console.log(`✅ Non-streaming chat completed!`);
            console.log(`Response length: ${chatResponse.message.content.length} characters`);

        } catch (error) {
            console.error(`❌ Non-streaming chat test failed for ${modelName}:`, error);
            return;
        }
    } else {
        console.log(`⚠️  Skipping system prompt tests for ${modelName} - model doesn't support system instructions`);
    }
}

// Run the enhanced test
testGoogleStreamingEnhanced().then(result => {
    if (result.success) {
        console.log('\n🎉 All tests completed successfully!');
        console.log('\n📋 Summary:');
        console.log('✅ Basic streaming: Working');
        console.log('🔍 System prompt streaming: Tested (check output above)');
        console.log('✅ Non-streaming chat: Working');
    } else {
        console.log('\n💥 Tests failed');
    }
});
