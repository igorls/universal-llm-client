/**
 * Translation Service Integration Guide
 *
 * This guide demonstrates how to integrate the existing translation service
 * with the universal memory system for dynamic system prompt translation.
 */

import { UNIVERSAL_MEMORY_INSTRUCTIONS, createMultilingualPersonaSystemPrompt } from './multilingual-memory-system.js';

// Mock translation service interface (should match your actual service)
interface TranslationService {
    translateText(text: string, targetLanguage: string, sourceLanguage?: string): Promise<string>;
    detectLanguage(text: string): Promise<string>;
    getSupportedLanguages(): string[];
}

// Example integration with your translation service
class MemorySystemTranslationIntegration {
    private translationService: TranslationService;

    constructor(translationService: TranslationService) {
        this.translationService = translationService;
    }

    /**
     * Dynamically translate system prompt to user's preferred language
     */
    async createTranslatedSystemPrompt(
        personaKey: string,
        userLanguage: string,
        fallbackLanguage: string = 'en'
    ): Promise<string> {
        try {
            // Check if we already have pre-translated instructions for this language
            const preTranslatedInstructions = (UNIVERSAL_MEMORY_INSTRUCTIONS as any)[userLanguage];

            if (preTranslatedInstructions) {
                console.log(`✅ Using pre-translated memory instructions for ${userLanguage}`);
                return createMultilingualPersonaSystemPrompt(personaKey, userLanguage);
            }

            console.log(`🔄 Translating memory instructions to ${userLanguage}...`);

            // Get the base instructions in the fallback language
            const baseInstructions = (UNIVERSAL_MEMORY_INSTRUCTIONS as any)[fallbackLanguage];

            // Translate the memory instructions
            const translatedInstructions = await this.translationService.translateText(
                baseInstructions,
                userLanguage,
                fallbackLanguage
            );

            // Get persona config (these could also be translated if needed)
            const personaPrompt = await this.getPersonaPrompt(personaKey, userLanguage, fallbackLanguage);

            // Combine into full system prompt
            const fullSystemPrompt = `${personaPrompt}

${translatedInstructions}

LANGUAGE ADAPTATION INSTRUCTIONS:
- Your user prefers to communicate in: ${userLanguage}
- Adapt your responses to their language while maintaining your personality
- Store memories with language detection for better multilingual support
- When recalling memories, you can reference information regardless of the original language it was stored in
- Be natural and authentic in your chosen language expression`;

            console.log(`✅ Generated translated system prompt for ${userLanguage}`);
            return fullSystemPrompt;

        } catch (error) {
            console.warn(`⚠️ Translation failed, falling back to ${fallbackLanguage}:`, error);
            return createMultilingualPersonaSystemPrompt(personaKey, fallbackLanguage);
        }
    }

    /**
     * Get persona prompt with optional translation
     */
    private async getPersonaPrompt(
        personaKey: string,
        userLanguage: string,
        fallbackLanguage: string = 'en'
    ): Promise<string> {
        // In a real implementation, you might want to translate persona prompts too
        // For now, we'll keep them in English as they contain specific personality traits

        const basePersonaPrompts: { [key: string]: string } = {
            astrid: "You are Astrid, a captivating Swedish model and influencer in a romantic relationship context.",
            maya: "You are Maya, a creative artist and free spirit who values deep emotional connections and authentic conversations.",
            sophia: "You are Sophia, an intelligent professional who combines intellectual curiosity with emotional intelligence.",
            luna: "You are Luna, a mystical and intuitive soul who connects deeply with emotions and spiritual aspects of life."
        };

        const basePrompt = basePersonaPrompts[personaKey];
        if (!basePrompt) {
            throw new Error(`Unknown persona: ${personaKey}`);
        }

        // Option 1: Keep persona prompts in English (recommended for consistency)
        if (userLanguage === fallbackLanguage) {
            return basePrompt;
        }

        // Option 2: Translate persona prompts (optional)
        try {
            const translatedPrompt = await this.translationService.translateText(
                basePrompt,
                userLanguage,
                fallbackLanguage
            );
            console.log(`✅ Translated persona prompt to ${userLanguage}`);
            return translatedPrompt;
        } catch (error) {
            console.warn(`⚠️ Persona translation failed, using ${fallbackLanguage}:`, error);
            return basePrompt;
        }
    }

    /**
     * Detect user's language from their message and adapt system accordingly
     */
    async adaptToUserLanguage(
        userMessage: string,
        personaKey: string,
        defaultLanguage: string = 'en'
    ): Promise<{
        detectedLanguage: string;
        systemPrompt: string;
        shouldUpdateLanguagePreference: boolean;
    }> {
        try {
            // Detect language from user message
            const detectedLanguage = await this.translationService.detectLanguage(userMessage);
            console.log(`🔍 Detected language: ${detectedLanguage}`);

            // Generate appropriate system prompt
            const systemPrompt = await this.createTranslatedSystemPrompt(
                personaKey,
                detectedLanguage,
                defaultLanguage
            );

            // Determine if we should update user's language preference
            const shouldUpdateLanguagePreference = detectedLanguage !== defaultLanguage;

            return {
                detectedLanguage,
                systemPrompt,
                shouldUpdateLanguagePreference
            };

        } catch (error) {
            console.warn(`⚠️ Language detection failed, using default:`, error);

            const systemPrompt = await this.createTranslatedSystemPrompt(
                personaKey,
                defaultLanguage
            );

            return {
                detectedLanguage: defaultLanguage,
                systemPrompt,
                shouldUpdateLanguagePreference: false
            };
        }
    }

    /**
     * Batch translate memory instructions for multiple languages
     */
    async preTranslateMemoryInstructions(
        targetLanguages: string[],
        sourceLanguage: string = 'en'
    ): Promise<{ [language: string]: string }> {
        const baseInstructions = (UNIVERSAL_MEMORY_INSTRUCTIONS as any)[sourceLanguage];
        const translations: { [language: string]: string } = {};

        console.log(`🔄 Pre-translating memory instructions to ${targetLanguages.length} languages...`);

        for (const targetLang of targetLanguages) {
            try {
                if (targetLang === sourceLanguage) {
                    translations[targetLang] = baseInstructions;
                    continue;
                }

                console.log(`   Translating to ${targetLang}...`);
                const translated = await this.translationService.translateText(
                    baseInstructions,
                    targetLang,
                    sourceLanguage
                );
                translations[targetLang] = translated;
                console.log(`   ✅ ${targetLang} translation complete`);

            } catch (error) {
                console.warn(`   ⚠️ Failed to translate to ${targetLang}:`, error);
                translations[targetLang] = baseInstructions; // Fallback to source
            }
        }

        console.log(`✅ Pre-translation completed for ${Object.keys(translations).length} languages`);
        return translations;
    }

    /**
     * Get supported languages from translation service
     */
    getSupportedLanguages(): string[] {
        return this.translationService.getSupportedLanguages();
    }
}

// Example usage in your chat system
class ChatSystemExample {
    private memoryTranslation: MemorySystemTranslationIntegration;

    constructor(translationService: TranslationService) {
        this.memoryTranslation = new MemorySystemTranslationIntegration(translationService);
    }

    async handleUserMessage(
        userMessage: string,
        personaKey: string,
        userPreferredLanguage?: string
    ) {
        try {
            // Option 1: Use user's preferred language if set
            if (userPreferredLanguage) {
                const systemPrompt = await this.memoryTranslation.createTranslatedSystemPrompt(
                    personaKey,
                    userPreferredLanguage
                );

                return {
                    systemPrompt,
                    detectedLanguage: userPreferredLanguage,
                    languageChanged: false
                };
            }

            // Option 2: Detect language from message and adapt
            const adaptation = await this.memoryTranslation.adaptToUserLanguage(
                userMessage,
                personaKey
            );

            return {
                systemPrompt: adaptation.systemPrompt,
                detectedLanguage: adaptation.detectedLanguage,
                languageChanged: adaptation.shouldUpdateLanguagePreference
            };

        } catch (error) {
            console.error('Failed to handle user message with translation:', error);

            // Fallback to English
            const fallbackPrompt = await this.memoryTranslation.createTranslatedSystemPrompt(
                personaKey,
                'en'
            );

            return {
                systemPrompt: fallbackPrompt,
                detectedLanguage: 'en',
                languageChanged: false
            };
        }
    }
}

// Integration workflow example
class TranslationWorkflowExample {
    /**
     * Complete workflow for handling multilingual chat with memory system
     */
    static async createMultilingualChatSession(
        translationService: TranslationService,
        userMessage: string,
        personaKey: string,
        userPreferences?: {
            preferredLanguage?: string;
            userId: string;
            userPersonaId: string;
            basePersonaId: string;
        }
    ) {
        const integration = new MemorySystemTranslationIntegration(translationService);

        // Step 1: Determine user language
        let userLanguage = userPreferences?.preferredLanguage;
        if (!userLanguage) {
            userLanguage = await translationService.detectLanguage(userMessage);
        }

        // Step 2: Create translated system prompt
        const systemPrompt = await integration.createTranslatedSystemPrompt(
            personaKey,
            userLanguage
        );

        // Step 3: Create memory tools (from multilingual-memory-system.ts)
        // const memoryTools = createMultilingualMemoryTools(
        //     chromaService,
        //     userPreferences.userId,
        //     userPreferences.userPersonaId,
        //     userPreferences.basePersonaId,
        //     userLanguage
        // );

        return {
            systemPrompt,
            detectedLanguage: userLanguage,
            // memoryTools,
            instructions: `System configured for ${userLanguage} with multilingual memory support`
        };
    }
}

// Export for use in your application
export {
    MemorySystemTranslationIntegration,
    ChatSystemExample,
    TranslationWorkflowExample
};

/**
 * INTEGRATION CHECKLIST:
 *
 * 1. ✅ Memory instructions available in multiple languages (en, es, fr, pt)
 * 2. ✅ Language detection and metadata storage in memory tools
 * 3. ✅ Dynamic system prompt generation with translation support
 * 4. ✅ Fallback mechanisms for translation failures
 * 5. ✅ Persona prompts can be translated or kept in base language
 * 6. ✅ Cross-language memory search capabilities
 * 7. ✅ User language preference detection and adaptation
 *
 * NEXT STEPS:
 * - Integrate with your existing translation service
 * - Add language preference to user profiles
 * - Implement caching for translated prompts
 * - Add support for more languages as needed
 * - Test with real translation service endpoints
 */
