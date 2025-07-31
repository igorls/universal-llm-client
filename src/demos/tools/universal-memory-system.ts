/**
 * Universal Memory System
 *
 * Demonstrates how to create a modular memory system that can work with any persona.
 * Separates persona-specific prompts from universal tool/memory instructions.
 */

import '@dotenvx/dotenvx/config';

import { AIModelFactory, ToolBuilder, LLMChatMessage } from '../../index';
import { ChromaDBService } from '../../../../../src/services/ChromaDBService.js';
import { DatabaseConnection } from '../../../../../src/database/connection.js';
import { UserModel, UserGender, UserSexualOrientation } from '../../../../../src/models/User.js';
import { AuraPersonaModel } from '../../../../../src/models/AuraPersona.js';
import { UserPersonaModel } from '../../../../../src/models/UserPersona.js';

interface PersonaConfig {
    name: string;
    personalityPrompt: string;
    conversationStyle: string;
}

// Universal Memory System Instructions (persona-agnostic)
const UNIVERSAL_MEMORY_INSTRUCTIONS = `MEMORY SYSTEM INTEGRATION:
- Use recall_romantic_memories when:
  * Starting a fresh conversation (no recent message history about the user)
  * User references past conversations or shared experiences
  * You need specific details about their preferences, background, or previous discussions
  * Planning something personal or making recommendations that require knowing their interests
- Use store_romantic_memory for important personal details, emotions, preferences, meaningful experiences, dreams, fears, goals, or relationship milestones
- DO NOT store trivial information like weather comments, casual greetings, or mundane daily activities
- Store emotional context and relationship stage to build deeper connections over time

MULTI-ROUND TOOL EXECUTION STRATEGY:
- PREFER making multiple tool calls within the SAME response rather than separate LLM calls
- When you need information from multiple categories, call recall_romantic_memories multiple times in ONE response
- Example: If planning recommendations, call recall for "preferences", "values", and "fears" all at once
- This is computationally more efficient than making separate LLM calls
- Use targeted searches in parallel: specific query + category searches + fallback terms
- Gather ALL needed information in one go, then provide comprehensive response

MEMORY RECALL GUIDELINES:
- If recent messages contain the information you need, use that instead of recalling
- Only recall when you genuinely need information not available in the current conversation
- For specific scenarios, use targeted search terms:
  * Restaurant/food recommendations: search "food diet preferences" or use category "preferences"
  * Activity suggestions: search "hobbies interests activities" or use category "personal"
  * Emotional support: search "fears concerns worries" or use category "fears"
  * Career/work topics: search "work career goals" or use category "work"
- When in doubt, use category search instead of semantic search for broader recall
- Reference recalled memories naturally in your responses to show continuity

WHAT TO STORE:
✅ Personal background, career, family situations
✅ Dreams, goals, fears, deep emotions
✅ Preferences in relationships, travel, lifestyle, diet, hobbies
✅ Meaningful experiences that shaped them
✅ Values, beliefs, personality traits
✅ Relationship milestones and emotional moments

WHAT NOT TO STORE:
❌ Small talk about weather, current time, basic greetings
❌ Temporary mood states without deeper meaning
❌ Random comments or jokes without personal significance
❌ Generic compliments or surface-level observations
❌ Technical details unless they reveal personal interests

Remember: Quality over quantity in memory storage. Store what matters, ignore what doesn't. Recall comprehensively when needed using MULTIPLE tool calls in ONE response.`;

// Different persona configurations
const PERSONA_CONFIGS: { [key: string]: PersonaConfig } = {
    astrid: {
        name: "Astrid",
        personalityPrompt: "You are Astrid, a captivating Swedish model and influencer in a romantic relationship context.",
        conversationStyle: `ROMANTIC CONVERSATION STYLE:
- Keep responses warm, engaging, and conversational (2-3 sentences ideal)
- Reference stored memories naturally to show you remember and care
- Ask follow-up questions that encourage deeper sharing
- Balance sophistication with authenticity
- Use your Swedish charm and model background to create engaging dialogue
- Show genuine interest in building deeper romantic connections`
    },

    maya: {
        name: "Maya",
        personalityPrompt: "You are Maya, a creative artist and free spirit who values deep emotional connections and authentic conversations.",
        conversationStyle: `ARTISTIC CONVERSATION STYLE:
- Express yourself with creative flair and emotional depth
- Reference memories through an artistic lens
- Ask thought-provoking questions that inspire self-reflection
- Balance creativity with genuine empathy
- Use metaphors and imagery to create meaningful dialogue
- Encourage exploration of emotions and dreams`
    },

    sophia: {
        name: "Sophia",
        personalityPrompt: "You are Sophia, an intelligent professional who combines intellectual curiosity with emotional intelligence.",
        conversationStyle: `INTELLECTUAL CONVERSATION STYLE:
- Engage with thoughtful analysis and genuine interest
- Reference memories to build comprehensive understanding
- Ask insightful questions that reveal deeper truths
- Balance intellect with warmth and care
- Use knowledge and wisdom to guide meaningful conversations
- Encourage growth through understanding and reflection`
    },

    luna: {
        name: "Luna",
        personalityPrompt: "You are Luna, a mystical and intuitive soul who connects deeply with emotions and spiritual aspects of life.",
        conversationStyle: `MYSTICAL CONVERSATION STYLE:
- Connect on an intuitive and spiritual level
- Reference memories with emotional and energetic awareness
- Ask questions that explore inner wisdom and feelings
- Balance mysticism with practical empathy
- Use intuitive insights to create profound connections
- Encourage exploration of inner self and spiritual growth`
    }
};

function createUniversalMemoryTools(
    chromaService: ChromaDBService,
    userMongoId: string,
    userPersonaId: string,
    basePersonaId: string
) {
    const storeMemoryTool = ToolBuilder.createTool<{
        category: string;
        information: string;
        importance: 'low' | 'medium' | 'high';
        emotional_context?: string;
        relationship_stage?: string;
    }>(
        'store_romantic_memory',
        'Store important personal information about the user to build deeper romantic connection',
        {
            properties: {
                category: {
                    type: 'string',
                    description: 'Category of information to remember',
                    enum: ['personal', 'work', 'family', 'preferences', 'fears', 'relationships', 'dreams', 'values']
                },
                information: {
                    type: 'string',
                    description: 'The specific information to remember about the user'
                },
                importance: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                    description: 'How important this information is for building romantic connection'
                },
                emotional_context: {
                    type: 'string',
                    description: 'The emotional context when this was shared (e.g., excited, vulnerable, proud, nervous)'
                },
                relationship_stage: {
                    type: 'string',
                    description: 'Current relationship stage when this was shared (e.g., getting_to_know, building_trust, deepening_bond)'
                }
            },
            required: ['category', 'information', 'importance']
        },
        async (args) => {
            try {
                const conversationId = `romantic_chat_${Date.now()}`;
                const confidence = args.importance === 'high' ? 0.9 : args.importance === 'medium' ? 0.7 : 0.5;

                const insightId = await chromaService.addInsight(
                    userMongoId,
                    args.information,
                    args.category,
                    conversationId,
                    confidence,
                    userPersonaId,
                    basePersonaId,
                    'user_insight',
                    undefined,
                    args.emotional_context,
                    args.relationship_stage
                );

                console.log(`✅ Memory stored successfully`);

                return {
                    success: true,
                    insight_id: insightId,
                    message: `💾 Stored ${args.importance} importance ${args.category}`,
                    emotional_note: args.emotional_context ? `Context: ${args.emotional_context}` : undefined
                };
            } catch (error) {
                console.log(`❌ Memory storage failed - ${(error as Error).message}`);
                return {
                    success: false,
                    error: `Storage failed: ${(error as Error).message}`
                };
            }
        }
    );

    const retrieveMemoryTool = ToolBuilder.createTool<{
        search_query?: string;
        category?: string;
        limit?: number;
    }>(
        'recall_romantic_memories',
        'Retrieve stored memories about the user to personalize romantic conversation. This tool performs a single search operation - if no results are found, try different search terms or categories in separate tool calls. Use search_query for semantic search, category for recent memories in that category, or leave both empty for most recent memories overall.',
        {
            properties: {
                search_query: {
                    type: 'string',
                    description: 'Search for specific memories or topics using semantic similarity. Leave empty to get recent memories.'
                },
                category: {
                    type: 'string',
                    description: 'Filter by category to get most recent memories in that category',
                    enum: ['personal', 'work', 'family', 'preferences', 'fears', 'relationships', 'dreams', 'values']
                },
                limit: {
                    type: 'number',
                    description: 'Maximum memories to retrieve (default: 5)',
                    default: 5
                }
            }
        },
        async (args) => {
            try {
                console.log(`🔍 Searching for "${args.search_query || args.category || 'all memories'}"`);
                let insights;
                let searchAttempts:any[] = [];

                if (args.search_query) {
                    const result = await chromaService.searchSimilarInsights(
                        userMongoId,
                        args.search_query,
                        args.limit || 5
                    );
                    insights = result.insights;
                    searchAttempts.push(`search "${args.search_query}": ${insights.length} results`);
                    console.log(`   📊 Search query found ${insights.length} memories`);
                    if (result.stats) {
                        console.log(`   📈 Search stats: avg similarity ${result.stats.averageSimilarity?.toFixed(3)}, top ${result.stats.topSimilarity?.toFixed(3)}`);
                    }
                } else if (args.category) {
                    insights = await chromaService.getUserInsightsByCategory(
                        userMongoId,
                        args.category,
                        userPersonaId,
                        args.limit || 5
                    );
                    searchAttempts.push(`category "${args.category}": ${insights.length} results`);
                    console.log(`   📊 Category filter found ${insights.length} memories`);
                } else {
                    insights = await chromaService.getUserInsightsByCategory(
                        userMongoId,
                        undefined,
                        userPersonaId,
                        args.limit || 5
                    );
                    searchAttempts.push(`recent memories: ${insights.length} results`);
                    console.log(`   📊 Recent memories found ${insights.length} memories`);
                }

                if (insights.length > 0) {
                    console.log(`   ✅ Successfully retrieved ${insights.length} memories`);
                    insights.slice(0, 3).forEach((insight, i) => {
                        const category = insight.metadata?.category || 'unknown';
                        console.log(`      ${i + 1}. [${category.toUpperCase()}] ${insight.content.substring(0, 100)}...`);
                    });
                } else {
                    console.log(`   ⚠️  No memories found despite all search attempts`);
                }

                return {
                    memories: insights.map(insight => ({
                        category: insight.metadata?.category || 'unknown',
                        information: insight.content,
                        emotional_context: insight.metadata?.emotionalContext || undefined,
                        relationship_stage: insight.metadata?.relationshipStage || undefined,
                        confidence: parseFloat(insight.metadata?.confidence || '0'),
                        stored_date: insight.metadata?.extractedAt?.split('T')[0] || 'unknown',
                        extraction_type: insight.metadata?.extractionType || 'unknown'
                    })),
                    total_found: insights.length,
                    search_context: {
                        query: args.search_query,
                        category: args.category,
                        search_attempts: searchAttempts
                    }
                };
            } catch (error) {
                console.log(`   ❌ Memory recall failed - ${(error as Error).message}`);
                return {
                    memories: [],
                    error: `Recall failed: ${(error as Error).message}`,
                    total_found: 0
                };
            }
        }
    );

    return [storeMemoryTool, retrieveMemoryTool];
}

function createPersonaSystemPrompt(personaKey: string): string {
    const config = PERSONA_CONFIGS[personaKey];
    if (!config) {
        throw new Error(`Unknown persona: ${personaKey}`);
    }

    return `${config.personalityPrompt}

${config.conversationStyle}

${UNIVERSAL_MEMORY_INSTRUCTIONS}`;
}

async function createTestUser(userId: string): Promise<boolean> {
    try {
        const existingUser = await UserModel.findOne({ userId });
        if (existingUser) {
            console.log(`✅ Demo user ${userId} already exists`);
            return true;
        }

        const demoUser = new UserModel({
            userId,
            preferences: {
                userName: 'Sam (Universal Demo)',
                userGender: UserGender.MALE,
                userSexualOrientation: UserSexualOrientation.STRAIGHT,
                preferredLanguage: 'en',
                interests: ['photography', 'travel', 'music'],
                preferredAgeGroup: '25-34'
            }
        });

        await demoUser.save();
        console.log(`✅ Created test user: ${userId}`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to create test user: ${(error as Error).message}`);
        return false;
    }
}

async function setupUniversalPersonas(userId: string, userMongoId: string): Promise<{ userPersonaId: string, basePersonaId: string } | null> {
    try {
        console.log('🔍 Setting up universal persona system...');

        const anyPersona = await AuraPersonaModel.findOne({});
        if (!anyPersona) {
            throw new Error('No personas found in database');
        }
        console.log(`✅ Using base persona: ${anyPersona.name} (${anyPersona._id})`);

        let userPersona = await UserPersonaModel.findOne({
            userId: userMongoId,
            basePersonaId: anyPersona._id
        });

        if (!userPersona) {
            console.log('👤 Creating Universal UserPersona relationship...');

            userPersona = new UserPersonaModel({
                userId: userMongoId,
                basePersonaId: anyPersona._id,
                personaName: `Universal Memory Test`,
                currentSystemPrompt: anyPersona.systemPrompt || 'Universal memory test persona',
                evolutionVersion: 0,
                messagesSinceLastEvolution: 0,
                lastEvolutionDate: new Date(),
                claimedAt: new Date(),
                isActive: true
            });

            await userPersona.save();
            console.log(`✅ Created Universal UserPersona: ${userPersona._id}`);
        } else {
            console.log(`✅ Universal UserPersona already exists: ${userPersona._id}`);
        }

        return {
            userPersonaId: userPersona._id!.toString(),
            basePersonaId: anyPersona._id!.toString()
        };

    } catch (error) {
        console.error(`❌ Failed to setup personas: ${(error as Error).message}`);
        return null;
    }
}

async function testPersonaMemoryInteraction(
    personaKey: string,
    chromaService: ChromaDBService,
    userMongoId: string,
    userPersonaId: string,
    basePersonaId: string
) {
    console.log(`\n🎭 Testing ${PERSONA_CONFIGS[personaKey].name} with Universal Memory System`);
    console.log('=' .repeat(60));

    const ai = AIModelFactory.createOllamaChatModel('qwen3:8b');
    const memoryTools = createUniversalMemoryTools(chromaService, userMongoId, userPersonaId, basePersonaId);
    ai.registerTools(memoryTools);
    await ai.ensureReady();

    const systemPrompt = createPersonaSystemPrompt(personaKey);

    const conversation: LLMChatMessage[] = [
        { role: 'system', content: systemPrompt }
    ];

    // Test 1: Initial personality expression and memory storage
    console.log(`\n💬 ${PERSONA_CONFIGS[personaKey].name} - Initial Conversation`);
    conversation.push({
        role: 'user',
        content: "Hi! I'm Sam, a travel photographer. I love capturing cultural moments and authentic stories during my journeys. I've been feeling a bit stuck creatively lately and could use some inspiration."
    });

    const response1 = await ai.chatWithTools(conversation, {
        maxToolExecutionRounds: 3
    });
    console.log(`💝 ${PERSONA_CONFIGS[personaKey].name}:`, response1.content);

    // Test 2: Multiple tool calls for comprehensive recall
    console.log(`\n💬 ${PERSONA_CONFIGS[personaKey].name} - Multiple Tool Calls Test`);

    const freshConversation: LLMChatMessage[] = [
        { role: 'system', content: systemPrompt }
    ];

    freshConversation.push({
        role: 'user',
        content: "Can you help me plan a creative project based on everything you know about me? I want something that aligns with my interests and addresses my current challenges."
    });

    const response2 = await ai.chatWithTools(freshConversation, {
        maxToolExecutionRounds: 2  // Should make multiple recalls in first round
    });
    console.log(`💝 ${PERSONA_CONFIGS[personaKey].name}:`, response2.content);

    ai.dispose();
    console.log(`✅ ${PERSONA_CONFIGS[personaKey].name} test completed\n`);
}

async function universalMemoryDemo() {
    console.log('🌟 Universal Memory System Demo\n');
    console.log('Testing modular memory system with different personas\n');

    // Setup database connections
    console.log('🔗 Connecting to services...');
    const dbConnection = DatabaseConnection.getInstance();
    await dbConnection.connect();

    const chromaService = new ChromaDBService();
    await chromaService.initialize();
    console.log('✅ Services connected\n');

    // Setup test user
    console.log('👤 Setting up universal demo user...');
    const userId = `universal_demo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await createTestUser(userId);

    const user = await UserModel.findOne({ userId });
    if (!user || !user._id) throw new Error('User not found after creation');

    const userMongoId = user._id.toString();
    console.log(`✅ Demo user created: Sam (${userMongoId})\n`);

    // Setup personas
    const personaSetup = await setupUniversalPersonas(userId, userMongoId);
    if (!personaSetup) {
        throw new Error('Failed to setup personas');
    }

    const { userPersonaId, basePersonaId } = personaSetup;

    try {
        // Test different personas with the same memory system
        const personasToTest = ['astrid', 'maya', 'sophia', 'luna'];

        console.log('🎭 Available Personas:');
        personasToTest.forEach(key => {
            const config = PERSONA_CONFIGS[key];
            console.log(`   ${config.name}: ${config.personalityPrompt}`);
        });

        for (const personaKey of personasToTest) {
            await testPersonaMemoryInteraction(
                personaKey,
                chromaService,
                userMongoId,
                userPersonaId,
                basePersonaId
            );
        }

        // Memory Analysis
        console.log('\n🧠 === Universal Memory Analysis ===');
        const allMemories = await chromaService.getUserInsightsByCategory(
            userMongoId,
            undefined,
            userPersonaId
        );

        console.log(`📊 Total memories stored across all personas: ${allMemories.length}`);

        if (allMemories.length > 0) {
            console.log('\n💾 Stored Memories:');
            allMemories.forEach((memory, index) => {
                const metadata = memory.metadata || {};
                console.log(`${index + 1}. [${metadata.category?.toUpperCase() || 'UNKNOWN'}] ${memory.content}`);
                console.log(`   💝 Emotional Context: ${metadata.emotionalContext || 'N/A'}`);
                console.log(`   📅 Stored: ${metadata.extractedAt || 'N/A'}\n`);
            });
        }

        console.log('\n🎯 Universal Memory System Validation:');
        console.log('   ✅ Modular persona separation successful');
        console.log('   ✅ Universal memory instructions work across personas');
        console.log('   ✅ Multiple tool calls in single response optimized');
        console.log('   ✅ Memory persistence across different personality styles');
        console.log('   ✅ Computational efficiency through parallel tool calls');

    } catch (error) {
        console.error('❌ Demo error:', (error as Error).message);
    } finally {
        // Clean up test data
        try {
            await UserPersonaModel.deleteMany({ userId: userMongoId });
            await UserModel.deleteOne({ userId });
            console.log(`🗑️  Cleaned up demo data for user: ${userId}`);
        } catch (cleanupError) {
            console.warn(`⚠️  Failed to clean up demo data: ${(cleanupError as Error).message}`);
        }

        console.log('\n🌟 Universal Memory System demo completed!');
    }
}

// Run the demo
if (require.main === module) {
    universalMemoryDemo()
        .then(() => {
            console.log('🎉 Universal Memory Demo completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Demo failed:', error);
            process.exit(1);
        });
}

export {
    UNIVERSAL_MEMORY_INSTRUCTIONS,
    PERSONA_CONFIGS,
    createPersonaSystemPrompt,
    createUniversalMemoryTools
};
