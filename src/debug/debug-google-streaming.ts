import {request} from 'undici';

/**
 * Debug Google streaming by examining raw responses
 */
async function debugGoogleStreaming() {
    console.log('🔍 Debugging Google Generative AI Streaming...\n');

    const apiKey = 'AIzaSyBDbo7iVNEuCcRNTgDIgRrkGpFKisXXnm0';
    const model = 'gemma-3-4b-it';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent`;

    // First, let's try the raw Google API call to see what the response looks like
    const url = new URL(endpoint);
    url.searchParams.set('key', apiKey);

    const requestBody = {
        contents: [
            {
                role: 'user',
                parts: [{ text: 'Count from 1 to 3 briefly.' }]
            }
        ],
        generationConfig: {
            responseMimeType: 'text/plain'
        }
    };

    console.log('📡 Making raw request to:', url.toString());
    console.log('📦 Request body:', JSON.stringify(requestBody, null, 2));

    try {
        const response = await request(url.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
            },
            body: JSON.stringify(requestBody)
        });

        console.log('📋 Response status:', response.statusCode);
        console.log('📋 Response headers:', response.headers);

        if (response.statusCode >= 400) {
            const errorText = await response.body.text();
            console.error('❌ Error response:', errorText);
            return;
        }

        console.log('\n🌊 Raw streaming response:');
        console.log('---');

        const decoder = new TextDecoder();
        let chunkCount = 0;

        for await (const chunk of response.body) {
            chunkCount++;
            const text = decoder.decode(chunk, { stream: true });
            console.log(`[Raw Chunk ${chunkCount}]:`, JSON.stringify(text));

            // Parse each line
            const lines = text.split('\n').filter(line => line.trim());
            for (const line of lines) {
                console.log(`[Line]: "${line}"`);

                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    console.log(`[Data]: "${data}"`);

                    if (data !== '[DONE]') {
                        try {
                            const parsed = JSON.parse(data);
                            console.log('[Parsed JSON]:', JSON.stringify(parsed, null, 2));

                            // Check Google's response structure
                            if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
                                console.log('[Content]:', parsed.candidates[0].content.parts[0].text);
                            }
                        } catch (parseError) {
                            console.log('[Parse Error]:', parseError);
                        }
                    }
                }
            }
        }

        console.log('---');
        console.log(`✅ Raw test completed with ${chunkCount} chunks`);

    } catch (error) {
        console.error('❌ Raw test failed:', error);
    }
}

// Run the debug test
debugGoogleStreaming();
