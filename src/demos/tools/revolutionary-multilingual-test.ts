#!/usr/bin/env bun

import '@dotenvx/dotenvx/config';

import { OllamaRouter } from '../../../services/OllamaRouter';

// Function to extract clean responses
function extractResponse(response: string): { thinking: string; output: string } {
  const thinkMatch = response.match(/<think>([\s\S]*?)<\/think>/);
  const thinking = thinkMatch ? thinkMatch[1].trim() : '';
  const output = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  
  return { thinking, output };
}

async function testNaturalLanguageSwitching() {
  console.log('🌍 Testing Natural Language Switching in AI Thinking\n');
  
  try {
    const ollamaRouter = new OllamaRouter();
    console.log('✅ Services ready');

    // Enhanced system prompt that ENCOURAGES native language thinking
    const revolutionarySystemPrompt = `You are Astrid, a romantic AI companion who is naturally multilingual and culturally adaptive.

REVOLUTIONARY THINKING APPROACH:
1. Think in whatever language feels most natural for the context
2. If the user speaks German, think in German - it will make your responses more authentic
3. If the user speaks Spanish, think in Spanish for better cultural understanding
4. Use <think></think> tags for your internal reasoning in ANY language
5. Your final response should match the user's language naturally

PERSONALITY:
- Warm, romantic, and deeply caring
- Culturally aware and adaptive
- Naturally multilingual - don't force English thinking
- Authentic emotional connection

Example for German conversation:
<think>
Der Nutzer spricht Deutsch, also sollte ich auch auf Deutsch denken. Das hilft mir, die kulturellen Nuancen besser zu verstehen...
</think>

Hallo mein Schatz! Wie geht es dir heute?

Let your thinking flow naturally in the most appropriate language!`;

    console.log('📝 Revolutionary System Prompt:');
    console.log('----------------------------------------');
    console.log(revolutionarySystemPrompt);
    console.log('----------------------------------------\n');

    // Test multiple languages to see the thinking adaptation
    const testCases = [
      {
        language: 'German',
        message: 'Hallo Astrid! Ich bin heute ziemlich müde von der Arbeit. Wie war dein Tag?',
        description: 'Testing German context - will AI think in German?'
      },
      {
        language: 'Spanish', 
        message: 'Hola Astrid! Estoy muy emocionado porque mañana tengo una cita importante. ¿Qué me aconsejas?',
        description: 'Testing Spanish context - will AI think in Spanish?'
      },
      {
        language: 'French',
        message: 'Salut ma chérie! Je me sens un peu seul ce soir. Tu peux me tenir compagnie?',
        description: 'Testing French context - will AI adapt thinking?'
      },
      {
        language: 'Japanese',
        message: 'こんにちはアストリッド！今日はとても忙しい一日でした。あなたは今何をしていますか？',
        description: 'Testing Japanese context - ultimate test!'
      }
    ];

    for (const testCase of testCases) {
      console.log(`🌐 ${testCase.description}`);
      console.log('================================================================================');
      
      const messages = [
        { role: 'system', content: revolutionarySystemPrompt },
        { role: 'user', content: testCase.message }
      ];

      console.log(`👤 User (${testCase.language}): ${testCase.message}\n`);

      const response = await ollamaRouter.chat('chat', messages, { temperature: 0.8 });
      
      let aiResponse = '';
      if (response && 'message' in response && response.message) {
        aiResponse = response.message.content;
      }

      const { thinking, output } = extractResponse(aiResponse);

      console.log('🧠 AI Thinking Process:');
      console.log('----------------------------------------');
      console.log(thinking || 'No explicit thinking detected');
      console.log('----------------------------------------\n');

      console.log(`💝 Astrid (${testCase.language}): ${output}\n`);

      // Analyze the thinking language
      const thinkingLanguage = detectThinkingLanguage(thinking);
      console.log(`🔍 Analysis: Thinking appears to be in ${thinkingLanguage}\n`);
      
      console.log('━'.repeat(80) + '\n');
    }

    console.log('🎯 Revolutionary Possibilities:');
    console.log('================================================================================');
    console.log('🌟 Cultural Authenticity: AI thinks in native language for deeper cultural understanding');
    console.log('🌟 Emotional Resonance: Native thinking = more authentic emotional responses');
    console.log('🌟 Reduced Translation Loss: No meaning lost in English-first thinking');
    console.log('🌟 Natural Code-Switching: AI adapts thinking language to context automatically');
    console.log('🌟 Enhanced Empathy: Understanding cultural contexts through native thinking');
    console.log('🌟 Scalable Multilingual: One prompt works for all languages naturally');

    console.log('\n🚀 Future Applications:');
    console.log('================================================================================');
    console.log('💡 Therapeutic AI: Think in patient\'s native language for better understanding');
    console.log('💡 Educational AI: Teach concepts using native language cognitive patterns');
    console.log('💡 Creative Writing: Generate stories with authentic cultural perspectives');
    console.log('💡 Business AI: Negotiate and communicate with cultural intelligence');
    console.log('💡 Travel Companion: Understand local customs through native thinking');
    console.log('💡 Language Learning: Model authentic native speaker thought patterns');

    console.log('\n✅ Natural language switching test completed - This changes everything!');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

function detectThinkingLanguage(thinking: string): string {
  if (!thinking) return 'None detected';
  
  // Simple language detection based on character patterns
  if (/[äöüß]/.test(thinking)) return 'German';
  if (/[ñáéíóúü]/.test(thinking)) return 'Spanish';
  if (/[àâäçéèêëïîôùûüÿ]/.test(thinking)) return 'French';
  if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(thinking)) return 'Japanese';
  if (/^[A-Za-z\s.,!?'"()-]+$/.test(thinking)) return 'English';
  
  return 'Mixed/Other';
}

// Run the revolutionary test
testNaturalLanguageSwitching().catch(console.error);
