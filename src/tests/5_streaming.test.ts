import {describe, test} from 'node:test';
import * as assert from 'node:assert';
import {AIModel, AIModelApiType} from "../index.js";
import {createTestAgent, testProviders} from './common.js';
import {MockAgent} from 'undici';

describe('Streaming Functionality', () => {

  test('should stream chat with OpenAI provider', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');
    
    // Mock streaming response
    const streamResponse = [
      'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ].join('');

    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(200, streamResponse, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked'
      }
    });

    const client = new AIModel(testProviders.openai, mockAgent);
    
    const tokens = [];
    const stream = client.chatStream([
      { role: 'user', content: 'Hello, stream me a response!' }
    ]);

    for await (const token of stream) {
      assert.strictEqual(typeof token, 'string');
      tokens.push(token);
    }

    assert.ok(tokens.length > 0);
    
    // Verify we received the expected tokens
    const fullContent = tokens.join('');
    assert.ok(fullContent.includes('Hello'));
    
    await client.dispose();
    await mockAgent.close();
  });

  test('should stream chat with Ollama provider', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:11434');
    
    // Mock Ollama streaming response
    const streamResponse = [
      '{"model":"llama3","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Hello"},"done":false}\n',
      '{"model":"llama3","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":" there"},"done":false}\n',
      '{"model":"llama3","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"!"},"done":false}\n',
      '{"model":"llama3","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":""},"done":true,"total_duration":1000000,"load_duration":500000,"prompt_eval_count":12,"prompt_eval_duration":200000,"eval_count":15,"eval_duration":300000}\n'
    ].join('');

    mockPool.intercept({
      path: '/api/chat',
      method: 'POST'
    }).reply(200, streamResponse, {
      headers: {
        'Content-Type': 'application/x-ndjson'
      }
    });

    const client = new AIModel(testProviders.ollama, mockAgent);
    
    const tokens = [];
    const stream = client.chatStream([
      { role: 'user', content: 'Hello, stream me a response!' }
    ]);

    for await (const token of stream) {
      assert.strictEqual(typeof token, 'string');
      tokens.push(token);
    }

    assert.ok(tokens.length > 0);
    
    // Verify we received the expected tokens
    const fullContent = tokens.join('');
    assert.ok(fullContent.includes('Hello'));
    
    await client.dispose();
    await mockAgent.close();
  });

  test('should handle streaming errors gracefully', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');
    
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(500, {
      error: {
        message: 'Internal server error',
        type: 'internal_server_error'
      }
    });

    const client = new AIModel(testProviders.openai, mockAgent);
    
    const stream = client.chatStream([
      { role: 'user', content: 'This should fail' }
    ]);

    // Should throw an error when iterating
    await assert.rejects(async () => {
      for await (const token of stream) {
        // This should not execute
      }
    });
    
    await client.dispose();
    await mockAgent.close();
  });

  test('should handle empty streaming responses', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');
    
    // Mock empty streaming response 
    const streamResponse = 'data: [DONE]\n\n';

    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(200, streamResponse, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });

    const client = new AIModel(testProviders.openai, mockAgent);
    
    const tokens = [];
    const stream = client.chatStream([
      { role: 'user', content: 'Empty response test' }
    ]);

    for await (const token of stream) {
      tokens.push(token);
    }

    // Should handle empty stream gracefully
    assert.strictEqual(tokens.length, 0);
    
    await client.dispose();
    await mockAgent.close();
  });

});
