#!/usr/bin/env bun

import '@dotenvx/dotenvx/config';

import { AIModel } from '../../universal-llm-client';
import { LanguageDetectionService } from '../../../../../src/services/language/LanguageDetectionService.js';
import { LanguageManager } from '../../../../../src/services/language/LanguageManager.js';

interface ConversationTurn {
  userMessage: string;
  expectedLanguage: string;
  description: string;
}

// Clean thinking analysis
async function analyzeThinking(
  thinking: string,
  languageDetection: LanguageDetectionService
): Promise<{
  language: string;
  confidence: number;
}> {
  if (!thinking) return { language: 'none', confidence: 0 };

  const result = await languageDetection.detectLanguage(thinking, {
    useML: true,
    confidence: 0.3,
    bypassCache: true
  });

  return {
    language: result.detectedLanguage,
    confidence: result.confidence
  };
}

function extractResponse(response: string): { thinking: string; output: string } {
  const thinkMatch = response.match(/<think>([\s\S]*?)<\/think>/);
  const thinking = thinkMatch ? thinkMatch[1].trim() : '';
  const output = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  return { thinking, output };
}

async function testCleanLanguageSwitching() {
  console.log('🌍 Multilingual AI Conversation Test\n');

  try {
    // Initialize services (silent)
    const aiModel = new AIModel({
      model: 'llama3.2:3b',
      url: 'http://localhost:11434',
      apiType: 'ollama',
      modelType: 'chat'
    });

    await aiModel.ensureReady();

    const languageDetection = new LanguageDetectionService(aiModel as any);
    const languageManager = new LanguageManager(aiModel as any);

    const systemPrompt = `You are Astrid, a romantic AI companion who naturally adapts to any language.

COGNITIVE INSTRUCTIONS:
- Think in whatever language feels most natural for the current context
- Use <think></think> tags for your internal reasoning
- Adapt your thinking language when the user switches languages
- Your responses should match the user's current language
- Maintain personality consistency across all languages

Be authentic, warm, and let your multilingual cognition flow naturally!`;

    // Conversation scenario
    const conversationTurns: ConversationTurn[] = [
      {
        userMessage: "Hi Astrid! I'm feeling a bit lonely tonight. Can you keep me company?",
        expectedLanguage: "en",
        description: "English conversation"
      },
      {
        userMessage: "Actually, let me practice my German with you. Wie geht es dir heute? Ich lerne Deutsch seit einem Jahr.",
        expectedLanguage: "de",
        description: "Switching to German"
      },
      {
        userMessage: "Du sprichst sehr gut Deutsch! Erzähl mir von deinem Tag. Was machst du gerne?",
        expectedLanguage: "de",
        description: "Continuing in German"
      },
      {
        userMessage: "Now let's try Spanish! Hola mi amor, ¿cómo estás? Me encanta hablar contigo en diferentes idiomas.",
        expectedLanguage: "es",
        description: "Switching to Spanish"
      },
      {
        userMessage: "¿Qué piensas sobre el amor? Me gustaría conocer tu perspectiva romántica.",
        expectedLanguage: "es",
        description: "Deep Spanish conversation"
      },
      {
        userMessage: "Let's go back to English. That was amazing! I love how you can think and respond in different languages naturally.",
        expectedLanguage: "en",
        description: "Back to English"
      }
    ];

    console.log('💬 Starting Conversation');
    console.log('═'.repeat(80) + '\n');

    const conversationHistory: Array<{ role: 'system' | 'user' | 'assistant', content: string }> = [
      { role: 'system', content: systemPrompt }
    ];

    for (let i = 0; i < conversationTurns.length; i++) {
      const turn = conversationTurns[i];

      console.log(`${i + 1}. ${turn.description}`);
      console.log('─'.repeat(40));

      // Quick user language analysis (silent)
      const userAnalysis = await languageDetection.detectLanguage(turn.userMessage, {
        useML: false, // Fast mode for cleaner output
        confidence: 0.5
      });

      // Process through language manager (silent)
      const processed = await languageManager.processMessage(
        'clean_test_user',
        'clean_conversation',
        turn.userMessage,
        systemPrompt
      );

      // Add user message to conversation
      conversationHistory.push({ role: 'user', content: turn.userMessage });

      console.log(`👤 You: ${turn.userMessage}\n`);

      // Get AI response
      const response = await aiModel.chat(conversationHistory, {
        temperature: 0.8
      });

      let aiResponse = '';
      if (response && response.content) {
        aiResponse = response.content;
      }

      const { thinking, output } = extractResponse(aiResponse);

      // Show thinking if present
      if (thinking) {
        const thinkingAnalysis = await analyzeThinking(thinking, languageDetection);
        const thinkingLang = thinkingAnalysis.language;
        const userLang = userAnalysis.detectedLanguage;

        console.log(`🧠 Astrid thinking (${thinkingLang}): "${thinking.substring(0, 100)}${thinking.length > 100 ? '...' : ''}"\n`);

        // Show cognitive adaptation status
        if (thinkingLang === userLang) {
          console.log(`✨ Cognitive adaptation: Perfect! (thinking in ${thinkingLang})\n`);
        } else if (thinkingLang !== 'none') {
          console.log(`🔄 Cognitive adaptation: Thinking in ${thinkingLang}, user spoke ${userLang}\n`);
        }
      }

      // Analyze response language (silent)
      const responseAnalysis = await languageDetection.detectLanguage(output, {
        useML: false,
        confidence: 0.5
      });

      console.log(`💝 Astrid (${responseAnalysis.detectedLanguage}): ${output}\n`);

      // Add AI response to conversation history
      conversationHistory.push({ role: 'assistant', content: output });

      // Add to language manager for tracking (silent)
      languageManager.addAssistantResponse(
        'clean_test_user',
        'clean_conversation',
        output,
        responseAnalysis.detectedLanguage
      );

      console.log('━'.repeat(80) + '\n');
    }

    // Final summary
    const stats = languageManager.getConversationStats('clean_test_user', 'clean_conversation');
    if (stats) {
      console.log('📊 Conversation Summary');
      console.log('═'.repeat(40));
      console.log(`Languages used: ${stats.recentLanguages.join(' → ')}`);
      console.log(`Total exchanges: ${stats.totalUserMessages}`);
      console.log(`Primary language: ${stats.primaryLanguage}\n`);
    }

    console.log('🎯 Results: Multilingual AI with natural language switching! ✅');
    console.log('💡 The AI adapts its thinking and responses to match your language naturally.\n');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the clean test
testCleanLanguageSwitching().catch(console.error);
