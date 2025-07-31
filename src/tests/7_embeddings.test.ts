import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { AIModel, AIModelType } from "../index.js";
import { createTestAgent, testProviders } from './common.js';

describe('Embeddings Functionality', () => {

    test('should create embedding client with embedding model type', async () => {
        const client = new AIModel({
            ...testProviders.openai,
            modelType: AIModelType.Embedding,
            model: 'text-embedding-ada-002'
        });

        assert.ok(client);

        await client.dispose();
    });

    test('should generate embeddings for single text', async () => {
        const mockAgent = createTestAgent();
        const mockPool = mockAgent.get('http://localhost:1234');

        // Mock OpenAI embeddings response
        mockPool.intercept({
            path: '/v1/embeddings',
            method: 'POST'
        }).reply(200, {
            object: 'list',
            data: [{
                object: 'embedding',
                index: 0,
                embedding: new Array(1536).fill(0).map(() => (Math.random() - 0.5) * 0.1)
            }],
            model: 'text-embedding-ada-002',
            usage: {
                prompt_tokens: 8,
                total_tokens: 8
            }
        });

        const client = new AIModel({
            ...testProviders.openai,
            modelType: AIModelType.Embedding,
            model: 'text-embedding-ada-002'
        }, mockAgent);

        const embedding = await client.embed('Hello world, this is a test text for embedding.');

        assert.ok(embedding);
        assert.ok(Array.isArray(embedding));
        assert.ok(embedding.length > 0);

        // Verify all values are numbers
        for (const value of embedding) {
            assert.strictEqual(typeof value, 'number');
            assert.ok(isFinite(value));
        }

        await client.dispose();
    });

    test('should generate embeddings for multiple texts', async () => {
        const mockAgent = createTestAgent();
        const mockPool = mockAgent.get('http://localhost:1234');

        const texts = [
            'First document about artificial intelligence',
            'Second document about machine learning',
            'Third document about natural language processing'
        ];

        // Mock OpenAI embeddings response for multiple texts
        mockPool.intercept({
            path: '/v1/embeddings',
            method: 'POST'
        }).reply(200, {
            object: 'list',
            data: texts.map((_, index) => ({
                object: 'embedding',
                index,
                embedding: new Array(1536).fill(0).map(() => (Math.random() - 0.5) * 0.1)
            })),
            model: 'text-embedding-ada-002',
            usage: {
                prompt_tokens: 24,
                total_tokens: 24
            }
        });

        const client = new AIModel({
            ...testProviders.openai,
            modelType: AIModelType.Embedding,
            model: 'text-embedding-ada-002'
        }, mockAgent);

        const embeddings = await client.embedArray(texts);

        assert.ok(embeddings);
        assert.ok(Array.isArray(embeddings));
        assert.strictEqual(embeddings.length, texts.length);

        // Verify each embedding
        for (const embedding of embeddings) {
            assert.ok(Array.isArray(embedding));
            assert.ok(embedding.length > 0);

            for (const value of embedding) {
                assert.strictEqual(typeof value, 'number');
                assert.ok(isFinite(value));
            }
        }

        await client.dispose();
    });

    test('should handle empty text for embedding', async () => {
        const mockAgent = createTestAgent();
        const mockPool = mockAgent.get('http://localhost:1234');

        // Mock OpenAI embeddings response for empty text
        mockPool.intercept({
            path: '/v1/embeddings',
            method: 'POST'
        }).reply(200, {
            object: 'list',
            data: [{
                object: 'embedding',
                index: 0,
                embedding: new Array(1536).fill(0).map(() => (Math.random() - 0.5) * 0.1)
            }],
            model: 'text-embedding-ada-002',
            usage: {
                prompt_tokens: 1,
                total_tokens: 1
            }
        });

        const client = new AIModel({
            ...testProviders.openai,
            modelType: AIModelType.Embedding,
            model: 'text-embedding-ada-002'
        }, mockAgent);

        const embedding = await client.embed('');

        assert.ok(embedding);
        assert.ok(Array.isArray(embedding));

        await client.dispose();
    });

    test('should prevent chat operations on embedding model', async () => {
        const client = new AIModel({
            ...testProviders.openai,
            modelType: AIModelType.Embedding,
            model: 'text-embedding-ada-002'
        });

        try {
            await client.chat([{ role: 'user', content: 'Hello' }]);
            assert.fail('Should have thrown an error');
        } catch (error) {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes('not supported by model type'));
        }

        await client.dispose();
    });

    test('should prevent streaming on embedding model', async () => {
        const client = new AIModel({
            ...testProviders.openai,
            modelType: AIModelType.Embedding,
            model: 'text-embedding-ada-002'
        });

        try {
            const stream = client.chatStream([{ role: 'user', content: 'Hello' }]);
            assert.fail('Should have thrown an error');
        } catch (error) {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes('not supported by model type'));
        }

        await client.dispose();
    });

    test('should work with Ollama embedding models', async () => {
        const mockAgent = createTestAgent();
        const mockPool = mockAgent.get('http://localhost:11434');

        // Mock Ollama embeddings response
        mockPool.intercept({
            path: '/api/embeddings',
            method: 'POST'
        }).reply(200, {
            embedding: new Array(768).fill(0).map(() => (Math.random() - 0.5) * 0.1)
        });

        const client = new AIModel({
            ...testProviders.ollama,
            modelType: AIModelType.Embedding,
            model: 'nomic-embed-text'
        }, mockAgent);

        const embedding = await client.embed('Test text for Ollama embedding');

        assert.ok(embedding);
        assert.ok(Array.isArray(embedding));
        assert.ok(embedding.length > 0);

        await client.dispose();
    });

    test('should handle embedding batch with mixed content lengths', async () => {
        const mockAgent = createTestAgent();
        const mockPool = mockAgent.get('http://localhost:1234');

        const texts = [
            'Short',
            'Medium length text with some more content',
            'Very long text with lots of content and details that goes on and on with multiple sentences and various topics covered in great detail to test the embedding capability with longer documents.'
        ];

        // Mock OpenAI embeddings response for mixed lengths
        mockPool.intercept({
            path: '/v1/embeddings',
            method: 'POST'
        }).reply(200, {
            object: 'list',
            data: texts.map((_, index) => ({
                object: 'embedding',
                index,
                embedding: new Array(1536).fill(0).map(() => (Math.random() - 0.5) * 0.1)
            })),
            model: 'text-embedding-ada-002',
            usage: {
                prompt_tokens: 50,
                total_tokens: 50
            }
        });

        const client = new AIModel({
            ...testProviders.openai,
            modelType: AIModelType.Embedding,
            model: 'text-embedding-ada-002'
        }, mockAgent);

        const embeddings = await client.embedArray(texts);

        assert.strictEqual(embeddings.length, texts.length);

        // All embeddings should have the same dimensions
        const firstLength = embeddings[0].length;
        for (const embedding of embeddings) {
            assert.strictEqual(embedding.length, firstLength);
        }

        await client.dispose();
    });

    test('should handle embedding errors gracefully', async () => {
        const mockAgent = createTestAgent();
        const mockPool = mockAgent.get('http://localhost:1234');

        // Mock error response
        mockPool.intercept({
            path: '/v1/embeddings',
            method: 'POST'
        }).reply(500, {
            error: {
                message: 'Internal server error',
                type: 'server_error'
            }
        });

        const client = new AIModel({
            ...testProviders.openai,
            modelType: AIModelType.Embedding,
            model: 'text-embedding-ada-002'
        }, mockAgent);

        try {
            await client.embed('This should fail');
            assert.fail('Should have thrown an error');
        } catch (error) {
            assert.ok(error instanceof Error);
        }

        await client.dispose();
    });

    test('should validate embedding result format', async () => {
        const mockAgent = createTestAgent();
        const mockPool = mockAgent.get('http://localhost:1234');

        // Mock OpenAI embeddings response with specific values
        const testEmbedding = new Array(1536).fill(0).map(() => (Math.random() - 0.5) * 0.5);
        mockPool.intercept({
            path: '/v1/embeddings',
            method: 'POST'
        }).reply(200, {
            object: 'list',
            data: [{
                object: 'embedding',
                index: 0,
                embedding: testEmbedding
            }],
            model: 'text-embedding-ada-002',
            usage: {
                prompt_tokens: 3,
                total_tokens: 3
            }
        });

        const client = new AIModel({
            ...testProviders.openai,
            modelType: AIModelType.Embedding,
            model: 'text-embedding-ada-002'
        }, mockAgent);

        const embedding = await client.embed('Test validation');

        // Should be an array of numbers
        assert.ok(Array.isArray(embedding));
        assert.ok(embedding.length > 0);

        // All values should be finite numbers
        for (const value of embedding) {
            assert.strictEqual(typeof value, 'number');
            assert.ok(isFinite(value));
            assert.ok(!isNaN(value));
        }

        // Values should be reasonable (for most embedding models)
        for (const value of embedding) {
            assert.ok(value >= -2);
            assert.ok(value <= 2);
        }

        await client.dispose();
    });

    test('should handle null and undefined inputs properly', async () => {
        const client = new AIModel({
            ...testProviders.openai,
            modelType: AIModelType.Embedding,
            model: 'text-embedding-ada-002'
        });

        // Test with null input (should handle gracefully)
        try {
            await client.embed(null as any);
            assert.fail('Should have thrown an error');
        } catch (error) {
            assert.ok(error instanceof Error);
        }

        // Test with undefined input (should handle gracefully)
        try {
            await client.embed(undefined as any);
            assert.fail('Should have thrown an error');
        } catch (error) {
            assert.ok(error instanceof Error);
        }

        await client.dispose();
    });

});
