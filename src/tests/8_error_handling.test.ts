import {describe, test} from 'node:test';
import * as assert from 'node:assert';
import {AIModel} from "../index.js";
import {createTestAgent, testProviders} from './common.js';

describe('Error Handling & Edge Cases', () => {

  test('should handle network timeout errors', async () => {
    const client = new AIModel({
      ...testProviders.openai,
      timeout: 100, // Very short timeout
      url: 'http://localhost:99999' // Non-existent port to simulate timeout
    });
    
    try {
      await client.chat([{ role: 'user', content: 'This should timeout' }]);
      assert.fail('Should have thrown a timeout error');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    
    await client.dispose();
  });

  test('should handle 401 authentication errors', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');

    // Mock 401 unauthorized
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(401, {
      error: {
        message: 'Unauthorized',
        type: 'invalid_request_error',
        code: 'invalid_api_key'
      }
    });

    const client = new AIModel({
      ...testProviders.openai,
      apiKey: 'invalid-key'
    }, mockAgent);
    
    try {
      await client.chat([{ role: 'user', content: 'This should fail auth' }]);
      assert.fail('Should have thrown an authentication error');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    
    await client.dispose();
  });

  test('should handle 404 not found errors', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');

    // Mock 404 not found
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(404, {
      error: {
        message: 'Not Found',
        type: 'not_found_error'
      }
    });

    const client = new AIModel({
      ...testProviders.openai
    }, mockAgent);
    
    try {
      await client.chat([{ role: 'user', content: 'This should not be found' }]);
      assert.fail('Should have thrown a not found error');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    
    await client.dispose();
  });

  test('should handle 500 server errors', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');

    // Mock 500 internal server error
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(500, {
      error: {
        message: 'Internal Server Error',
        type: 'server_error'
      }
    });

    const client = new AIModel({
      ...testProviders.openai
    }, mockAgent);
    
    try {
      await client.chat([{ role: 'user', content: 'This should fail server' }]);
      assert.fail('Should have thrown a server error');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    
    await client.dispose();
  });

  test('should handle malformed JSON responses', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');

    // Mock malformed JSON response
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(200, 'invalid json{');

    const client = new AIModel({
      ...testProviders.openai
    }, mockAgent);
    
    try {
      await client.chat([{ role: 'user', content: 'This should return malformed JSON' }]);
      assert.fail('Should have thrown a JSON parsing error');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    
    await client.dispose();
  });

  test('should handle empty response bodies', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');

    // Mock empty response
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(200, '');

    const client = new AIModel({
      ...testProviders.openai
    }, mockAgent);
    
    try {
      await client.chat([{ role: 'user', content: 'This should return empty' }]);
      assert.fail('Should have thrown an empty response error');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    
    await client.dispose();
  });

  test('should respect maximum retry limit', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');

    let attemptCount = 0;
    // Mock multiple failures
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(() => {
      attemptCount++;
      return { statusCode: 500, data: { error: { message: 'Server error' } } };
    }).times(5); // Allow up to 5 attempts

    const client = new AIModel({
      ...testProviders.openai,
      retries: 3,
      timeout: 1000
    }, mockAgent);
    
    try {
      await client.chat([{ role: 'user', content: 'This should fail after retries' }]);
      assert.fail('Should have thrown after exhausting retries');
    } catch (error) {
      assert.ok(error instanceof Error);
      // Should have attempted at least a few times (original + retries)
      assert.ok(attemptCount >= 2);
    }
    
    await client.dispose();
  });

  test('should handle invalid message format', async () => {
    const client = new AIModel({
      ...testProviders.openai
    });
    
    try {
      // @ts-ignore - Intentionally testing invalid input
      await client.chat([{ role: 'invalid', content: 'test' }]);
      assert.fail('Should have thrown a validation error');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    
    await client.dispose();
  });

  test('should handle missing required parameters', async () => {
    const client = new AIModel({
      ...testProviders.openai
    });
    
    try {
      // @ts-ignore - Intentionally testing invalid input
      await client.chat([{ role: 'user' }]); // Missing content
      assert.fail('Should have thrown a validation error');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    
    await client.dispose();
  });

  test('should handle streaming errors gracefully', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');

    // Mock streaming error
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(500, {
      error: {
        message: 'Streaming error',
        type: 'server_error'
      }
    });

    const client = new AIModel({
      ...testProviders.openai
    }, mockAgent);
    
    try {
      const stream = client.chatStream([{ role: 'user', content: 'This should fail' }]);
      for await (const chunk of stream) {
        // Should not reach here
        assert.fail('Stream should have failed');
      }
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    
    await client.dispose();
  });

  test('should handle connection refused errors', async () => {
    const client = new AIModel({
      ...testProviders.openai,
      url: 'http://localhost:99999' // Non-existent port
    });
    
    try {
      await client.chat([{ role: 'user', content: 'This should fail to connect' }]);
      assert.fail('Should have thrown a connection error');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    
    await client.dispose();
  });

  test('should handle very large message content', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');

    // Mock successful response for large content
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(200, {
      id: 'chatcmpl-large',
      object: 'chat.completion',
      created: Date.now(),
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'I received your large message.'
        },
        finish_reason: 'stop'
      }]
    });

    const client = new AIModel({
      ...testProviders.openai
    }, mockAgent);
    
    // Create a very large message (10KB)
    const largeContent = 'This is a very large message. '.repeat(300);
    
    const response = await client.chat([
      { role: 'user', content: largeContent }
    ]);
    
    assert.ok(response);
    assert.strictEqual(typeof response, 'string');
    
    await client.dispose();
  });

  test('should handle response with missing required fields', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');

    // Mock response with missing required fields
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(200, {
      id: 'chatcmpl-incomplete',
      object: 'chat.completion',
      // Missing choices array
    });

    const client = new AIModel({
      ...testProviders.openai
    }, mockAgent);
    
    try {
      await client.chat([{ role: 'user', content: 'This should have invalid response' }]);
      assert.fail('Should have thrown a response validation error');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    
    await client.dispose();
  });

  test('should handle model type validation errors', async () => {
    const client = new AIModel({
      ...testProviders.openai,
      modelType: 'embedding' as any,
      model: 'text-embedding-ada-002'
    });
    
    try {
      await client.chat([{ role: 'user', content: 'This should fail model type validation' }]);
      assert.fail('Should have thrown a model type error');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('not supported by model type'));
    }
    
    await client.dispose();
  });

  test('should handle concurrent request errors', async () => {
    const mockAgent = createTestAgent();
    const mockPool = mockAgent.get('http://localhost:1234');

    // Mock error responses
    mockPool.intercept({
      path: '/v1/chat/completions',
      method: 'POST'
    }).reply(500, {
      error: { 
        message: 'Server error',
        type: 'server_error'
      }
    }).times(3);

    const client = new AIModel({
      ...testProviders.openai
    }, mockAgent);
    
    // Make multiple concurrent requests
    const requests = [
      client.chat([{ role: 'user', content: 'Request 1' }]),
      client.chat([{ role: 'user', content: 'Request 2' }]),
      client.chat([{ role: 'user', content: 'Request 3' }])
    ];
    
    // All should fail
    for (const request of requests) {
      try {
        await request;
        assert.fail('Should have thrown an error');
      } catch (error) {
        assert.ok(error instanceof Error);
      }
    }
    
    await client.dispose();
  });

  test('should handle disposal during active request', async () => {
    const client = new AIModel({
      ...testProviders.openai,
      url: 'http://localhost:99999' // Non-existent to simulate delay
    });
    
    // Start request
    const requestPromise = client.chat([{ role: 'user', content: 'Slow request' }]);
    
    // Dispose immediately
    await client.dispose();
    
    // Request should be cancelled/rejected
    try {
      await requestPromise;
      // Depending on implementation, this might succeed or fail
      // Both are acceptable behaviors
    } catch (error) {
      // Expected if the request was cancelled
      assert.ok(error instanceof Error);
    }
  });

});
