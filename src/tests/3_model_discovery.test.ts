import { describe, test, } from 'node:test';
import { strictEqual } from "node:assert";
import { AIModel, AIModelApiType } from "../index.js";


describe('Model Discovery', () => {

  let sampleOpenAiModel: string = '';

  test('should fetch models from OpenAI-compatible provider', async () => {
    const models = await AIModel.getModels(AIModelApiType.OpenAI, 'http://localhost:1234');
    strictEqual(Array.isArray(models), true);
    strictEqual(models.length > 0, true);
    sampleOpenAiModel = models[0];
  });

  test('should fetch models from Ollama provider', async () => {
    const models = await AIModel.getModels(AIModelApiType.Ollama, 'http://localhost:11434');
    strictEqual(Array.isArray(models), true);
    strictEqual(models.length > 0, true);
  });

  test('should handle unreachable provider gracefully', async () => {
    const models = await AIModel.getModels(AIModelApiType.OpenAI, 'http://localhost:9998');
    strictEqual(Array.isArray(models), true);
    strictEqual(models.length, 0);
  });

  test('should respect timeout option', async () => {
    // This test uses a mock endpoint that delays response
    const startTime = Date.now();
    const models = await AIModel.getModels(AIModelApiType.OpenAI, 'http://localhost:9999/error/timeout');
    const duration = Date.now() - startTime;
    strictEqual(Array.isArray(models), true);
    strictEqual(models.length, 0);
    // Should timeout quickly, not wait the full 10 seconds
    strictEqual(duration < 3000, true);
  });

  test('instance getHostModels should work', async () => {
    const client = new AIModel({
      model: sampleOpenAiModel,
      apiType: AIModelApiType.OpenAI,
      url: 'http://localhost:1234'
    });
    const models = await client.getHostModels();
    strictEqual(Array.isArray(models), true);
    strictEqual(models.length > 0, true);
    await client.dispose();
  });

});
