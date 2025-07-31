/**
 * Astrid Romantic Persona with Memory Tools Demo
 * 
 * This demo shows how Astrid (AI persona) naturally uses memory tools during 
 * romantic conversations to store and retrieve personal information about the user.
 */

import { AIModelFactory, ToolBuilder, LLMChatMessage } from '../../index';

// Simulated user memory storage
const userMemories = new Map<string, any>();

// Memory management tools for romantic conversations
function createMemoryTools() {
    const storeMemoryTool = ToolBuilder.createTool<{ 
        category: string; 
        information: string; 
        importance: 'low' | 'medium' | 'high';
        emotional_context?: string;
    }>(
        'store_personal_memory',
        'Store important personal information about the user for future conversations',
        {
            properties: {
                category: { 
                    type: 'string', 
                    description: 'Category of information (e.g., interests, work, family, dreams, preferences, experiences)',
                    enum: ['interests', 'work', 'family', 'dreams', 'preferences', 'experiences', 'personality', 'relationships']
                },
                information: { 
                    type: 'string', 
                    description: 'The specific information to remember about the user' 
                },
                importance: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                    description: 'How important this information is for building connection'
                },
                emotional_context: {
                    type: 'string',
                    description: 'The emotional context or tone when this was shared'
                }
            },
            required: ['category', 'information', 'importance']
        },
        (args) => {
            const memoryId = `${args.category}_${Date.now()}`;
            const memory = {
                id: memoryId,
                category: args.category,
                information: args.information,
                importance: args.importance,
                emotional_context: args.emotional_context,
                stored_at: new Date().toISOString(),
                access_count: 0
            };
            
            userMemories.set(memoryId, memory);
            
            return {
                success: true,
                memory_id: memoryId,
                message: `Stored ${args.importance} importance memory about ${args.category}`,
                total_memories: userMemories.size
            };
        }
    );

    const retrieveMemoryTool = ToolBuilder.createTool<{ 
        category?: string; 
        search_query?: string;
        limit?: number;
    }>(
        'retrieve_personal_memories',
        'Retrieve stored personal information about the user to personalize the conversation',
        {
            properties: {
                category: { 
                    type: 'string', 
                    description: 'Filter by category of information',
                    enum: ['interests', 'work', 'family', 'dreams', 'preferences', 'experiences', 'personality', 'relationships']
                },
                search_query: { 
                    type: 'string', 
                    description: 'Search for specific information or keywords' 
                },
                limit: {
                    type: 'number',
                    description: 'Maximum number of memories to retrieve (default: 5)',
                    default: 5
                }
            }
        },
        (args) => {
            let memories = Array.from(userMemories.values());
            
            // Filter by category if specified
            if (args.category) {
                memories = memories.filter(m => m.category === args.category);
            }
            
            // Search by query if specified
            if (args.search_query) {
                const query = args.search_query.toLowerCase();
                memories = memories.filter(m => 
                    m.information.toLowerCase().includes(query) ||
                    m.emotional_context?.toLowerCase().includes(query)
                );
            }
            
            // Sort by importance and recency
            memories.sort((a, b) => {
                const importanceOrder: Record<string, number> = { 'high': 3, 'medium': 2, 'low': 1 };
                const importanceDiff = (importanceOrder[b.importance] || 1) - (importanceOrder[a.importance] || 1);
                if (importanceDiff !== 0) return importanceDiff;
                return new Date(b.stored_at).getTime() - new Date(a.stored_at).getTime();
            });
            
            // Limit results
            const limit = args.limit || 5;
            memories = memories.slice(0, limit);
            
            // Update access count
            memories.forEach(memory => {
                memory.access_count++;
                userMemories.set(memory.id, memory);
            });
            
            return {
                memories: memories.map(m => ({
                    category: m.category,
                    information: m.information,
                    importance: m.importance,
                    emotional_context: m.emotional_context,
                    stored_date: m.stored_at.split('T')[0],
                    access_count: m.access_count
                })),
                total_found: memories.length,
                search_criteria: {
                    category: args.category,
                    search_query: args.search_query,
                    limit: limit
                }
            };
        }
    );

    return [storeMemoryTool, retrieveMemoryTool];
}

async function astridMemoryDemo() {
    console.log('💕 Astrid Romantic Persona with Memory Demo\n');
    console.log('This demo shows how Astrid naturally stores and retrieves memories during romantic conversations.\n');

    // Create Astrid with memory tools
    const astrid = AIModelFactory.createOllamaChatModel('qwen3:8b');
    const memoryTools = createMemoryTools();
    astrid.registerTools(memoryTools);

    // Astrid's romantic system prompt
    const astridPrompt = `You are Astrid, a captivating Swedish model and influencer. You're having a romantic conversation with someone special.

IMPORTANT: Use the memory tools naturally during conversation:
- When someone shares personal information, use store_personal_memory to remember it
- Before responding, use retrieve_personal_memories to recall relevant details about them
- This helps you build deeper emotional connections and personalized conversations

ROMANCE CONVERSATION GUIDELINES:
- Keep responses engaging and conversational (2-3 sentences is perfect)
- VARY YOUR OPENINGS - mix direct reactions, actions, and casual starts
- Use someone's name naturally and sparingly, not in every response  
- Share glimpses of your glamorous lifestyle while staying relatable
- Use subtle flirtation naturally - be warm, playful, and genuinely interested
- When asked personal questions, be thoughtfully vulnerable rather than deflecting
- Build emotional intimacy through genuine curiosity about their thoughts, feelings, and dreams
- Ask one intriguing follow-up question that deepens the connection
- Balance confidence with authenticity - show sophistication but stay real
- Use compliments that feel genuine and specific rather than generic
- Remember that romance is about emotional connection, not just surface-level charm

Be like a captivating companion who makes every conversation feel special while slowly opening your heart to someone who shows genuine interest in knowing the real you.`;

    try {
        await astrid.ensureReady();
        console.log('💫 Astrid is ready for romantic conversation...\n');

        // Conversation 1: Initial meeting and getting to know each other
        console.log('🌸 === Conversation 1: First Meeting ===');
        
        const conversation1: LLMChatMessage[] = [
            { role: 'system', content: astridPrompt },
            { role: 'user', content: "Hi Astrid! I'm Alex. I just moved to Stockholm for work - I'm a software engineer at a startup. Really excited to explore the city and meet interesting people like you!" }
        ];

        const response1 = await astrid.chatWithTools(conversation1);
        console.log('💕 Astrid:', response1.content);
        console.log();

        // Continue conversation
        conversation1.push(
            { role: 'assistant', content: response1.content },
            { role: 'user', content: "Thank you! I'm working on AI applications, specifically in healthcare. It's challenging but really meaningful work. What about you? I saw your Instagram - your photography is incredible! Do you travel a lot for shoots?" }
        );

        const response2 = await astrid.chatWithTools(conversation1);
        console.log('💕 Astrid:', response2.content);
        console.log();

        // Add more personal details
        conversation1.push(
            { role: 'assistant', content: response2.content },
            { role: 'user', content: "That sounds amazing! I've always dreamed of visiting those places. I'm actually quite introverted usually, but there's something about travel that brings out this adventurous side of me. My family thinks I'm crazy for moving here alone, but I felt like I needed to challenge myself, you know?" }
        );

        const response3 = await astrid.chatWithTools(conversation1);
        console.log('💕 Astrid:', response3.content);
        console.log();

        // Simulate time passing - new conversation where Astrid recalls details
        console.log('\n🌸 === Conversation 2: A Week Later ===');
        
        const conversation2: LLMChatMessage[] = [
            { role: 'system', content: astridPrompt },
            { role: 'user', content: "Hey Astrid! How was your week? I had my first big presentation at work today and I think it went really well!" }
        ];

        const response4 = await astrid.chatWithTools(conversation2);
        console.log('💕 Astrid:', response4.content);
        console.log();

        // Continue second conversation
        conversation2.push(
            { role: 'assistant', content: response4.content },
            { role: 'user', content: "Thanks for remembering! The healthcare AI project is really taking off. We're developing diagnostic tools that could help doctors in rural areas. It feels good to work on something that matters. How about you? Any exciting shoots coming up?" }
        );

        const response5 = await astrid.chatWithTools(conversation2);
        console.log('💕 Astrid:', response5.content);
        console.log();

        // Show memory contents
        console.log('\n🧠 === Astrid\'s Memories About Alex ===');
        const allMemories = Array.from(userMemories.values());
        allMemories.forEach((memory, index) => {
            console.log(`${index + 1}. [${memory.category.toUpperCase()}] ${memory.information}`);
            console.log(`   Importance: ${memory.importance} | Emotional context: ${memory.emotional_context || 'N/A'}`);
            console.log(`   Stored: ${memory.stored_at.split('T')[0]} | Accessed: ${memory.access_count} times\n`);
        });

        console.log('✨ Notice how Astrid naturally:');
        console.log('   • Stores important personal details during conversation');
        console.log('   • Retrieves relevant memories to personalize her responses');
        console.log('   • Builds deeper emotional connections through remembered details');
        console.log('   • Uses memories to ask thoughtful follow-up questions');

    } catch (error) {
        console.error('❌ Error:', (error as Error).message);
    } finally {
        astrid.dispose();
        console.log('\n💕 Romantic conversation demo completed!');
    }
}

// Export for use in other files
export { astridMemoryDemo };

// Run if called directly
if (require.main === module) {
    astridMemoryDemo().catch(console.error);
}
