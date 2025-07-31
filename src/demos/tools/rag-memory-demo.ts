/**
 * RAG Memory System Demo
 * 
 * This demo shows how an AI can automatically decide what information
 * from a conversation is worth storing in its memory system, and how
 * it can retrieve relevant information when needed.
 */

import { AIModelFactory } from '../../factory';
import { ToolBuilder } from '../../tools';
import { RAGService, createRAGTools } from '../../rag-service';

// Mock ChromaDB service for demonstration
class MockChromaDBService {
    private memories: Map<string, any> = new Map();
    private nextId = 1;

    isInitialized(): boolean {
        return true;
    }

    async addInsight(
        userId: string,
        content: string,
        category: string,
        sourceConversationId: string,
        confidence: number = 0.7,
        userPersonaId?: string,
        basePersonaId?: string,
        extractionType?: string,
        sourceMessageIndex?: number,
        emotionalContext?: string,
        relationshipStage?: string
    ): Promise<string> {
        const id = `memory_${this.nextId++}`;
        const insight = {
            id,
            userId,
            content,
            category,
            confidence,
            timestamp: new Date().toISOString(),
            sourceConversationId,
            userPersonaId,
            basePersonaId,
            extractionType,
            sourceMessageIndex,
            emotionalContext,
            relationshipStage
        };
        
        this.memories.set(id, insight);
        console.log(`📝 Stored memory: ${category} - ${content.substring(0, 50)}...`);
        return id;
    }

    async searchSimilarInsights(
        userId: string,
        query: string,
        limit: number = 5,
        minSimilarity: number = 0.3
    ): Promise<{
        insights: any[];
        stats: any;
    }> {
        const queryLower = query.toLowerCase();
        const userMemories = Array.from(this.memories.values())
            .filter(memory => memory.userId === userId);
        
        // Simple text similarity scoring
        const scoredMemories = userMemories.map(memory => {
            const contentLower = memory.content.toLowerCase();
            let similarity = 0;
            
            // Simple word overlap scoring
            const queryWords = queryLower.split(/\s+/);
            const contentWords = contentLower.split(/\s+/);
            const overlap = queryWords.filter(word => contentWords.includes(word)).length;
            similarity = overlap / Math.max(queryWords.length, contentWords.length);
            
            // Boost if exact phrase match
            if (contentLower.includes(queryLower) || queryLower.includes(contentLower)) {
                similarity = Math.min(1.0, similarity + 0.5);
            }
            
            return {
                ...memory,
                similarity,
                content: memory.content,
                metadata: {
                    category: memory.category,
                    extractedAt: memory.timestamp,
                    emotionalContext: memory.emotionalContext
                }
            };
        })
        .filter(memory => memory.similarity >= minSimilarity)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

        return {
            insights: scoredMemories,
            stats: {
                totalCandidates: userMemories.length,
                filteredResults: scoredMemories.length,
                querySimilarityThreshold: minSimilarity,
                averageSimilarity: scoredMemories.length > 0 
                    ? scoredMemories.reduce((sum, m) => sum + m.similarity, 0) / scoredMemories.length 
                    : 0,
                topSimilarity: scoredMemories.length > 0 ? scoredMemories[0].similarity : 0,
                categoriesFound: [...new Set(scoredMemories.map(m => m.category))]
            }
        };
    }

    async getUserInsightsByCategory(
        userId: string, 
        category?: string, 
        userPersonaId?: string, 
        limit?: number
    ): Promise<any[]> {
        return Array.from(this.memories.values())
            .filter(memory => {
                if (memory.userId !== userId) return false;
                if (category && memory.category !== category) return false;
                if (userPersonaId && memory.userPersonaId !== userPersonaId) return false;
                return true;
            })
            .slice(0, limit || 10)
            .map(memory => ({
                content: memory.content,
                metadata: {
                    category: memory.category,
                    extractedAt: memory.timestamp,
                    emotionalContext: memory.emotionalContext
                }
            }));
    }

    async checkHealth(): Promise<any> {
        return {
            status: 'healthy',
            chromaDB: true,
            embeddings: true,
            router: {
                isReady: true,
                healthyHosts: 1,
                totalHosts: 1
            }
        };
    }
}

/**
 * Simulate a conversation where the AI decides what to remember
 */
async function simulateConversationWithMemory() {
    console.log('🎯 Starting RAG Memory System Demo...\n');

    // Setup
    const userId = 'demo_user_123';
    const conversationId = 'conv_demo_' + Date.now();
    
    // Create mock ChromaDB service
    const mockChromaDB = new MockChromaDBService() as any;
    
    // Create RAG service
    const ragService = new RAGService({
        userId,
        conversationId,
        userPersonaId: 'persona_123',
        basePersonaId: 'base_persona_456'
    }, mockChromaDB);

    // Create AI model (using free Ollama model)
    const aiModel = AIModelFactory.createOllamaChatModel('qwen2.5:3b');
    await aiModel.ensureReady();

    // Create RAG tools
    const ragTools = createRAGTools(ragService);
    
    // Convert RAG tools to the format expected by registerTools
    const toolsForRegistration = [
        {
            name: ragTools.storeMemory.name,
            description: ragTools.storeMemory.description,
            parameters: ragTools.storeMemory.parameters,
            handler: ragTools.storeMemory.handler
        },
        {
            name: ragTools.searchMemory.name,
            description: ragTools.searchMemory.description,
            parameters: ragTools.searchMemory.parameters,
            handler: ragTools.searchMemory.handler
        },
        {
            name: ragTools.analyzeConversation.name,
            description: ragTools.analyzeConversation.description,
            parameters: ragTools.analyzeConversation.parameters,
            handler: ragTools.analyzeConversation.handler
        },
        ToolBuilder.commonTools.getCurrentTime
    ];

    // Register tools with the AI model
    aiModel.registerTools(toolsForRegistration);

    console.log('🧠 RAG Memory System initialized');
    console.log(`👤 User ID: ${userId}`);
    console.log(`💬 Conversation ID: ${conversationId}\n`);

    // Simulate a conversation
    const conversations = [
        {
            user: "Hi! My name is Alex and I'm a software engineer working at TechCorp. I really love building AI applications and I'm particularly interested in machine learning.",
            aiPrompt: "The user just introduced themselves. Analyze this conversation to see if there's any valuable information worth storing in memory, and if so, store it appropriately."
        },
        {
            user: "I'm planning to learn more about neural networks this year. I want to build a recommendation system for my company. Also, I hate working with outdated databases.",
            aiPrompt: "The user shared some goals and preferences. Check if this contains information worth remembering."
        },
        {
            user: "Do you remember what my name is? And what are my interests?",
            aiPrompt: "The user is asking about previously shared information. Search your memory for relevant details about this user."
        },
        {
            user: "I just discovered that transformers can be used for time series forecasting, not just NLP. That's fascinating!",
            aiPrompt: "The user learned something new. Determine if this is worth storing as a fact or insight."
        },
        {
            user: "By the way, I live in San Francisco and I'm good at Python and JavaScript programming.",
            aiPrompt: "More personal information. Analyze and store if valuable."
        }
    ];

    for (let i = 0; i < conversations.length; i++) {
        const { user, aiPrompt } = conversations[i];
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`💬 CONVERSATION TURN ${i + 1}`);
        console.log(`${'='.repeat(60)}`);
        console.log(`👤 User: ${user}`);
        console.log(`\n🤖 AI Processing...`);

        try {
            // AI processes the conversation with tools
            const response = await aiModel.chatWithTools([
                {
                    role: 'system',
                    content: `You are an AI assistant with a memory system. You can:
1. Analyze conversations to identify valuable information
2. Store important information in your memory 
3. Search your memory for relevant information

When a user shares information, first analyze it to see if it contains valuable details worth storing (like personal info, preferences, goals, facts, etc.). If so, store the appropriate information with the right category and importance level.

When asked about previous information, search your memory first.

Always explain your reasoning for storing or not storing information.`
                },
                {
                    role: 'user',
                    content: `User message: "${user}"\n\nInstructions: ${aiPrompt}`
                }
            ]);

            console.log(`\n🤖 AI Response: ${response.content}`);

            // Show any tool calls that were made
            if (response.tool_calls && response.tool_calls.length > 0) {
                console.log(`\n🔧 Tools used: ${response.tool_calls.map((tc: any) => tc.function.name).join(', ')}`);
            }

        } catch (error) {
            console.error(`❌ Error in conversation turn ${i + 1}:`, error);
        }

        // Add a small delay between turns
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Final memory summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('📊 FINAL MEMORY SUMMARY');
    console.log(`${'='.repeat(60)}`);

    try {
        const categories = ['personal_info', 'preferences', 'goals', 'facts', 'skills'];
        
        for (const category of categories) {
            const memories = await mockChromaDB.getUserInsightsByCategory(userId, category);
            if (memories.length > 0) {
                console.log(`\n📂 ${category.toUpperCase()}:`);
                memories.forEach((memory: any, idx: number) => {
                    console.log(`  ${idx + 1}. ${memory.content}`);
                });
            }
        }

        // Test memory search
        console.log(`\n🔍 TESTING MEMORY SEARCH:`);
        const searchQueries = ['programming', 'Alex', 'goals'];
        
        for (const query of searchQueries) {
            const results = await ragService.searchMemory(query, { limit: 3 });
            console.log(`\nQuery: "${query}"`);
            if (results.success && results.memories.length > 0) {
                results.memories.forEach((memory: any, idx: number) => {
                    console.log(`  ${idx + 1}. [${memory.similarity.toFixed(2)}] ${memory.content}`);
                });
            } else {
                console.log('  No relevant memories found');
            }
        }

    } catch (error) {
        console.error('❌ Error generating memory summary:', error);
    }

    console.log(`\n✅ Demo completed! The AI successfully:`);
    console.log(`   • Analyzed conversations for valuable information`);
    console.log(`   • Automatically decided what to store in memory`);
    console.log(`   • Retrieved relevant information when asked`);
    console.log(`   • Organized information by categories and importance`);
}

/**
 * Test the conversation analysis feature
 */
async function testConversationAnalysis() {
    console.log('\n🧪 Testing Conversation Analysis...\n');

    const ragService = new RAGService({
        userId: 'test_user',
        conversationId: 'test_conv'
    });

    const testConversations = [
        "Hi there! How are you today?",
        "My name is Sarah and I work as a data scientist at Google. I love machine learning and I'm trying to learn more about deep learning this year.",
        "I just learned that you can use transformers for computer vision too! That's really interesting. I want to remember this fact.",
        "I prefer tea over coffee and I hate working late nights. My goal is to publish a research paper next year."
    ];

    for (const text of testConversations) {
        console.log(`📝 Analyzing: "${text}"`);
        const analysis = ragService.analyzeConversation(text);
        
        console.log(`   Worth storing: ${analysis.worthStoring}`);
        console.log(`   Insights found: ${analysis.totalInsights}`);
        
        if (analysis.insights.length > 0) {
            analysis.insights.forEach((insight: any, idx: number) => {
                console.log(`   ${idx + 1}. [${insight.importance}] ${insight.category}: ${insight.content}`);
            });
        }
        console.log('');
    }
}

// Main execution
async function main() {
    try {
        await testConversationAnalysis();
        await simulateConversationWithMemory();
    } catch (error) {
        console.error('❌ Demo failed:', error);
        process.exit(1);
    }
}

// Run if this file is executed directly
if (require.main === module) {
    main().catch(console.error);
}

export { simulateConversationWithMemory, testConversationAnalysis };
