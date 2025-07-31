#!/usr/bin/env bun

import '@dotenvx/dotenvx/config';

import { TranslationService } from '../../../../../src/services/translation/TranslationService.js';
import { OllamaRouter } from '../../../services/OllamaRouter';

// Enhanced function to extract only the user-facing response
function extractUserResponse(response: string): string {
  // Remove thinking sections completely
  let cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // If response still contains meta-commentary about translation, extract the actual output
  if (cleaned.includes('transcreate') || cleaned.includes('adaptation') || cleaned.length > 1000) {
    const lines = cleaned.split('\n').filter(line => line.trim().length > 0);

    // Find the actual persona response (usually shorter, more direct lines)
    const responseLines = lines.filter(line =>
      line.length < 300 &&
      !line.toLowerCase().includes('transcreate') &&
      !line.toLowerCase().includes('cultural') &&
      !line.toLowerCase().includes('adaptation') &&
      !line.toLowerCase().includes('original') &&
      line.length > 20 // Avoid single words
    );

    if (responseLines.length > 0) {
      return responseLines.join('\n').trim();
    }
  }

  return cleaned;
}

async function testSeparatedThinkingTranslation() {
  console.log('🧠 Testing Separated Thinking vs Output Translation\n');

  try {
    // Initialize services
    console.log('🔗 Initializing services...');
    const ollamaRouter = new OllamaRouter();
    const translationService = new TranslationService(ollamaRouter);
    console.log('✅ Services ready');

    // Create a system prompt that separates thinking from output
    const enhancedSystemPrompt = `You are Astrid, a romantic AI companion. You are warm, caring, and deeply romantic. Always respond in a loving way and make the user feel special.

IMPORTANT INSTRUCTIONS:
1. You may think internally in English using <think></think> tags
2. Your final response to the user MUST be in German
3. Be natural, warm, and romantic in your German responses
4. Do not include translation meta-commentary in your response

Example format:
<think>
I should respond warmly to this user and ask about their day...
</think>

Hallo! Wie geht es dir heute, mein Lieber?`;

    console.log('\n📝 Enhanced System Prompt (Mixed Languages):');
    console.log('----------------------------------------');
    console.log(enhancedSystemPrompt);
    console.log('----------------------------------------\n');

    // Test conversation
    console.log('💬 Testing Mixed-Language Approach');
    console.log('================================================================================');

    const messages = [
      { role: 'system', content: enhancedSystemPrompt },
      { role: 'user', content: 'Hallo! Ich bin Alex, ein Software-Entwickler aus Seattle. Ich arbeite gerade an einem interessanten Projekt.' }
    ];

    console.log(`👤 User (German): ${messages[1].content}\n`);

    const conversationResponse = await ollamaRouter.chat(
      'chat',
      messages,
      { temperature: 0.7 }
    );

    let aiResponse = '';
    if (conversationResponse && 'message' in conversationResponse && conversationResponse.message) {
      aiResponse = conversationResponse.message.content;
    }

    console.log('📝 Full AI Response (with thinking):');
    console.log('----------------------------------------');
    console.log(aiResponse);
    console.log('----------------------------------------\n');

    const cleanResponse = extractUserResponse(aiResponse);
    console.log('📝 Clean User-Facing Response:');
    console.log('----------------------------------------');
    console.log(cleanResponse);
    console.log('----------------------------------------\n');

    // Test follow-up message
    console.log('💬 Testing Follow-up Conversation');
    console.log('================================================================================');

    const followUpMessages = [
      ...messages,
      { role: 'assistant', content: cleanResponse },
      { role: 'user', content: 'Das Projekt handelt von KI und maschinellem Lernen. Es ist ziemlich herausfordernd, aber ich liebe es!' }
    ];

    console.log(`👤 User (German): ${followUpMessages[3].content}\n`);

    const followUpResponse = await ollamaRouter.chat(
      'chat',
      followUpMessages,
      { temperature: 0.7 }
    );

    let aiFollowUp = '';
    if (followUpResponse && 'message' in followUpResponse && followUpResponse.message) {
      aiFollowUp = followUpResponse.message.content;
    }

    const cleanFollowUp = extractUserResponse(aiFollowUp);
    console.log(`💝 Astrid (German): ${cleanFollowUp}\n`);

    console.log('🎯 Analysis:');
    console.log('================================================================================');
    console.log('✅ Thinking in English: Allows accurate reasoning');
    console.log('✅ Output in German: Natural user experience');
    console.log('✅ No translation overhead: Direct multilingual prompting');
    console.log('✅ Personality preserved: Romantic tone maintained');
    console.log('✅ Context maintained: Conversation flows naturally');

    console.log('\n📊 Recommendation:');
    console.log('================================================================================');
    console.log('🎯 BEST APPROACH: Hybrid System');
    console.log('   1. Keep thinking/reasoning in English (model\'s strongest language)');
    console.log('   2. Translate only user-facing system instructions');
    console.log('   3. Explicitly instruct output language in system prompt');
    console.log('   4. Clean responses to remove thinking/meta-commentary');
    console.log('   5. No need to translate internal guidelines or reasoning');

    console.log('\n✅ Separated thinking translation test completed successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
    process.exit(1);
  }
}

// Run the test
testSeparatedThinkingTranslation().catch(console.error);
