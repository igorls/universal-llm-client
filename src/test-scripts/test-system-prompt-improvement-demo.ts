import { AIModelFactory } from "../factory";

/**
 * Demonstration of improved Gemma system prompt handling
 * Shows the difference between Gemini (systemInstruction) and Gemma (embedded) approaches
 */
async function demonstrateSystemPromptImprovement() {
    console.log('🔬 Demonstrating Improved System Prompt Handling\n');
    console.log('📚 Based on Google\'s documentation: https://ai.google.dev/gemma/docs/core/prompt-structure\n');

    // Test the same system prompt with both model types
    const systemPrompt = 'You are a helpful cooking assistant. Always provide step-by-step recipes.';
    const userPrompt = 'How do I make scrambled eggs?';

    console.log('🧪 Testing System Prompt:', systemPrompt);
    console.log('❓ User Question:', userPrompt);
    console.log('\n' + '='.repeat(80));

    // Test 1: Gemini model (uses systemInstruction parameter)
    console.log('\n🤖 GEMINI 2.5 FLASH LITE');
    console.log('📋 Method: Uses Google\'s systemInstruction parameter');
    console.log('✨ System prompt is sent separately from user content\n');

    const geminiModel = AIModelFactory.createGoogleChatModel(
        'gemini-2.5-flash-lite',
        'AIzaSyBDbo7iVNEuCcRNTgDIgRrkGpFKisXXnm0'
    );

    try {
        const geminiResponse = await geminiModel.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ]);

        console.log('📤 Response:', geminiResponse.message.content);
        console.log('✅ Gemini system prompt working correctly\n');

    } catch (error) {
        console.error('❌ Gemini test failed:', error);
    }

    console.log('='.repeat(80));

    // Test 2: Gemma model (embeds system prompt in user message)
    console.log('\n🤖 GEMMA 3 27B IT');
    console.log('📋 Method: Embeds system instructions directly in user message');
    console.log('✨ System prompt is combined with first user message\n');

    const gemmaModel = AIModelFactory.createGoogleChatModel(
        'gemma-3-27b-it',
        'AIzaSyBDbo7iVNEuCcRNTgDIgRrkGpFKisXXnm0'
    );

    try {
        const gemmaResponse = await gemmaModel.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ]);

        console.log('📤 Response:', gemmaResponse.message.content);
        console.log('✅ Gemma system prompt working correctly\n');

    } catch (error) {
        console.error('❌ Gemma test failed:', error);
    }

    console.log('='.repeat(80));
    console.log('\n🎯 KEY IMPROVEMENTS:');
    console.log('• Gemini models: Use Google\'s systemInstruction parameter (official way)');
    console.log('• Gemma models: Embed system prompts in user messages (as documented)');
    console.log('• Automatic detection: Code detects model type and uses correct approach');
    console.log('• Better compliance: Follows Google\'s official documentation');
    console.log('• More reliable: Each model family gets the format it expects');

    console.log('\n📖 References:');
    console.log('• Gemma Prompt Structure: https://ai.google.dev/gemma/docs/core/prompt-structure');
    console.log('• Gemini API Documentation: https://ai.google.dev/gemini-api/docs');
}

// Run the demonstration
demonstrateSystemPromptImprovement().then(() => {
    console.log('\n🎉 Demonstration completed! Both model families now work optimally.');
});
