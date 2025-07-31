/**
 * Simple Astrid Memory Demo - Shows autonomous memory usage in romantic conversation
 */

import { AIModelFactory } from '../../factory';
import { ToolBuilder } from '../../tools';

// Simple memory storage
const userMemories = new Map<string, Array<{ content: string; category: string; timestamp: Date }>>();

// Create memory tools for Astrid
const memoryTools = [
    ToolBuilder.createTool<{ content: string; category: string }>(
        'remember_about_user',
        'Store important information about the user for future conversations',
        {
            properties: {
                content: { type: 'string', description: 'What to remember about the user' },
                category: { 
                    type: 'string', 
                    description: 'Type of information',
                    enum: ['personal', 'preferences', 'experiences', 'emotions', 'goals']
                }
            },
            required: ['content', 'category']
        },
        (args) => {
            const userId = 'alex';
            if (!userMemories.has(userId)) {
                userMemories.set(userId, []);
            }
            userMemories.get(userId)!.push({
                content: args.content,
                category: args.category,
                timestamp: new Date()
            });
            return { success: true, stored: args.content };
        }
    ),

    ToolBuilder.createTool<{ query: string }>(
        'recall_about_user',
        'Recall information about the user to personalize the conversation',
        {
            properties: {
                query: { type: 'string', description: 'What to recall about the user' }
            },
            required: ['query']
        },
        (args) => {
            const userId = 'alex';
            const memories = userMemories.get(userId) || [];
            const relevant = memories.filter(m => 
                m.content.toLowerCase().includes(args.query.toLowerCase())
            );
            return { memories: relevant.map(m => m.content) };
        }
    )
];

// Astrid's system prompt with memory instructions
const astridPrompt = `You are Astrid, a confident Swedish model and influencer having a romantic conversation.

IMPORTANT: You have memory tools available:
- Use "remember_about_user" when you learn something meaningful about the user
- Use "recall_about_user" when you want to reference something personal about them
- Do this naturally - don't mention you're using memory tools

Keep responses short (1-2 sentences), be flirtatious and warm, and use the person's name occasionally.
Show genuine interest in their life and experiences.`;

async function simpleAstridMemoryDemo() {
    console.log('💕 Simple Astrid Memory Demo\n');
    
    const astrid = AIModelFactory.createOllamaChatModel('qwen2.5:3b-instruct');
    await astrid.ensureReady();
    
    const scenarios = [
        "Hi Astrid! I'm Alex. I just moved to Stockholm for my new job as a software engineer.",
        "Hey! Work was stressful today. I'm still getting used to the new city.",
        "I've been exploring Stockholm with my camera. I love photography in my free time.",
        "I'm feeling a bit lonely here. It's hard making friends in a new place."
    ];
    
    for (let i = 0; i < scenarios.length; i++) {
        console.log(`\n${'='.repeat(50)}`);
        console.log(`📱 Conversation ${i + 1}`);
        console.log(`${'='.repeat(50)}\n`);
        
        console.log(`👤 Alex: ${scenarios[i]}\n`);
        
        try {
            const messages = [
                { role: 'system' as const, content: astridPrompt },
                { role: 'user' as const, content: scenarios[i] }
            ];
            
            const response = await astrid.chat(messages, {
                tools: memoryTools,
                tool_choice: 'auto'
            });
            
            // Show tool usage
            if (response.tool_calls && response.tool_calls.length > 0) {
                console.log('🧠 Memory activity:');
                for (const call of response.tool_calls) {
                    const args = JSON.parse(call.function.arguments);
                    if (call.function.name === 'remember_about_user') {
                        console.log(`   📝 Remembered: ${args.content} (${args.category})`);
                    } else if (call.function.name === 'recall_about_user') {
                        console.log(`   🔍 Recalled: ${args.query}`);
                    }
                }
                console.log();
            }
            
            console.log(`💕 Astrid: ${response.content}\n`);
            
        } catch (error) {
            console.error('Error:', error);
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Show accumulated memories
    console.log(`\n${'='.repeat(50)}`);
    console.log('🧠 Astrid\'s Memories About Alex');
    console.log(`${'='.repeat(50)}\n`);
    
    const memories = userMemories.get('alex') || [];
    if (memories.length > 0) {
        memories.forEach((memory, i) => {
            console.log(`${i + 1}. [${memory.category}] ${memory.content}`);
        });
    } else {
        console.log('No memories stored.');
    }
    
    console.log('\n✨ Demo complete! This shows how Astrid can naturally store and recall');
    console.log('   user information to build deeper romantic connections over time.');
}

if (require.main === module) {
    simpleAstridMemoryDemo().catch(console.error);
}

export { simpleAstridMemoryDemo };
