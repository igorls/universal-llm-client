/**
 * Complete RAG Integration with Real ChromaDBService
 * 
 * This demo shows the complete integration between Universal LLM Client
 * and the aura-companion ChromaDBService for real memory storage and retrieval.
 */

import { AIModelFactory } from '../../factory';
import { ToolBuilder } from '../../tools';
import { RAGService, createRAGTools } from '../../rag-service';

// Import types to avoid circular dependencies
type ChromaDBService = any;

/**
 * Demo configuration
 */
const CONFIG = {
    // User configuration
    userId: 'user_' + Date.now(),
    conversationId: 'conv_' + Date.now(),
    userPersonaId: 'persona_' + Date.now(),
    
    // AI Model configuration
    aiModel: 'qwen2.5:3b', // Free Ollama model
    
    // Demo scenarios
    scenarios: [
        {
            name: "User Introduction",
            user: "Hi! My name is Jordan and I'm a data scientist at AI Research Lab. I specialize in natural language processing and computer vision.",
            prompt: "A user is introducing themselves. Analyze if there's valuable information to store."
        },
        {
            name: "Preferences & Goals",
            user: "I'm really passionate about open-source AI and want to contribute to major ML libraries this year. I prefer Python over R and love working with transformers.",
            prompt: "The user shared goals and preferences. Determine what should be remembered."
        },
        {
            name: "Important Reminder",
            user: "Please remember that I have a presentation about RAG systems to the board next Friday at 3 PM. It's really important for my career.",
            prompt: "The user wants something remembered. Store this important information."
        },
        {
            name: "Skill & Experience",
            user: "I have 5 years of experience with PyTorch and I've published 3 papers on attention mechanisms. I'm also good at system design.",
            prompt: "User shared professional background. Analyze and store relevant information."
        },
        {
            name: "Memory Retrieval Test",
            user: "What do you remember about my background and goals?",
            prompt: "User is asking about stored information. Search memory to provide relevant details."
        }
    ]
};

/**
 * Simulate real ChromaDBService for demonstration
 * In production, replace this with actual ChromaDBService import
 */
class ChromaDBServiceSimulator {
    private insights: Map<string, any> = new Map();
    private nextId = 1;

    async initialize(): Promise<void> {
        console.log('✅ ChromaDB service initialized (simulator)');
    }

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
        extractionType?: string
    ): Promise<string> {
        const id = `insight_${this.nextId++}`;
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
            extractionType: extractionType || 'ai_memory'
        };
        
        this.insights.set(id, insight);
        console.log(`💾 Stored in ChromaDB: [${category}] ${content.substring(0, 60)}${content.length > 60 ? '...' : ''}`);
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
        const userInsights = Array.from(this.insights.values())
            .filter(insight => insight.userId === userId);
        
        // Enhanced similarity scoring
        const scoredInsights = userInsights.map(insight => {
            const contentLower = insight.content.toLowerCase();
            let similarity = 0;
            
            // Word overlap scoring
            const queryWords = queryLower.split(/\s+/).filter((w: string) => w.length > 2);
            const contentWords = contentLower.split(/\s+/).filter((w: string) => w.length > 2);
            const overlap = queryWords.filter(word => 
                contentWords.some((cWord: string) => cWord.includes(word) || word.includes(cWord))
            ).length;
            
            if (queryWords.length > 0) {
                similarity = overlap / queryWords.length;
            }
            
            // Boost for exact matches and important keywords
            if (contentLower.includes(queryLower)) similarity += 0.3;
            if (queryLower.includes('background') && (contentLower.includes('work') || contentLower.includes('experience'))) similarity += 0.2;
            if (queryLower.includes('goal') && contentLower.includes('want')) similarity += 0.2;
            if (queryLower.includes('name') && contentLower.includes('name')) similarity += 0.4;
            
            similarity = Math.min(1.0, similarity);
            
            return {
                ...insight,
                similarity,
                content: insight.content,
                metadata: {
                    category: insight.category,
                    extractedAt: insight.timestamp,
                    confidence: insight.confidence
                }
            };
        })
        .filter(insight => insight.similarity >= minSimilarity)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

        return {
            insights: scoredInsights,
            stats: {
                totalCandidates: userInsights.length,
                filteredResults: scoredInsights.length,
                querySimilarityThreshold: minSimilarity,
                averageSimilarity: scoredInsights.length > 0 
                    ? scoredInsights.reduce((sum, i) => sum + i.similarity, 0) / scoredInsights.length 
                    : 0,
                topSimilarity: scoredInsights.length > 0 ? scoredInsights[0].similarity : 0,
                categoriesFound: [...new Set(scoredInsights.map(i => i.category))]
            }
        };
    }

    async getUserInsightsByCategory(
        userId: string, 
        category?: string, 
        userPersonaId?: string, 
        limit?: number
    ): Promise<any[]> {
        return Array.from(this.insights.values())
            .filter(insight => {
                if (insight.userId !== userId) return false;
                if (category && insight.category !== category) return false;
                if (userPersonaId && insight.userPersonaId !== userPersonaId) return false;
                return true;
            })
            .slice(0, limit || 10)
            .map(insight => ({
                content: insight.content,
                metadata: {
                    category: insight.category,
                    extractedAt: insight.timestamp,
                    confidence: insight.confidence
                }
            }));
    }

    async checkHealth(): Promise<any> {
        return {
            status: 'healthy',
            chromaDB: true,
            embeddings: true
        };
    }
}

/**
 * Main demo function
 */
async function runCompleteRAGDemo() {
    console.log('🚀 Complete RAG Integration Demo');
    console.log('='.repeat(60));
    console.log(`👤 User ID: ${CONFIG.userId}`);
    console.log(`💬 Conversation ID: ${CONFIG.conversationId}`);
    console.log(`🧠 AI Model: ${CONFIG.aiModel}\n`);

    try {
        // 1. Initialize ChromaDB service (simulated)
        console.log('🔧 Initializing ChromaDB service...');
        const chromaDB = new ChromaDBServiceSimulator() as ChromaDBService;
        await chromaDB.initialize();

        // 2. Create RAG service
        console.log('🧠 Setting up RAG service...');
        const ragService = new RAGService({
            userId: CONFIG.userId,
            conversationId: CONFIG.conversationId,
            userPersonaId: CONFIG.userPersonaId,
            basePersonaId: 'base_persona_default'
        }, chromaDB);

        // 3. Initialize AI model
        console.log('🤖 Initializing AI model...');
        const aiModel = AIModelFactory.createOllamaChatModel(CONFIG.aiModel);
        await aiModel.ensureReady();

        // 4. Create and register RAG tools
        console.log('🔧 Registering RAG tools...');
        const ragTools = createRAGTools(ragService);
        const allTools = [
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

        aiModel.registerTools(allTools);

        console.log('✅ Setup complete! Starting conversation simulation...\n');

        // 5. Run conversation scenarios
        for (let i = 0; i < CONFIG.scenarios.length; i++) {
            const scenario = CONFIG.scenarios[i];
            
            console.log(`\n${'='.repeat(60)}`);
            console.log(`📋 SCENARIO ${i + 1}: ${scenario.name}`);
            console.log(`${'='.repeat(60)}`);
            console.log(`👤 User: ${scenario.user}`);
            console.log(`\n🤖 AI Processing (${scenario.prompt})...`);

            try {
                const response = await aiModel.chatWithTools([
                    {
                        role: 'system',
                        content: `You are an AI assistant with a sophisticated memory system. You have these capabilities:

1. **analyze_conversation**: Analyze text to identify valuable information worth storing
2. **store_memory**: Store important information in the memory system with appropriate categories
3. **search_memory**: Search stored memories for relevant information

When users share information:
- First analyze it to see if it contains valuable details (personal info, preferences, goals, facts, etc.)
- If valuable information is found, store it with the appropriate category and importance level
- Always explain your reasoning for storing or not storing information

When users ask about previous information:
- Search your memory for relevant details
- Provide comprehensive answers based on stored information

Categories available: personal_info, preferences, facts, events, relationships, goals, skills, interests, other

Be proactive about storing valuable information and helpful when retrieving it.`
                    },
                    {
                        role: 'user',
                        content: scenario.user
                    }
                ]);

                console.log(`\n🤖 AI Response:`);
                console.log(response.content);

                // Show tool usage
                if (response.tool_calls && response.tool_calls.length > 0) {
                    console.log(`\n🔧 Tools Used: ${response.tool_calls.map((tc: any) => tc.function.name).join(', ')}`);
                }

            } catch (error) {
                console.error(`❌ Error in scenario ${i + 1}:`, error);
            }

            // Delay between scenarios
            if (i < CONFIG.scenarios.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // 6. Final memory summary
        console.log(`\n${'='.repeat(60)}`);
        console.log('📊 FINAL MEMORY SUMMARY');
        console.log(`${'='.repeat(60)}`);

        const categories = ['personal_info', 'preferences', 'goals', 'facts', 'skills', 'events'];
        let totalMemories = 0;

        for (const category of categories) {
            const memories = await chromaDB.getUserInsightsByCategory(CONFIG.userId, category);
            if (memories.length > 0) {
                console.log(`\n📂 ${category.toUpperCase()} (${memories.length} items):`);
                memories.forEach((memory: any, idx: number) => {
                    console.log(`  ${idx + 1}. ${memory.content}`);
                    totalMemories++;
                });
            }
        }

        console.log(`\n📈 STATISTICS:`);
        console.log(`  • Total memories stored: ${totalMemories}`);
        console.log(`  • Categories used: ${categories.filter(async cat => {
            const memories = await chromaDB.getUserInsightsByCategory(CONFIG.userId, cat);
            return memories.length > 0;
        }).length}`);
        console.log(`  • User ID: ${CONFIG.userId}`);
        console.log(`  • Conversation ID: ${CONFIG.conversationId}`);

        console.log(`\n✅ Complete RAG Integration Demo finished successfully!`);
        console.log(`\n🔗 To use with real ChromaDBService:`);
        console.log(`1. Replace ChromaDBServiceSimulator with real ChromaDBService`);
        console.log(`2. Set up proper environment variables (CHROMA_HOST, CHROMA_PORT, etc.)`);
        console.log(`3. Start ChromaDB server and Ollama with embedding model`);
        console.log(`4. The AI will automatically store and retrieve real memories!`);

    } catch (error) {
        console.error('❌ Demo failed:', error);
        process.exit(1);
    }
}

// Export for integration
export {
    runCompleteRAGDemo,
    ChromaDBServiceSimulator,
    CONFIG
};

// Run if executed directly
if (require.main === module) {
    runCompleteRAGDemo().catch(console.error);
}
