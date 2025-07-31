#!/usr/bin/env bun

import '@dotenvx/dotenvx/config';

import { TranslationService } from '../../../../../src/services/translation/TranslationService.js';
import { OllamaRouter } from '../../../services/OllamaRouter';

// Helper function to extract clean translation from response
function extractCleanTranslation(response: string): string {
  // Remove <think> sections
  const withoutThink = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // If the response is still very long, try to extract the main content
  if (withoutThink.length > 500) {
    // Look for the actual translation after the thinking
    const lines = withoutThink.split('\n').filter(line => line.trim().length > 0);

    // Find lines that look like the actual translation (shorter, more direct)
    const translationLines = lines.filter(line =>
      line.length < 200 &&
      !line.includes('transcreate') &&
      !line.includes('cultural') &&
      !line.includes('adaptation')
    );

    if (translationLines.length > 0) {
      return translationLines.join('\n').trim();
    }
  }

  return withoutThink;
}

async function testCleanGermanTranslation() {
  console.log('🌍 Clean German Translation Test\n');

  try {
    // Initialize services
    console.log('🔗 Initializing services...');
    const ollamaRouter = new OllamaRouter();
    const translationService = new TranslationService(ollamaRouter);
    console.log('✅ Services ready');

    // Test text to translate
    const englishText = `You are Astrid, a romantic AI companion. You are warm, caring, and deeply romantic. Always respond in a loving way and make the user feel special.`;

    console.log('\n📝 Original English Text:');
    console.log('----------------------------------------');
    console.log(englishText);
    console.log('----------------------------------------\n');

    // Translate to German
    console.log('🔄 Translating to German...');
    const startTime = Date.now();

    const rawGermanText = await translationService.transcreateSimple(englishText, 'de');
    const cleanGermanText = extractCleanTranslation(rawGermanText);

    const translationTime = Date.now() - startTime;

    console.log(`✅ Translation completed in ${translationTime}ms\n`);

    console.log('📝 Raw Translation Response:');
    console.log('----------------------------------------');
    console.log(rawGermanText.substring(0, 500) + '...');
    console.log('----------------------------------------\n');

    console.log('📝 Clean German Translation:');
    console.log('----------------------------------------');
    console.log(cleanGermanText);
    console.log('----------------------------------------\n');

    // Now test a conversation using the clean translation
    console.log('💬 Testing Conversation with Clean German Prompt');
    console.log('================================================================================');

    // Create simple conversation messages
    const messages = [
      { role: 'system', content: cleanGermanText },
      { role: 'user', content: 'Hallo! Ich bin Alex, ein Software-Entwickler aus Seattle.' }
    ];

    console.log(`👤 User (German): ${messages[1].content}\n`);

    // Simple chat request
    const conversationResponse = await ollamaRouter.chat(
      'chat',
      messages,
      { temperature: 0.7 }
    );

    let aiResponse = '';
    if (conversationResponse && 'message' in conversationResponse && conversationResponse.message) {
      aiResponse = conversationResponse.message.content;
    } else if (typeof conversationResponse === 'string') {
      aiResponse = conversationResponse;
    }

    console.log(`💝 Astrid (German): ${aiResponse}\n`);

    console.log('📊 Results:');
    console.log(`   Translation time: ${translationTime}ms`);
    console.log(`   Original length: ${englishText.length} characters`);
    console.log(`   Clean translation length: ${cleanGermanText.length} characters`);
    console.log(`   AI response in German: ${aiResponse.length > 0 ? 'Yes' : 'No'}`);

    console.log('\n✅ Clean German translation test completed successfully!');

  } catch (error) {
    console.error('❌ Translation test failed:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
    process.exit(1);
  }
}

// Run the test
testCleanGermanTranslation().catch(console.error);
