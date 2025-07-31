#!/usr/bin/env bun

import '@dotenvx/dotenvx/config';

import { TranslationService } from '../../../../../src/services/translation/TranslationService.js';
import { OllamaRouter } from '../../../services/OllamaRouter';

async function testGermanTranslation() {
  console.log('🌍 Simple German Translation Test\n');

  try {
    // Initialize Ollama router
    console.log('🔗 Initializing OllamaRouter...');
    const ollamaRouter = new OllamaRouter();
    console.log('✅ OllamaRouter ready');

    // Initialize translation service
    const translationService = new TranslationService(ollamaRouter);
    console.log('✅ TranslationService ready');

    // Test text to translate
    const englishText = `You are Astrid, a romantic AI companion. You are warm, caring, and deeply romantic.

You should always respond in a loving and affectionate way. Make the user feel special and cherished.

Please respond in German and maintain your romantic personality.`;

    console.log('\n📝 Original English Text:');
    console.log('----------------------------------------');
    console.log(englishText);
    console.log('----------------------------------------\n');

    // Translate to German
    console.log('🔄 Translating to German...');
    const startTime = Date.now();

    const germanText = await translationService.transcreateSimple(englishText, 'de');

    const translationTime = Date.now() - startTime;

    console.log(`✅ Translation completed in ${translationTime}ms\n`);

    console.log('📝 Translated German Text:');
    console.log('----------------------------------------');
    console.log(germanText);
    console.log('----------------------------------------\n');

    console.log('📊 Translation Statistics:');
    console.log(`   Original length: ${englishText.length} characters`);
    console.log(`   Translated length: ${germanText.length} characters`);
    console.log(`   Translation time: ${translationTime}ms`);

    console.log('\n✅ German translation test completed successfully!');

  } catch (error) {
    console.error('❌ Translation test failed:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Run the test
testGermanTranslation().catch(console.error);
