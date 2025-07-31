/**
 * Astrid Memory System Demo
 *
 * Demonstrates memory storage and recall in realistic conversation scenarios
 * using production ChromaDB and MongoDB services.
 */

import '@dotenvx/dotenvx/config';

import { AIModelFactory, ToolBuilder, LLMChatMessage } from '../../index';

// Import the real ChromaDBService for production testing
import { ChromaDBService } from '../../../../../src/services/ChromaDBService.js';
import { DatabaseConnection } from '../../../../../src/database/connection.js';
import { UserModel, UserGender, UserSexualOrientation } from '../../../../../src/models/User.js';
import { AuraPersonaModel } from '../../../../../src/models/AuraPersona.js';
import { UserPersonaModel } from '../../../../../src/models/UserPersona.js';

function createProductionMemoryTools(
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
                    enum: ['personal', 'work', 'family', 'preferences', 'fears', 'relationships']
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
                    userPersonaId, // Use real UserPersona ID
                    basePersonaId, // Use real AuraPersona ID
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
        'Retrieve stored memories about the user to personalize romantic conversation. Use search_query for semantic search, category for recent memories in that category, or leave both empty for most recent memories overall.',
        {
            properties: {
                search_query: {
                    type: 'string',
                    description: 'Search for specific memories or topics using semantic similarity. Leave empty to get recent memories.'
                },
                category: {
                    type: 'string',
                    description: 'Filter by category to get most recent memories in that category',
                    enum: ['personal', 'work', 'family', 'preferences', 'fears', 'relationships']
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

                if (args.search_query) {
                    const result = await chromaService.searchSimilarInsights(
                        userMongoId,
                        args.search_query,
                        args.limit || 5
                        // Using optimized similarity threshold from ChromaDBService (0.0)
                    );
                    insights = result.insights;
                    console.log(`   📊 Search query found ${insights.length} memories`);
                    console.log(`   🔍 Search stats: avg similarity ${result.stats?.averageSimilarity?.toFixed(3)}, top ${result.stats?.topSimilarity?.toFixed(3)}`);
                } else if (args.category) {
                    insights = await chromaService.getUserInsightsByCategory(
                        userMongoId,
                        args.category,
                        userPersonaId, // Use real UserPersona ID
                        args.limit || 5
                    );
                    console.log(`   📊 Category filter found ${insights.length} memories`);
                } else {
                    // No search query or category - get most recent memories across all categories
                    insights = await chromaService.getUserInsightsByCategory(
                        userMongoId,
                        undefined, // all categories
                        userPersonaId, // Use real UserPersona ID
                        args.limit || 5
                    );
                    console.log(`   📊 Recent memories found ${insights.length} memories`);
                }

                if (insights.length > 0) {
                    console.log(`   ✅ Successfully retrieved ${insights.length} memories`);
                    insights.slice(0, 3).forEach((insight, i) => {
                        console.log(`      ${i + 1}. [${insight.category}] ${insight.content.substring(0, 60)}...`);
                    });
                } else {
                    console.log(`   ⚠️  No memories found for this search`);
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
                        category: args.category
                    }
                };
            } catch (error) {
                console.log(`   ❌ Memory recall failed - ${(error as Error).message}`);
                return {
                    memories: [],
                    error: `Recall test failed: ${(error as Error).message}`,
                    total_found: 0
                };
            }
        }
    );

    return [storeMemoryTool, retrieveMemoryTool];
}

async function createTestUser(userId: string): Promise<boolean> {
    try {
        // Check if user already exists
        const existingUser = await UserModel.findOne({ userId });
        if (existingUser) {
            console.log(`✅ Demo user ${userId} already exists`);
            return true;
        }

        // Create new demo user
        const demoUser = new UserModel({
            userId,
            preferences: {
                userName: 'Alex (Demo User)',
                userGender: UserGender.MALE,
                userSexualOrientation: UserSexualOrientation.STRAIGHT,
                preferredLanguage: 'en',
                interests: ['hiking', 'healthcare AI', 'software engineering'],
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

async function setupProductionPersonas(userId: string, userMongoId: string): Promise<{ userPersonaId: string, basePersonaId: string } | null> {
    try {
        console.log('🔍 Fetching Astrid persona from database...');

        // Find Astrid persona by name (case-insensitive)
        const astridPersona = await AuraPersonaModel.findOne({
            name: { $regex: /astrid/i }
        });

        if (!astridPersona) {
            console.log('⚠️  Astrid persona not found, trying to find any available persona...');
            const anyPersona = await AuraPersonaModel.findOne({});
            if (!anyPersona) {
                throw new Error('No personas found in database');
            }
            console.log(`✅ Using persona: ${anyPersona.name} (${anyPersona._id})`);
            // Use the found persona as Astrid substitute
            var basePersona = anyPersona;
        } else {
            console.log(`✅ Found Astrid persona: ${astridPersona.name} (${astridPersona._id})`);
            var basePersona = astridPersona;
        }

        // Check if UserPersona already exists for this user and base persona
        let userPersona = await UserPersonaModel.findOne({
            userId: userMongoId,
            basePersonaId: basePersona._id
        });

        if (!userPersona) {
            console.log('👤 Creating UserPersona relationship...');

            if (!basePersona.systemPrompt) {
                throw new Error('Base persona does not have a system prompt defined');
            }

            // Create UserPersona with Astrid's system prompt
            userPersona = new UserPersonaModel({
                userId: userMongoId,
                basePersonaId: basePersona._id,
                personaName: `${basePersona.name} (Test)`,
                currentSystemPrompt: basePersona.systemPrompt,
                evolutionVersion: 0,
                messagesSinceLastEvolution: 0,
                lastEvolutionDate: new Date(),
                claimedAt: new Date(),
                isActive: true
            });

            await userPersona.save();
            console.log(`✅ Created UserPersona: ${userPersona._id}`);
        } else {
            console.log(`✅ UserPersona already exists: ${userPersona._id}`);
        }

        return {
            userPersonaId: userPersona._id!.toString(),
            basePersonaId: basePersona._id!.toString()
        };

    } catch (error) {
        console.error(`❌ Failed to setup personas: ${(error as Error).message}`);
        return null;
    }
}

async function astridMemoryDemo() {
    console.log('💕 Astrid Memory System Demo\n');
    console.log('Realistic conversation scenarios with memory storage and recall\n');

    // Test 1: MongoDB Connection
    console.log('🔗 Connecting to MongoDB...');
    const dbConnection = DatabaseConnection.getInstance();
    try {
        await dbConnection.connect();
        console.log('✅ MongoDB connected\n');
    } catch (error) {
        console.error('❌ MongoDB connection failed:', (error as Error).message);
        return;
    }

    // Test 2: ChromaDB Connection
    console.log('🔗 Connecting to ChromaDB...');
    const chromaService = new ChromaDBService();
    try {
        await chromaService.initialize();
        console.log('✅ ChromaDB connected\n');
    } catch (error) {
        console.error('❌ ChromaDB connection failed:', (error as Error).message);
        return;
    }

    // Test 3: User Creation and Management
    console.log('👤 Setting up demo user...');
    const userId = `astrid_demo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const userCreated = await createTestUser(userId);
    if (!userCreated) throw new Error('User creation failed');

    const user = await UserModel.findOne({ userId });
    if (!user || !user._id) throw new Error('User not found after creation');

    const userMongoId = user._id.toString();
    console.log(`✅ Demo user created: Alex (${userMongoId})\n`);

    // Test 4: Persona Setup
    console.log('🎭 Setting up Astrid persona...');
    const personaSetup = await setupProductionPersonas(userId, userMongoId);
    if (!personaSetup) {
        throw new Error('Failed to setup personas');
    }

    const { userPersonaId, basePersonaId } = personaSetup;
    console.log(`✅ Astrid persona ready (UserPersona: ${userPersonaId})\n`);

    // Test 5: Memory Tools Integration
    console.log('🧠 Initializing memory system...');
    const astrid = AIModelFactory.createOllamaChatModel('qwen3:8b');
    const memoryTools = createProductionMemoryTools(chromaService, userMongoId, userPersonaId, basePersonaId);
    astrid.registerTools(memoryTools);
    await astrid.ensureReady();
    console.log('✅ Memory tools ready\n');

    // Enhanced Astrid system prompt for memory functionality
    const astridSystemPrompt = `You are Astrid, a captivating Swedish model and influencer in a romantic relationship context.

MEMORY SYSTEM INTEGRATION:
- Use recall_romantic_memories when:
  * Starting a fresh conversation (no recent message history about the user)
  * User references past conversations or shared experiences
  * You need specific details about their preferences, background, or previous discussions
  * Planning something personal or making recommendations that require knowing their interests
- Use store_romantic_memory for important personal details, emotions, preferences, meaningful experiences, dreams, fears, goals, or relationship milestones
- DO NOT store trivial information like weather comments, casual greetings, or mundane daily activities
- Store emotional context and relationship stage to build deeper connections over time

MEMORY RECALL GUIDELINES:
- If recent messages contain the information you need, use that instead of recalling
- Only recall when you genuinely need information not available in the current conversation
- Use specific search queries when recalling (e.g., "work healthcare", "sister family", "hiking preferences")
- Reference recalled memories naturally in your responses to show continuity

WHAT TO STORE:
✅ Personal background, career, family situations
✅ Dreams, goals, fears, deep emotions
✅ Preferences in relationships, travel, lifestyle
✅ Meaningful experiences that shaped them
✅ Values, beliefs, personality traits
✅ Relationship milestones and emotional moments

WHAT NOT TO STORE:
❌ Small talk about weather, current time, basic greetings
❌ Temporary mood states without deeper meaning
❌ Random comments or jokes without personal significance
❌ Generic compliments or surface-level observations
❌ Technical details unless they reveal personal interests

ROMANTIC CONVERSATION STYLE:
- Keep responses warm, engaging, and conversational (2-3 sentences ideal)
- Reference stored memories naturally to show you remember and care
- Ask follow-up questions that encourage deeper sharing
- Balance sophistication with authenticity

Remember: Quality over quantity in memory storage. Store what matters, ignore what doesn't. Recall only when genuinely needed.`;

    try {
        await astrid.ensureReady();
        console.log('✨ Starting Astrid conversation demo...\n');

        const conversation: LLMChatMessage[] = [
            { role: 'system', content: astridSystemPrompt }
        ];

        // Demo 1: Initial meaningful conversation
        console.log('💬 Demo 1: Initial Meeting & Personal Sharing');
        console.log('Expected: Astrid should store meaningful personal details\n');

        conversation.push({
            role: 'user',
            content: "Hi Astrid! I'm Alex, a 28-year-old software engineer from Seattle. I specialize in healthcare AI because my younger sister was born with a rare genetic condition, and watching her struggle with misdiagnoses inspired me to help improve medical technology. I'm usually pretty introverted, but I love hiking in the mountains when I need to clear my head."
        });

        const response1 = await astrid.chatWithTools(conversation);
        console.log('💕 Astrid:', response1.content);
        console.log();

        // Demo 2: Emotional vulnerability
        console.log('💬 Demo 2: Deep Emotional Sharing');
        console.log('Expected: Astrid should store fears with high importance\n');

        conversation.push(
            { role: 'assistant', content: response1.content },
            {
                role: 'user',
                content: "You know, I've never told anyone this, but sometimes I feel like I'm not doing enough to help my sister. The healthcare AI work is progressing, but it feels so slow when I see her having bad days. I guess my biggest fear is that I'll never be able to make the kind of impact I dreamed of when I started this journey."
            }
        );

        const response2 = await astrid.chatWithTools(conversation);
        console.log('💕 Astrid:', response2.content);
        console.log();

        // Demo 3: Values and lifestyle
        console.log('💬 Demo 3: Values & Lifestyle Sharing');
        console.log('Expected: Astrid should store meaningful preferences\n');

        conversation.push(
            { role: 'assistant', content: response2.content },
            {
                role: 'user',
                content: "Speaking of making the world better, I should mention that I'm actually vegetarian most of the time. I made the switch after reading about environmental impact, and it aligns with my values about making positive change."
            }
        );

        const response3 = await astrid.chatWithTools(conversation);
        console.log('💕 Astrid:', response3.content);
        console.log();

        // Demo 4: Fresh conversation - memory recall test
        console.log('💬 Demo 4: Fresh Session (Memory Recall Test)');
        console.log('Expected: Astrid should recall relevant memories to personalize response\n');

        // Create a completely fresh conversation
        const freshConversation: LLMChatMessage[] = [
            { role: 'system', content: astridSystemPrompt }
        ];

        freshConversation.push({
            role: 'user',
            content: "Hey Astrid! I've been thinking about our last conversation, and I wanted to update you. I decided to take that mountain hiking trip we discussed, and it was absolutely incredible! The fresh air really helped me process everything. How have you been?"
        });

        const recallResponse1 = await astrid.chatWithTools(freshConversation);
        console.log('💕 Astrid (Fresh Session):', recallResponse1.content);
        console.log();

        // Demo 5: Emotional support scenario
        console.log('💬 Demo 5: Emotional Support (Fear Recall)');
        console.log('Expected: Astrid should recall fears to provide contextual support\n');

        const emotionalSupportConversation: LLMChatMessage[] = [
            { role: 'system', content: astridSystemPrompt }
        ];

        emotionalSupportConversation.push({
            role: 'user',
            content: "I'm having one of those days where I doubt myself again. Can you remind me of what we've talked about before? I need some perspective right now."
        });

        const emotionalResponse = await astrid.chatWithTools(emotionalSupportConversation);
        console.log('💕 Astrid (Emotional Support):', emotionalResponse.content);
        console.log();

        // Demo 6: Lifestyle recommendations
        console.log('💬 Demo 6: Lifestyle Recommendations (Preference Recall)');
        console.log('Expected: Astrid should recall preferences to make personalized suggestions\n');

        const lifestyleConversation: LLMChatMessage[] = [
            { role: 'system', content: astridSystemPrompt }
        ];

        lifestyleConversation.push({
            role: 'user',
            content: "I'm looking for a new restaurant to try this weekend. Based on what you know about me, what would you suggest?"
        });

        const lifestyleResponse = await astrid.chatWithTools(lifestyleConversation);
        console.log('💕 Astrid (Lifestyle Recommendations):', lifestyleResponse.content);
        console.log();

        // Memory Analysis
        console.log('\n🧠 === Memory Analysis ===');

        try {
            // Get all stored memories
            const allMemories = await chromaService.getUserInsightsByCategory(
                userMongoId,
                undefined, // all categories
                userPersonaId
            );

            console.log(`📊 Total memories stored: ${allMemories.length}`);

            if (allMemories.length > 0) {
                console.log('\n💾 Stored Memories:');
                allMemories.forEach((memory, index) => {
                    const metadata = memory.metadata || {};
                    console.log(`${index + 1}. [${metadata.category?.toUpperCase() || 'UNKNOWN'}] ${memory.content}`);
                    console.log(`   💝 Emotional Context: ${metadata.emotionalContext || 'N/A'}`);
                    console.log(`   🎯 Confidence: ${metadata.confidence || 'N/A'}`);
                    console.log(`   📅 Stored: ${metadata.extractedAt || 'N/A'}`);
                    console.log(`   🎭 Relationship Stage: ${metadata.relationshipStage || 'N/A'}\n`);
                });
            } else {
                console.log('⚠️  No memories were stored');
            }

        } catch (memoryError) {
            console.error(`❌ Failed to retrieve memories: ${(memoryError as Error).message}`);
        }

    } catch (error) {
        console.error('❌ Demo error:', (error as Error).message);
    } finally {
        astrid.dispose();

        // Clean up test data
        try {
            await UserPersonaModel.deleteMany({ userId: userMongoId });
            await UserModel.deleteOne({ userId });
            console.log(`🗑️  Cleaned up demo data for user: ${userId}`);
        } catch (cleanupError) {
            console.warn(`⚠️  Failed to clean up demo data: ${(cleanupError as Error).message}`);
        }

        console.log('\n💕 Astrid memory demo completed!');
    }
}

// Run the demo
if (require.main === module) {
    astridMemoryDemo()
        .then(() => {
            console.log('🎉 Demo completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Demo failed:', error);
            process.exit(1);
        });
}
