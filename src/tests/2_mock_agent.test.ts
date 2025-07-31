import {after, before, describe, test} from 'node:test';
import {MockAgent, setGlobalDispatcher} from "undici";

import {AIModel} from '../universal-llm-client.js';
import {createTestAgent, testProviders} from './common.js';
import assert from 'node:assert';
import {AIModelType} from '../interfaces.js';

let mockAgent: MockAgent;

describe('MockAgent Dependency Injection', () => {

  before(() => {
    // Create MockAgent
    mockAgent = createTestAgent();
    setGlobalDispatcher(mockAgent);

    // Configure mock responses
    const chatResponse = {
      id: 'chatcmpl-test123',
      object: 'chat.completion',
      created: 1703980800,
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello! This is a mocked response.'
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 6,
        total_tokens: 18
      }
    };

    // Create mock HTTP pool and intercept requests
    const mockPool = mockAgent.get('http://localhost:1234');
    mockPool.intercept({
      path: '/v1/chat/completions',
      body: body => {
        console.log(`MockAgent received request body: ${body}`);
        const parsedBody = JSON.parse(body);
        console.log(`Parsed body:`, parsedBody);
        // Validate request body structure
        if (!parsedBody.model || !Array.isArray(parsedBody.messages)) {
          throw new Error('Invalid request body structure');
        }
        // Optionally validate specific content
        if (parsedBody.messages.length === 0 || parsedBody.messages[0].role !== 'user') {
          throw new Error('Invalid messages structure');
        }
        // Assert Model
        if (parsedBody.model !== 'gpt-4') {
          throw new Error(`Expected model gpt-4, but got ${parsedBody.model}`);
        }
        return true;
      },
      method: 'POST'
    }).reply(200, chatResponse);

    const embeddingResponse = {
      object: 'list',
      data: [{
        object: 'embedding',
        embedding: Array(1536).fill(0).map(() => Math.random() - 0.5),
        index: 0
      }],
      model: 'text-embedding-ada-002',
      usage: {
        prompt_tokens: 5,
        total_tokens: 5
      }
    };

    mockPool.intercept({
      path: '/v1/embeddings', method: 'POST'
    }).reply(200, embeddingResponse);

  });

  after(async () => {
    await mockAgent.close();
  });

  test('should accept MockAgent and use it for HTTP requests', async () => {
    const client = new AIModel(testProviders.openai, mockAgent);
    const response = await client.chat([{role: 'user', content: 'Hello!'}]);
    assert.strictEqual(response.message.content, 'Hello! This is a mocked response.');
    assert.strictEqual(response.usage?.totalTokens, 18);
  });

  test('should handle embedding requests with MockAgent', async () => {
    const client = new AIModel({
      ...testProviders.openai,
      model: 'text-embedding-ada-002',
      modelType: AIModelType.Embedding
    }, mockAgent);
    const embeddings = await client.embed('Hello world');
    assert.ok(Array.isArray(embeddings));
    assert.strictEqual(embeddings.length, 1536);
    assert.ok(typeof embeddings[0] === 'number');
  });

});
