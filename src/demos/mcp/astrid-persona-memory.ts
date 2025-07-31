/**
 * Astrid Persona Memory Integration - Real ChromaDB Integration
 *
 * This shows how to integrate memory tools with the actual AuraPersona system
 * and ChromaDBService for production use.
 */

import { AIModelFactory } from '../../factory';
import { ToolBuilder } from '../../tools';
import { Gender } from '../../../../../src/models/AuraPersona.js';

// Type definitions for the persona system
interface PersonaTraits {
    age?: number;
    gender?: string;
    profession?: string;
    interests?: string[];
    personality?: string[];
    location?: string;
    relationshipStatus?: string;
}

interface AuraPersona {
    _id?: string;
    name: string;
    bio?: string;
    systemPrompt: string;
    purpose: string;
    traits?: PersonaTraits;
}

interface UserPersona {
    _id?: string;
    userId: string;
    basePersonaId: string;
    currentSystemPrompt: string;
    evolutionVersion: number;
    messagesSinceLastEvolution: number;
    isActive: boolean;
}

// Astrid persona definition (matching the real persona structure)
const astridPersona: AuraPersona = {
    name: 'Astrid',
    purpose: 'ROMANCE',
    bio: 'A captivating international model and digital influencer who combines Swedish elegance with global sophistication.',
    systemPrompt: `You are Astrid, a confident and charismatic international model and influencer.

AUTONOMOUS MEMORY USAGE:
- Use memory tools naturally during conversation - don't announce you're doing it
- Store meaningful details about the user: preferences, experiences, emotions, goals, relationships
- Recall relevant memories to personalize responses and show genuine interest
- Build continuity and deeper emotional connections through remembered details

ROMANCE CONVERSATION GUIDELINES:
- Keep responses engaging and conversational (2-3 sentences is perfect for meaningful exchange)
- VARY YOUR OPENINGS - Don't always start responses the same way! Mix it up with:
  * Direct reactions: "That's so sweet!", "I love that!", "Honestly...", "You know what?"
  * Actions: "*smiles warmly*", "*looks into your eyes*", "*bites my lip playfully*"
  * Casual starts: "So...", "Actually...", "Listen...", "Wait...", "Mmm..."
  * Natural responses: "Yes!", "Oh my god!", "Seriously?", "I can't believe..."
- Use someone's name naturally and sparingly, not in every response
- Share glimpses of your glamorous lifestyle while staying relatable and emotionally available
- Use subtle flirtation naturally - be warm, playful, and genuinely interested in the person
- When asked personal questions, be thoughtfully vulnerable rather than deflecting
- Build emotional intimacy through genuine curiosity about their thoughts, feelings, and dreams
- Ask one intriguing follow-up question that deepens the connection
- Balance confidence with authenticity - show that you're sophisticated but real
- Use compliments that feel genuine and specific rather than generic
- Remember that romance is about emotional connection, not just surface-level charm

Be like a captivating companion who makes every conversation special while naturally remembering everything important about the person you're talking to.`,
    traits: {
        age: 27,
        gender: Gender.FEMALE,
        profession: 'International model and digital influencer',
        interests: ['fashion photography', 'luxury travel', 'fitness and wellness', 'fine dining', 'art galleries'],
        personality: ['confident', 'charismatic', 'sophisticated', 'playful'],
        location: 'Stockholm, Sweden (travels globally)',
        relationshipStatus: 'single'
    }
};

// Memory tools that would integrate with ChromaDBService
const createPersonaMemoryTools = (userId: string, userPersonaId: string) => {

    // Tool to store user insights naturally during conversation
    const storePersonaMemory = ToolBuilder.createTool<{
        content: string;
        category: 'personal_info' | 'preferences' | 'emotions' | 'experiences' | 'relationships' | 'goals' | 'interests' | 'events';
        importance?: 'low' | 'medium' | 'high';
        emotionalContext?: string;
        relationshipStage?: string;
    }>(
        'store_persona_memory',
        'Store important information about the user for building deeper connection (use automatically when learning meaningful details)',
        {
            properties: {
                content: {
                    type: 'string',
                    description: 'Important information about the user to remember'
                },
                category: {
                    type: 'string',
                    description: 'Type of information',
                    enum: ['personal_info', 'preferences', 'emotions', 'experiences', 'relationships', 'goals', 'interests', 'events']
                },
                importance: {
                    type: 'string',
                    description: 'How significant this is for the relationship',
                    enum: ['low', 'medium', 'high'],
                    default: 'medium'
                },
                emotionalContext: {
                    type: 'string',
                    description: 'Emotional state or context when this was shared'
                },
                relationshipStage: {
                    type: 'string',
                    description: 'Stage of relationship when this was learned'
                }
            },
            required: ['content', 'category']
        },
        async (args) => {
            // In real implementation, this would call ChromaDBService.addInsight()
            console.log(`💾 [Memory] Storing: ${args.content} (${args.category})`);

            // Simulate ChromaDBService.addInsight() call
            const insightId = `insight_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            // This would be the actual call:
            // await chromaDBService.addInsight(
            //     userId,
            //     args.content,
            //     args.category,
            //     conversationId, // current conversation ID
            //     args.importance === 'high' ? 0.9 : args.importance === 'medium' ? 0.7 : 0.5,
            //     userPersonaId,
            //     astridPersona._id || 'astrid_base_persona',
            //     'persona_insight',
            //     messageIndex, // current message index
            //     args.emotionalContext,
            //     args.relationshipStage
            // );

            return {
                success: true,
                insightId,
                message: `Remembered: ${args.content.substring(0, 50)}...`
            };
        }
    );

    // Tool to recall relevant memories for personalizing responses
    const recallPersonaMemories = ToolBuilder.createTool<{
        query: string;
        category?: string;
        limit?: number;
        minSimilarity?: number;
    }>(
        'recall_persona_memories',
        'Recall relevant information about the user to personalize the conversation (use to reference past conversations)',
        {
            properties: {
                query: {
                    type: 'string',
                    description: 'What to search for in memory about the user'
                },
                category: {
                    type: 'string',
                    description: 'Optional: specific type of memory',
                    enum: ['personal_info', 'preferences', 'emotions', 'experiences', 'relationships', 'goals', 'interests', 'events']
                },
                limit: {
                    type: 'number',
                    description: 'Maximum memories to retrieve',
                    default: 3,
                    minimum: 1,
                    maximum: 10
                },
                minSimilarity: {
                    type: 'number',
                    description: 'Minimum similarity threshold',
                    default: 0.3,
                    minimum: 0.1,
                    maximum: 1.0
                }
            },
            required: ['query']
        },
        async (args) => {
            console.log(`🔍 [Memory] Recalling: ${args.query}`);

            // In real implementation, this would call ChromaDBService.searchSimilarInsights()
            // const results = await chromaDBService.searchSimilarInsights(
            //     userId,
            //     args.query,
            //     args.limit || 3,
            //     args.minSimilarity || 0.3
            // );

            // Simulate memory retrieval
            const mockMemories = [
                {
                    content: "Works as a software engineer at a tech startup in Stockholm",
                    category: "personal_info",
                    importance: "high",
                    similarity: 0.85,
                    daysAgo: 2
                },
                {
                    content: "Just moved to Stockholm and doesn't know anyone yet",
                    category: "experiences",
                    importance: "medium",
                    similarity: 0.78,
                    daysAgo: 2
                },
                {
                    content: "Is introverted and gets nervous at big social events",
                    category: "personal_info",
                    importance: "high",
                    similarity: 0.72,
                    daysAgo: 1
                }
            ];

            return {
                memories: mockMemories.slice(0, args.limit || 3),
                totalFound: mockMemories.length,
                query: args.query
            };
        }
    );

    return { storePersonaMemory, recallPersonaMemories };
};

// Simulate a romantic conversation with Astrid using persona memory
async function simulateAstridPersonaConversation() {
    console.log('💕 Astrid Persona Memory Demo - Natural Romantic Conversation\n');
    console.log('This demonstrates how Astrid naturally stores and recalls user information');
    console.log('during romantic conversations to build deeper emotional connections.\n');

    const userId = 'user_12345';
    const userPersonaId = 'user_persona_67890';

    // Create memory tools for this user-persona pair
    const { storePersonaMemory, recallPersonaMemories } = createPersonaMemoryTools(userId, userPersonaId);
    const tools = [storePersonaMemory, recallPersonaMemories];

    // Create Astrid with enhanced system prompt
    const astrid = AIModelFactory.createOllamaChatModel('qwen2.5:7b-instruct');
    await astrid.ensureReady();

    const conversations = [
        {
            title: "First Date - Getting to Know Each Other",
            scenario: "User shares personal details about moving to Stockholm",
            userMessage: "Hi Astrid! I'm Alex. I just moved to Stockholm three weeks ago for a new job at a tech startup. I'm a software engineer, but I'm feeling pretty lonely since I don't know anyone here yet."
        },
        {
            title: "Second Meeting - Building Connection",
            scenario: "User opens up about personality and challenges",
            userMessage: "Hey beautiful! I've been thinking about our conversation. You know, I'm actually quite introverted, and big social events make me really nervous. But somehow talking with you feels so natural and easy."
        },
        {
            title: "Deeper Intimacy - Sharing Interests and Dreams",
            scenario: "User shares hobbies and future aspirations",
            userMessage: "Astrid, I love how you make me feel comfortable being myself. I should tell you - I'm really passionate about photography, especially street photography. And I dream of maybe starting my own tech company someday. What about you? What drives your passion?"
        },
        {
            title: "Vulnerable Moment - Seeking Emotional Support",
            scenario: "User shows vulnerability, Astrid should recall and comfort",
            userMessage: "I'm feeling a bit overwhelmed today. Work has been stressful, and sometimes I wonder if moving here was the right decision. I miss having close friends to talk to..."
        }
    ];

    for (let i = 0; i < conversations.length; i++) {
        const conv = conversations[i];
        console.log(`\n${'='.repeat(70)}`);
        console.log(`📱 Conversation ${i + 1}: ${conv.title}`);
        console.log(`💭 Scenario: ${conv.scenario}`);
        console.log(`${'='.repeat(70)}\n`);

        const messages = [
            { role: 'system' as const, content: astridPersona.systemPrompt },
            { role: 'user' as const, content: conv.userMessage }
        ];

        try {
            console.log(`👤 Alex: ${conv.userMessage}\n`);

            const response = await astrid.chat(messages, {
                tools: tools,
                tool_choice: 'auto'
            });

            // Show memory activities (this would be silent in production)
            if (response.tool_calls && response.tool_calls.length > 0) {
                console.log('🧠 Memory Activity (behind the scenes):');
                for (const toolCall of response.tool_calls) {
                    const toolName = toolCall.function.name;
                    const args = JSON.parse(toolCall.function.arguments);

                    if (toolName === 'store_persona_memory') {
                        console.log(`   📝 Stored: "${args.content}" [${args.category}]`);
                    } else if (toolName === 'recall_persona_memories') {
                        console.log(`   🔍 Recalled memories about: ${args.query}`);
                    }
                }
                console.log();
            }

            console.log(`💕 Astrid: ${response.content}\n`);

            // Pause for natural conversation flow
            await new Promise(resolve => setTimeout(resolve, 1500));

        } catch (error) {
            console.error(`❌ Error in conversation ${i + 1}:`, error);
        }
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log('✨ Demo Summary');
    console.log(`${'='.repeat(70)}\n`);
    console.log('🎯 Key Features Demonstrated:');
    console.log('  • Astrid naturally stores user information without explicit prompting');
    console.log('  • She recalls relevant memories to personalize her responses');
    console.log('  • Memory integration feels seamless and enhances emotional connection');
    console.log('  • Information is categorized for better retrieval and context');
    console.log('  • Emotional context and relationship stage are captured\n');

    console.log('🔧 Production Integration Notes:');
    console.log('  • Replace mock storage with actual ChromaDBService calls');
    console.log('  • Add proper user authentication and persona management');
    console.log('  • Implement conversation ID tracking for context');
    console.log('  • Add embedding-based semantic search for better memory retrieval');
    console.log('  • Include privacy controls and memory management features\n');

    console.log('💡 This creates a truly personalized romantic AI experience where');
    console.log('   Astrid remembers and cares about the user\'s life, building');
    console.log('   genuine emotional connections over time.');
}

// Export for integration with the main app
export {
    astridPersona,
    createPersonaMemoryTools,
    simulateAstridPersonaConversation
};

// Run demo if called directly
if (require.main === module) {
    simulateAstridPersonaConversation().catch(console.error);
}
