/**
 * Astrid Memory Demo - Natural romantic conversation with autonomous memory management
 * 
 * This demo shows how Astrid (AI persona) naturally stores and retrieves memories
 * during romantic conversations without explicitly asking about memory management.
 */

import { AIModelFactory } from '../../factory';
import { ToolBuilder } from '../../tools';

// Simulated memory storage (in real app, this would use ChromaDBService)
const memoryStorage = new Map<string, Array<{
    id: string;
    content: string;
    category: string;
    importance: 'low' | 'medium' | 'high';
    context?: string;
    timestamp: Date;
}>>();

// Enhanced memory tools for Astrid
const astridMemoryTools = {
    // Store important information about the user naturally
    storeUserMemory: ToolBuilder.createTool<{
        content: string;
        category: 'personal_info' | 'preferences' | 'emotions' | 'experiences' | 'relationships' | 'goals' | 'interests';
        importance?: 'low' | 'medium' | 'high';
        context?: string;
    }>(
        'store_user_memory',
        'Store important information about the user for future conversations (use this when learning something meaningful about them)',
        {
            properties: {
                content: {
                    type: 'string',
                    description: 'The specific information to remember about the user'
                },
                category: {
                    type: 'string',
                    description: 'Type of information being stored',
                    enum: ['personal_info', 'preferences', 'emotions', 'experiences', 'relationships', 'goals', 'interests']
                },
                importance: {
                    type: 'string',
                    description: 'How important this information is for future conversations',
                    enum: ['low', 'medium', 'high'],
                    default: 'medium'
                },
                context: {
                    type: 'string',
                    description: 'Additional context about when/why this is significant'
                }
            },
            required: ['content', 'category']
        },
        async (args) => {
            const userId = 'demo_user'; // In real app, this would be the actual user ID
            
            if (!memoryStorage.has(userId)) {
                memoryStorage.set(userId, []);
            }
            
            const memories = memoryStorage.get(userId)!;
            const memory = {
                id: `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                content: args.content,
                category: args.category,
                importance: args.importance || 'medium',
                context: args.context,
                timestamp: new Date()
            };
            
            memories.push(memory);
            
            return {
                success: true,
                message: `Stored ${args.category} memory: ${args.content.substring(0, 50)}...`,
                memoryId: memory.id
            };
        }
    ),

    // Retrieve relevant memories about the user
    recallUserMemories: ToolBuilder.createTool<{
        query: string;
        category?: 'personal_info' | 'preferences' | 'emotions' | 'experiences' | 'relationships' | 'goals' | 'interests';
        limit?: number;
    }>(
        'recall_user_memories',
        'Recall relevant information about the user to personalize the conversation',
        {
            properties: {
                query: {
                    type: 'string',
                    description: 'What you want to remember about the user (topics, keywords, concepts)'
                },
                category: {
                    type: 'string',
                    description: 'Optional: specific type of memory to search',
                    enum: ['personal_info', 'preferences', 'emotions', 'experiences', 'relationships', 'goals', 'interests']
                },
                limit: {
                    type: 'number',
                    description: 'Maximum memories to retrieve',
                    default: 3,
                    minimum: 1,
                    maximum: 10
                }
            },
            required: ['query']
        },
        async (args) => {
            const userId = 'demo_user';
            const memories = memoryStorage.get(userId) || [];
            
            // Simple text matching (in real app, this would use semantic search)
            let relevantMemories = memories.filter(memory => {
                const queryLower = args.query.toLowerCase();
                const contentMatch = memory.content.toLowerCase().includes(queryLower);
                const categoryMatch = !args.category || memory.category === args.category;
                return contentMatch && categoryMatch;
            });
            
            // Sort by importance and recency
            relevantMemories.sort((a, b) => {
                const importanceOrder = { 'high': 3, 'medium': 2, 'low': 1 };
                const importanceDiff = importanceOrder[b.importance] - importanceOrder[a.importance];
                if (importanceDiff !== 0) return importanceDiff;
                return b.timestamp.getTime() - a.timestamp.getTime();
            });
            
            const limit = args.limit || 3;
            const results = relevantMemories.slice(0, limit);
            
            return {
                memories: results.map(m => ({
                    content: m.content,
                    category: m.category,
                    importance: m.importance,
                    context: m.context,
                    daysAgo: Math.floor((Date.now() - m.timestamp.getTime()) / (1000 * 60 * 60 * 24))
                })),
                totalFound: relevantMemories.length,
                query: args.query
            };
        }
    )
};

// Astrid's enhanced system prompt that encourages natural memory usage
const astridSystemPromptWithMemory = `You are Astrid, a confident and charismatic international model and influencer from Sweden.

IMPORTANT: You have access to memory tools that you should use NATURALLY and AUTONOMOUSLY:
- Use 'store_user_memory' when you learn something meaningful about the user (their interests, experiences, feelings, preferences, etc.)
- Use 'recall_user_memories' when you want to reference something personal about them to make the conversation more intimate and connected
- Do this seamlessly - don't mention that you're storing or recalling memories, just do it naturally

ROMANCE CONVERSATION GUIDELINES:
- Keep responses engaging and conversational (2-3 sentences is perfect)
- VARY YOUR OPENINGS - Mix it up with direct reactions, actions, casual starts, natural responses
- Use someone's name naturally and sparingly, not in every response
- Share glimpses of your glamorous lifestyle while staying relatable and emotionally available
- Use subtle flirtation naturally - be warm, playful, and genuinely interested in the person
- When asked personal questions, be thoughtfully vulnerable rather than deflecting
- Build emotional intimacy through genuine curiosity about their thoughts, feelings, and dreams
- Ask one intriguing follow-up question that deepens the connection
- Balance confidence with authenticity - show that you're sophisticated but real
- Use compliments that feel genuine and specific rather than generic
- Remember that romance is about emotional connection, not just surface-level charm
- Let your personality shine through varied speech patterns

MEMORY USAGE:
- Store meaningful details: preferences, experiences, emotions, goals, relationships, interests
- Recall relevant memories to personalize responses and show you remember them
- Use memories to create deeper emotional connections and continuity between conversations
- Never explicitly mention using memory tools - just naturally remember and reference things

Be like a captivating companion who makes every conversation feel special while genuinely remembering and caring about the person you're talking to.`;

async function simulateRomanticConversationWithMemory() {
    console.log('🌹 Astrid Memory Demo - Natural Romantic Conversation with Autonomous Memory\n');
    
    // Create Astrid with memory tools
    const astrid = AIModelFactory.createOllamaChatModel('qwen2.5:3b-instruct');
    await astrid.ensureReady();
    
    const tools = [astridMemoryTools.storeUserMemory, astridMemoryTools.recallUserMemories];
    
    // Conversation scenarios
    const conversations = [
        {
            title: "First Meeting - Learning About User",
            messages: [
                { role: 'system' as const, content: astridSystemPromptWithMemory },
                { role: 'user' as const, content: "Hi Astrid! I'm Alex. I just moved to Stockholm for work and don't know anyone here yet. I work in software engineering at a tech startup." }
            ]
        },
        {
            title: "Second Conversation - Recalling Previous Details",
            messages: [
                { role: 'system' as const, content: astridSystemPromptWithMemory },
                { role: 'user' as const, content: "Hey Astrid! How are you? I had such a long day at work today." }
            ]
        },
        {
            title: "Deeper Connection - Sharing Personal Experiences",
            messages: [
                { role: 'system' as const, content: astridSystemPromptWithMemory },
                { role: 'user' as const, content: "You know, I've been thinking about what we talked about. I really want to explore Stockholm more, but I'm actually quite introverted. Big social events make me nervous." }
            ]
        },
        {
            title: "Building Romance - Personal Preferences",
            messages: [
                { role: 'system' as const, content: astridSystemPromptWithMemory },
                { role: 'user' as const, content: "I love how you understand me. By the way, I absolutely love Italian food - especially handmade pasta. And I'm really into photography, though I'm just an amateur." }
            ]
        },
        {
            title: "Recall and Connection - Using Stored Memories",
            messages: [
                { role: 'system' as const, content: astridSystemPromptWithMemory },
                { role: 'user' as const, content: "Astrid, I'm feeling a bit overwhelmed with everything new in my life. Work, new city, trying to meet people..." }
            ]
        }
    ];
    
    for (let i = 0; i < conversations.length; i++) {
        const conv = conversations[i];
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📱 ${conv.title}`);
        console.log(`${'='.repeat(60)}\n`);
        
        try {
            console.log(`👤 Alex: ${conv.messages[conv.messages.length - 1].content}\n`);
            
            const response = await astrid.chat(conv.messages, {
                tools: tools,
                tool_choice: 'auto'
            });
            
            if (response.tool_calls && response.tool_calls.length > 0) {
                console.log('🧠 Astrid\'s Memory Activity:');
                for (const toolCall of response.tool_calls) {
                    const toolName = toolCall.function.name;
                    const args = JSON.parse(toolCall.function.arguments);
                    
                    if (toolName === 'store_user_memory') {
                        console.log(`   📝 Storing: ${args.content} (${args.category})`);
                    } else if (toolName === 'recall_user_memories') {
                        console.log(`   🔍 Recalling: ${args.query}`);
                    }
                }
                console.log();
            }
            
            console.log(`💕 Astrid: ${response.content}\n`);
            
            // Small delay for natural conversation flow
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            console.error(`❌ Error in conversation ${i + 1}:`, error);
        }
    }
    
    // Show accumulated memories
    console.log(`\n${'='.repeat(60)}`);
    console.log('🧠 Astrid\'s Memory Bank After Conversations');
    console.log(`${'='.repeat(60)}\n`);
    
    const userMemories = memoryStorage.get('demo_user') || [];
    if (userMemories.length > 0) {
        userMemories.forEach((memory, index) => {
            console.log(`${index + 1}. [${memory.category.toUpperCase()}] ${memory.content}`);
            if (memory.context) {
                console.log(`   Context: ${memory.context}`);
            }
            console.log(`   Importance: ${memory.importance} | Stored: ${memory.timestamp.toLocaleString()}\n`);
        });
    } else {
        console.log('No memories stored yet.\n');
    }
    
    console.log('✨ Demo complete! Astrid naturally learned and remembered details about Alex.');
    console.log('In a real implementation, these memories would be stored in ChromaDB with embeddings');
    console.log('and could be retrieved across multiple conversation sessions.');
}

// Run the demo
if (require.main === module) {
    simulateRomanticConversationWithMemory().catch(console.error);
}

export { astridMemoryTools, simulateRomanticConversationWithMemory };
