import {describe, test} from 'node:test';
import * as assert from 'node:assert';
import {AIModel, AIModelApiType, AIModelType} from "../index.js";
import {createTestAgent, testProviders} from './common.js';


describe('AIModel Initialization', () => {

  test('should create AIModel instance for OpenAI provider', () => {
    const client = new AIModel(testProviders.openai);
    assert.strictEqual(client.options.model, testProviders.openai.model);
    assert.strictEqual(client.options.apiType, AIModelApiType.OpenAI);
    assert.strictEqual(client.options.url, testProviders.openai.url);
    assert.strictEqual(client.options.apiKey, testProviders.openai.apiKey);
    assert.strictEqual(typeof client.chatStream, 'function');
    assert.strictEqual(typeof client.ensureReady, 'function');
  });

  test('should not throw error for any valid provider', () => {
    Object.values(testProviders).forEach(provider => {
      assert.doesNotThrow(() => {
        new AIModel(provider);
      }, `Failed to create AIModel for provider: ${provider.apiType}`);
    });
  });

  test('should accept external MockAgent for testing', async () => {
    const mockAgent = createTestAgent();
    const client = new AIModel(testProviders.openai, mockAgent);
    assert.strictEqual(client.options.model, 'gpt-4');
    await mockAgent.close();
  });

  test('should auto-detect model type from model name', (t) => {
    t.test('should auto-detect "embedding" model type', () => {
      const embeddingClient = new AIModel({
        model: 'text-embedding-ada-002',
        apiType: AIModelApiType.OpenAI,
        url: 'http://localhost:1234',
        apiKey: 'test-key'
      });
      assert.strictEqual(embeddingClient.getModelType(), AIModelType.Embedding);
    });
    t.test('should auto-detect "chat" model type', () => {
      const chatClient = new AIModel({
        model: 'gpt-4',
        apiType: AIModelApiType.OpenAI,
        url: 'http://localhost:1234',
        apiKey: 'test-key'
      });
      assert.strictEqual(chatClient.getModelType(), AIModelType.Chat);
    });
  });

  test('should respect explicit model type setting', () => {
    const client = new AIModel({
      ...testProviders.openai,
      model: 'custom-model',
      modelType: AIModelType.Embedding
    });

    assert.strictEqual(client.getModelType(), AIModelType.Embedding);
    assert.strictEqual(client.isEmbeddingModel(), true);
    assert.strictEqual(client.isChatModel(), false);
  });

  test('should have default parameters', () => {
    const client = new AIModel(testProviders.openai);

    // Should have the basic options
    assert.ok(client.options.model);
    assert.ok(client.options.apiType);
    assert.ok(client.options.url);

    // Model type should be inferred if not set
    assert.ok(client.options.modelType);
  });

  test('should properly dispose resources', async () => {
    const client = new AIModel(testProviders.openai);

    // Should not throw when disposing
    await assert.doesNotReject(client.dispose());
  });

  test('should not dispose external agent on cleanup', async () => {
    const mockAgent = createTestAgent();
    const client = new AIModel(testProviders.openai, mockAgent);
    // AIModel should not dispose external agent
    await client.dispose();
    // External agent should still be usable
    await assert.doesNotReject(mockAgent.close());
  });

});
