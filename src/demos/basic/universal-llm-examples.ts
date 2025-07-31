import { AIModelFactory } from "./factory";

/**
 * Example: Complete AI Application Setup
 * 
 * This example shows how to set up a complete AI application
 * with both chat and embedding capabilities using the factory.
 */
export async function createAIApplicationExample() {

    console.log('\n🏗️  Example: Setting up a complete AI application...\n');

    // Method 1: Using the factory for easy setup
    const aiSetup = AIModelFactory.createCompleteSetup({
        ollama: {
            chatModel: 'gemma3:4b-it-qat',
            embeddingModel: 'snowflake-arctic-embed2:latest',
            url: 'http://localhost:11434'
        },
        openai: {
            chatModel: 'google/gemma-3-4b',
            embeddingModel: 'text-embedding-snowflake-arctic-embed-l-v2.0',
            url: 'http://localhost:1234/v1'
            // apiKey: 'your-api-key-here' // For real OpenAI API
        },
        google: {
            chatModel: 'gemma-3-4b-it',
            apiKey: 'AIzaSyBDbo7iVNEuCcRNTgDIgRrkGpFKisXXnm0'
        }
    });

    // Method 2: Individual setup for specific use cases
    const chatModel = AIModelFactory.createOllamaChatModel('gemma3:4b-it-qat');
    const embeddingModel = AIModelFactory.createOllamaEmbeddingModel('snowflake-arctic-embed2:latest');

    // Method 3: Google-specific setup
    const googleChatModel = AIModelFactory.createGoogleChatModel(
        'gemma-3-4b-it',
        'AIzaSyBDbo7iVNEuCcRNTgDIgRrkGpFKisXXnm0'
    );

    // Example usage patterns:
    
    console.log('🤖 Testing Google Generative AI...');
    try {
        const googleResponse = await googleChatModel.chat([
            { role: 'user', content: 'What is the capital of France?' }
        ]);
        console.log('Google Response:', googleResponse.content);
    } catch (error) {
        console.error('Google API Error:', error);
    }

    console.log('\n🌊 Testing Google Streaming...');
    try {
        const streamingGenerator = googleChatModel.chatStream([
            { role: 'user', content: 'Count from 1 to 5, explaining each number briefly.' }
        ]);

        for await (const chunk of streamingGenerator) {
            process.stdout.write(chunk);
        }
        console.log('\n✅ Google streaming completed');
    } catch (error) {
        console.error('Google Streaming Error:', error);
    }
    
    // 1. Simple chat
    const chatResponse = await aiSetup.ollama.chat.chat([
        { role: 'user', content: 'What is machine learning?' }
    ]);
    
    // 2. Document embedding for search
    const documents = [
        'Machine learning is a subset of AI',
        'Neural networks are inspired by the brain',
        'TypeScript is a typed superset of JavaScript'
    ];
    
    const embeddings = await Promise.all(
        documents.map(doc => aiSetup.ollama.embedding.embed(doc))
    );
    
    // 3. Cross-provider comparison including Google
    const comparisons = await Promise.all([
        aiSetup.ollama?.chat?.chat([{ role: 'user', content: 'What is the capital of France?' }]).catch(() => null),
        aiSetup.openai?.chat?.chat([{ role: 'user', content: 'What is the capital of France?' }]).catch(() => null),
        aiSetup.google?.chat?.chat([{ role: 'user', content: 'What is the capital of France?' }]).catch(() => null)
    ]);

    return {
        aiSetup,
        chatModel,
        embeddingModel,
        googleChatModel,
        examples: {
            chatResponse,
            embeddings,
            comparisons: {
                ollama: comparisons[0],
                openai: comparisons[1],
                google: comparisons[2]
            }
        }
    };
}

/**
 * Test Google API specifically
 */
export async function testGoogleAPI() {
    console.log('🧪 Testing Google Generative AI API...\n');

    const googleModel = AIModelFactory.createGoogleChatModel(
        'gemma-3-4b-it',
        'AIzaSyBDbo7iVNEuCcRNTgDIgRrkGpFKisXXnm0'
    );

    try {
        // Test basic chat
        console.log('💬 Basic chat test...');
        const response = await googleModel.chat([
            { role: 'user', content: 'Hello! Can you tell me about TypeScript?' }
        ]);
        console.log('Response:', response.content);

        // Test streaming
        console.log('\n🌊 Streaming test...');
        const streamResponse = googleModel.chatStream([
            { role: 'user', content: 'Tell me a short story about a robot learning to code.' }
        ]);

        let fullResponse = '';
        for await (const chunk of streamResponse) {
            process.stdout.write(chunk);
            fullResponse += chunk;
        }
        console.log('\n✅ Streaming completed');

        // Test conversation with context
        console.log('\n💭 Conversation with context...');
        const conversationResponse = await googleModel.chat([
            { role: 'user', content: 'What is the capital of France?' },
            { role: 'assistant', content: 'The capital of France is Paris.' },
            { role: 'user', content: 'What is its population?' }
        ]);
        console.log('Conversation Response:', conversationResponse.content);

        console.log('\n✅ All Google API tests completed successfully!');
        return { success: true, model: googleModel };

    } catch (error) {
        console.error('❌ Google API test failed:', error);
        return { success: false, error };
    }
}

// Uncomment to run the examples
// testGoogleAPI().then(result => {
//     console.log('Google API test complete:', result.success);
// });