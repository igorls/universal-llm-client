import {describe, test} from 'node:test';
import * as assert from 'node:assert';
import {AIModel, AIModelApiType} from "../index.js";
import {createTestAgent, testProviders} from './common.js';
import {MockAgent} from 'undici';

describe('Chat Functionality', () => {

  test('should complete chat with OpenAI provider', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');
    
    // Mock chat completion response
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(200, {
      id: 'chatcmpl-test123',
      object: 'chat.completion',
      created: Date.now(),
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello! I am doing well, thank you for asking.'
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 15,
        total_tokens: 27
      }
    });

    const client = new AIModel(testProviders.openai, mockAgent);
    
    const response = await client.chat([
      { role: 'user', content: 'Hello, how are you?' }
    ]);

    assert.ok(response);
    assert.ok(response.message);
    assert.strictEqual(response.message.role, 'assistant');
    assert.ok(response.message.content);
    assert.ok(response.message.content.length > 0);
    assert.ok(response.usage);
    assert.ok(response.usage.totalTokens > 0);
    
    await client.dispose();
    await mockAgent.close();
  });

  test('should complete chat with Ollama provider', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:11434');
    
    // Mock Ollama chat response
    mockPool.intercept({
      path: '/api/chat',
      method: 'POST'
    }).reply(200, {
      model: 'llama3',
      created_at: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: 'Hello! I am doing well, thank you for asking.'
      },
      done: true,
      total_duration: 1000000,
      load_duration: 500000,
      prompt_eval_count: 12,
      prompt_eval_duration: 200000,
      eval_count: 15,
      eval_duration: 300000
    });

    const client = new AIModel(testProviders.ollama, mockAgent);
    
    const response = await client.chat([
      { role: 'user', content: 'Hello, how are you?' }
    ]);

    assert.ok(response);
    assert.ok(response.message);
    assert.strictEqual(response.message.role, 'assistant');
    assert.ok(response.message.content);
    assert.ok(response.message.content.length > 0);
    
    await client.dispose();
    await mockAgent.close();
  });

  test('should complete chat with Google provider', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('https://generativelanguage.googleapis.com');
    
    // Mock Google Generative AI response
    mockPool.intercept({
      path: '/v1beta/models/gemini-pro:generateContent',
      method: 'POST'
    }).reply(200, {
      candidates: [{
        content: {
          parts: [{
            text: 'Hello! I am doing well, thank you for asking.'
          }],
          role: 'model'
        },
        finishReason: 'STOP',
        index: 0
      }],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 15,
        totalTokenCount: 27
      }
    });

    const client = new AIModel(testProviders.google, mockAgent);
    
    const response = await client.chat([
      { role: 'user', content: 'Hello, how are you?' }
    ]);

    assert.ok(response);
    assert.ok(response.message);
    assert.strictEqual(response.message.role, 'assistant');
    assert.ok(response.message.content);
    assert.ok(response.message.content.length > 0);
    
    await client.dispose();
    await mockAgent.close();
  });

  test('should handle system messages properly', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');
    
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(200, {
      id: 'chatcmpl-test124',
      object: 'chat.completion', 
      created: Date.now(),
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'I am a helpful assistant as instructed.'
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30
      }
    });

    const client = new AIModel(testProviders.openai, mockAgent);
    
    const response = await client.chat([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' }
    ]);

    assert.ok(response);
    assert.ok(response.message);
    assert.strictEqual(response.message.role, 'assistant');
    
    await client.dispose();
    await mockAgent.close();
  });

  test('should handle empty or short responses', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');
    
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(200, {
      id: 'chatcmpl-test125',
      object: 'chat.completion',
      created: Date.now(),
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'OK'
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 1,
        total_tokens: 6
      }
    });

    const client = new AIModel(testProviders.openai, mockAgent);
    
    const response = await client.chat([
      { role: 'user', content: 'Say OK' }
    ]);

    assert.ok(response);
    assert.ok(response.message);
    assert.strictEqual(response.message.role, 'assistant');
    assert.strictEqual(response.message.content, 'OK');
    
    await client.dispose();
    await mockAgent.close();
  });

});
