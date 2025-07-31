import { AIModelFactory } from "../factory";

/**
 * Focused test for Google Generative AI streaming
 */
async function testGoogleStreaming() {
    console.log('🧪 Testing Google Generative AI Streaming Only...\n');

    const googleModel = AIModelFactory.createGoogleChatModel(
        'gemma-3-4b-it',
        'AIzaSyBDbo7iVNEuCcRNTgDIgRrkGpFKisXXnm0'
    );

    try {
        console.log('🌊 Starting Google streaming test...');
        console.log('Question: "Count from 1 to 5, explaining each number briefly."\n');
        console.log('Streaming response:');
        console.log('---');

        const streamResponse = googleModel.chatStream([
            { role: 'user', content: 'Count from 1 to 5, explaining each number briefly.' }
        ]);

        let chunkCount = 0;
        let fullResponse = '';
        
        for await (const chunk of streamResponse) {
            chunkCount++;
            console.log(`[Chunk ${chunkCount}]: "${chunk}"`);
            process.stdout.write(chunk);
            fullResponse += chunk;
        }
        
        console.log('\n---');
        console.log(`✅ Streaming completed! Received ${chunkCount} chunks`);
        console.log(`Full response length: ${fullResponse.length} characters`);
        
        if (chunkCount === 0) {
            console.log('❌ No chunks received - streaming might not be working');
        } else {
            console.log('✅ Streaming is working correctly!');
        }

        return { success: true, chunkCount, fullResponse };

    } catch (error) {
        console.error('❌ Google streaming test failed:', error);
        console.error('Error details:', {
            message: (error as Error).message,
            stack: (error as Error).stack
        });
        return { success: false, error };
    }
}

// Run the test
testGoogleStreaming().then(result => {
    if (result.success) {
        console.log(`\n🎉 Test completed successfully with ${result.chunkCount} chunks`);
    } else {
        console.log('\n💥 Test failed');
    }
});
