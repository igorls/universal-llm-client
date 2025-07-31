/**
 * Real ChromaDB RAG Integration Demo
 * 
 * This demo shows how to integrate the RAG memory tools with the actual
 * ChromaDBService from the aura-companion backend.
 */

import { AIModelFactory } from '../../factory';
import { ToolBuilder } from '../../tools';
import { RAGService, createRAGTools } from '../../rag-service';

// Instructions for running with real ChromaDB
const SETUP_INSTRUCTIONS = `
🔧 SETUP INSTRUCTIONS FOR REAL CHROMADB INTEGRATION:

1. Start ChromaDB server:
   docker run -p 8000:8000 chromadb/chroma:latest

2. Start Ollama with embedding model:
   ollama pull snowflake-arctic-embed2:latest
   ollama serve

3. Set environment variables:
   export CHROMA_HOST=localhost
   export CHROMA_PORT=8000
   export OLLAMA_BASE_URL=http://localhost:11434
   export OLLAMA_EMBEDDING_MODEL=snowflake-arctic-embed2:latest

4. Import ChromaDBService in this file and replace MockChromaDBService
`;

/**
 * Basic RAG demo with simplified conversation analysis
 */
async function basicRAGDemo() {
    console.log('🧠 Basic RAG Memory Demo\n');
    console.log(SETUP_INSTRUCTIONS);
    console.log('🎯 Running with mock service for demonstration...\n');

    // Setup with mock service (replace with real ChromaDBService)
    const userId = 'demo_user_' + Date.now();
    const conversationId = 'conv_' + Date.now();
    
    const ragService = new RAGService({
        userId,
        conversationId,
        userPersonaId: 'persona_demo',
        basePersonaId: 'base_demo'
    });

    // Create AI model
    const aiModel = AIModelFactory.createOllamaChatModel('qwen2.5:3b');
    await aiModel.ensureReady();

    // Create and register RAG tools
    const ragTools = createRAGTools(ragService);
    const tools = [
        {
            name: ragTools.analyzeConversation.name,
            description: ragTools.analyzeConversation.description,
            parameters: ragTools.analyzeConversation.parameters,
            handler: ragTools.analyzeConversation.handler
        },
        ToolBuilder.commonTools.getCurrentTime
    ];

    aiModel.registerTools(tools);

    console.log('🧠 RAG Service initialized (mock mode)');
    console.log(`👤 User ID: ${userId}`);
    console.log(`💬 Conversation ID: ${conversationId}\n`);

    // Test conversation analysis
    const testConversations = [
        "Hi! My name is Emma and I'm a product manager at StartupCorp.",
        "I really love design thinking and I want to learn more about AI this year.",
        "I prefer working remotely and I hate long meetings that could be emails.",
        "Just remember that I have a meeting with the CEO next Wednesday.",
        "Do you know what my professional goals are?"
    ];

    for (let i = 0; i < testConversations.length; i++) {
        const userMessage = testConversations[i];
        
        console.log(`\n${'─'.repeat(50)}`);
        console.log(`💬 Conversation ${i + 1}:`);
        console.log(`👤 User: ${userMessage}`);

        try {
            // AI analyzes the conversation
            const response = await aiModel.chatWithTools([
                {
                    role: 'system',
                    content: `You are an AI assistant that can analyze conversations to identify valuable information.

When a user shares information, use the analyze_conversation tool to identify what information might be worth storing in memory for future reference.

Explain what you found and whether the information seems valuable for long-term storage.`
                },
                {
                    role: 'user',
                    content: `Please analyze this conversation: "${userMessage}"`
                }
            ]);

            console.log(`🤖 AI: ${response.content}`);

        } catch (error) {
            console.error(`❌ Error in conversation ${i + 1}:`, error);
        }

        // Small delay between conversations
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('✅ Demo completed successfully!');
    console.log('\n🔗 To use with real ChromaDB:');
    console.log('1. Follow the setup instructions above');
    console.log('2. Import ChromaDBService');
    console.log('3. Replace the mock service with real ChromaDBService instance');
    console.log('4. Add store_memory and search_memory tools to the demo');
}

/**
 * Example of how to integrate with real ChromaDBService
 */
function integrationExample() {
    console.log(`
📖 INTEGRATION EXAMPLE:

// 1. Import the real ChromaDB service
import { ChromaDBService } from '../../../services/ChromaDBService';

// 2. Create and initialize ChromaDB service
const chromaDB = new ChromaDBService();
await chromaDB.initialize();

// 3. Create RAG service with real ChromaDB
const ragService = new RAGService({
    userId: 'real_user_id',
    conversationId: 'real_conversation_id'
}, chromaDB);

// 4. Create all RAG tools (including store_memory and search_memory)
const ragTools = createRAGTools(ragService);

// 5. Register all tools with AI model
const allTools = [
    ragTools.storeMemory,
    ragTools.searchMemory, 
    ragTools.analyzeConversation
];

aiModel.registerTools(allTools);

// 6. AI can now store and retrieve memories from ChromaDB!
const response = await aiModel.chatWithTools([
    { role: 'user', content: 'Remember that I love pizza and work as a developer' }
]);
`);
}

/**
 * Quick test of conversation analysis without AI
 */
function testAnalysisOnly() {
    console.log('\n🧪 Testing Conversation Analysis Engine...\n');

    const ragService = new RAGService({
        userId: 'test_user',
        conversationId: 'test_conv'
    });

    const testTexts = [
        "Hello, how are you today?",
        "My name is Alex and I work as a software engineer at TechCorp",
        "I love machine learning and want to build my own AI startup",
        "Remember that I have a dentist appointment next Friday",
        "I prefer tea over coffee and I hate working late nights"
    ];

    testTexts.forEach((text, i) => {
        console.log(`${i + 1}. Analyzing: "${text}"`);
        const analysis = ragService.analyzeConversation(text);
        
        console.log(`   → Worth storing: ${analysis.worthStoring ? '✅' : '❌'}`);
        console.log(`   → Insights: ${analysis.totalInsights}`);
        
        if (analysis.insights.length > 0) {
            analysis.insights.forEach((insight: any, idx: number) => {
                console.log(`     ${idx + 1}. [${insight.importance}] ${insight.category}: ${insight.content}`);
            });
        }
        console.log('');
    });
}

// Main execution
async function main() {
    try {
        console.log('🚀 RAG Memory System Demos\n');
        
        // Run tests
        testAnalysisOnly();
        await basicRAGDemo();
        integrationExample();
        
    } catch (error) {
        console.error('❌ Demo failed:', error);
        process.exit(1);
    }
}

// Run if this file is executed directly
if (require.main === module) {
    main().catch(console.error);
}

export { basicRAGDemo, testAnalysisOnly, integrationExample };
