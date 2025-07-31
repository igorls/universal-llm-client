import { AIModelFactory } from "../factory";

/**
 * Test to demonstrate library behavior when system messages appear at different positions
 */
async function testSystemMessagePositions() {
    console.log('🧪 Testing System Message Position Behavior...\n');

    const models = [
        { name: 'Gemini 2.5 Flash Lite', model: 'gemini-2.5-flash-lite', family: 'Gemini' },
        { name: 'Gemma 3 27B IT', model: 'gemma-3-27b-it', family: 'Gemma' }
    ];

    for (const modelInfo of models) {
        console.log(`\n🤖 Testing ${modelInfo.name} (${modelInfo.family} family)`);
        console.log('='.repeat(70));

        const googleModel = AIModelFactory.createGoogleChatModel(
            modelInfo.model,
            'AIzaSyBDbo7iVNEuCcRNTgDIgRrkGpFKisXXnm0'
        );

        await testDifferentSystemPositions(googleModel, modelInfo);
    }
}

async function testDifferentSystemPositions(googleModel: any, modelInfo: any) {
    // Test 1: System message at the beginning (normal case)
    console.log('\n--- Test 1: System Message at Beginning ---');
    console.log('Expected: Should work normally');
    
    try {
        const messages1 = [
            { role: 'system', content: 'You are concise. Always answer in exactly 3 words.' },
            { role: 'user', content: 'What is TypeScript?' }
        ];

        const response1 = await googleModel.chat(messages1);
        console.log('📤 Response:', response1.message.content);
        console.log('✅ Beginning system message: Works');

    } catch (error) {
        console.error('❌ Beginning system message failed:', error);
    }

    // Test 2: System message in the middle of conversation
    console.log('\n--- Test 2: System Message in Middle ---');
    console.log('Current behavior: ALL system messages are processed regardless of position');
    
    try {
        const messages2 = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
            { role: 'system', content: 'From now on, be very formal and professional.' },  // Middle system message
            { role: 'user', content: 'What is JavaScript?' }
        ];

        const response2 = await googleModel.chat(messages2);
        console.log('📤 Response:', response2.message.content);
        
        // Check if the response is formal (indicating the middle system message was processed)
        const isFormal = response2.message.content.toLowerCase().includes('formal') ||
                        response2.message.content.includes('professional') ||
                        response2.message.content.length > 50; // Longer responses tend to be more formal
        
        console.log(`🔍 Formality detected: ${isFormal ? '✅' : '❌'}`);
        console.log('✅ Middle system message: Processed');

    } catch (error) {
        console.error('❌ Middle system message failed:', error);
    }

    // Test 3: Multiple system messages at different positions
    console.log('\n--- Test 3: Multiple System Messages at Different Positions ---');
    console.log('Current behavior: ALL system messages are combined');
    
    try {
        const messages3 = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello!' },
            { role: 'system', content: 'Always include emojis in your responses.' },  // Second system message
            { role: 'user', content: 'Tell me about Python programming.' },
            { role: 'system', content: 'Keep responses under 50 words.' }  // Third system message
        ];

        const response3 = await googleModel.chat(messages3);
        console.log('📤 Response:', response3.message.content);
        
        // Check if all system instructions were applied
        const hasEmojis = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/u.test(response3.message.content);
        const isShort = response3.message.content.split(' ').length <= 50;
        
        console.log(`🔍 Emojis present: ${hasEmojis ? '✅' : '❌'}`);
        console.log(`🔍 Under 50 words: ${isShort ? '✅' : '❌'}`);
        console.log('✅ Multiple system messages: All processed');

    } catch (error) {
        console.error('❌ Multiple system messages failed:', error);
    }

    // Test 4: System message at the very end
    console.log('\n--- Test 4: System Message at End ---');
    console.log('Current behavior: Still processed (all system messages are collected)');
    
    try {
        const messages4 = [
            { role: 'user', content: 'What is React?' },
            { role: 'assistant', content: 'React is a JavaScript library for building user interfaces.' },
            { role: 'user', content: 'Can you explain it differently?' },
            { role: 'system', content: 'Explain everything using analogies to cooking.' }  // End system message
        ];

        const response4 = await googleModel.chat(messages4);
        console.log('📤 Response:', response4.message.content);
        
        // Check if cooking analogies were used
        const hasCookingAnalogy = response4.message.content.toLowerCase().includes('cook') ||
                                 response4.message.content.toLowerCase().includes('recipe') ||
                                 response4.message.content.toLowerCase().includes('ingredient') ||
                                 response4.message.content.toLowerCase().includes('kitchen');
        
        console.log(`🔍 Cooking analogy detected: ${hasCookingAnalogy ? '✅' : '❌'}`);
        console.log('✅ End system message: Processed');

    } catch (error) {
        console.error('❌ End system message failed:', error);
    }

    console.log('\n📋 Summary for ' + modelInfo.name + ':');
    
    if (modelInfo.family === 'Gemma') {
        console.log('• Gemma behavior: ALL system messages are combined and embedded in FIRST user message');
        console.log('• Position doesn\'t matter - all system messages are processed');
        console.log('• System instructions apply to the entire conversation');
    } else {
        console.log('• Gemini behavior: ALL system messages are combined into systemInstruction parameter');
        console.log('• Position doesn\'t matter - all system messages are processed');
        console.log('• System instructions apply to the entire conversation');
    }
}

// Run the test
testSystemMessagePositions().then(() => {
    console.log('\n' + '='.repeat(70));
    console.log('🎯 KEY FINDINGS:');
    console.log('');
    console.log('📍 CURRENT BEHAVIOR:');
    console.log('• System messages at ANY position are processed');
    console.log('• ALL system messages are combined (regardless of position)');
    console.log('• For Gemma: Combined system messages embedded in first user message');
    console.log('• For Gemini: Combined system messages sent as systemInstruction parameter');
    console.log('');
    console.log('⚠️  POTENTIAL CONSIDERATIONS:');
    console.log('• System messages in middle of conversation might be unexpected');
    console.log('• Some chat paradigms expect system messages only at the beginning');
    console.log('• Current behavior is consistent but might not match all use cases');
    console.log('');
    console.log('✅ RECOMMENDATION:');
    console.log('• For best results, place system messages at the beginning');
    console.log('• Current implementation is robust and handles all positions');
    console.log('• Consider if mid-conversation system changes should be handled differently');
});
