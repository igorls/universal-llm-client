import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { AIModel } from "../index.js";
import { createTestAgent, testProviders } from './common.js';
import { MockAgent } from 'undici';

describe('Tools Functionality', () => {

    const testTool = {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        parameters: {
            type: 'object' as const,
            properties: {
                location: {
                    type: 'string' as const,
                    description: 'The city and state/country'
                },
                unit: {
                    type: 'string' as const,
                    enum: ['celsius', 'fahrenheit'] as const,
                    description: 'Temperature unit'
                }
            },
            required: ['location'] as const
        }
    };

    const testToolHandler = async (args: any) => {
        return {
            location: args.location,
            temperature: 22,
            unit: args.unit || 'celsius',
            description: 'Sunny'
        };
    };

    test('should register tools successfully', async () => {
        const client = new AIModel(testProviders.openai);

        // Register tool with correct signature: name, description, parameters, handler
        client.registerTool(
            testTool.name,
            testTool.description,
            testTool.parameters,
            testToolHandler
        );

        // Should not throw when registering valid tools
        assert.doesNotThrow(() => {
            client.registerTool(
                'calculate',
                'Perform mathematical calculations',
                {
                    type: 'object',
                    properties: {
                        expression: { type: 'string', description: 'Math expression' }
                    },
                    required: ['expression']
                },
                async (args: any) => {
                    return { result: eval(args.expression) };
                }
            );
        });

        await client.dispose();
    });

    test('should execute tools with OpenAI', async () => {

        const mockAgent = createTestAgent();
        const client = new AIModel(testProviders.openai, mockAgent);

        // Register tool
        client.registerTool(
            testTool.name,
            testTool.description,
            testTool.parameters,
            testToolHandler
        );

        // Mock OpenAI response with tool calls
        const mockPool = mockAgent.get(testProviders.openai.url);
        mockPool.intercept({
            path: '/v1/chat/completions',
            method: 'POST'
        }).reply(200, {
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: Date.now(),
            model: 'gpt-4',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_test123',
                        type: 'function',
                        function: {
                            name: 'get_weather',
                            arguments: JSON.stringify({ location: 'San Francisco, CA', unit: 'celsius' })
                        }
                    }]
                },
                finish_reason: 'tool_calls'
            }]
        });

        // Mock tool result response
        mockPool.intercept({
            path: '/v1/chat/completions',
            method: 'POST'
        }).reply(200, {
            id: 'chatcmpl-test2',
            object: 'chat.completion',
            created: Date.now(),
            model: 'gpt-4',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: 'The weather in San Francisco, CA is 22°C and sunny.'
                },
                finish_reason: 'stop'
            }]
        });

        const response = await client.chat([
            { role: 'user', content: 'What is the weather in San Francisco?' }
        ]);

        assert.ok(response);
        assert.strictEqual(response.message.role, 'assistant');
        assert.ok(response.message.content);
        assert.ok(response.message.content.includes('San Francisco'));

        await client.dispose();
    });

    test('should handle tool execution errors gracefully', async () => {
        const mockAgent = createTestAgent();
        const client = new AIModel(testProviders.openai, mockAgent);

        // Register tool that throws an error
        client.registerTool(
            'error_tool',
            'A tool that always throws an error',
            {
                type: 'object',
                properties: {
                    input: { type: 'string', description: 'Input parameter' }
                },
                required: ['input']
            },
            async (args: any) => {
                throw new Error('Simulated tool error');
            }
        );

        // Mock OpenAI response with tool calls
        const mockPool = mockAgent.get(testProviders.openai.url);
        mockPool.intercept({
            path: '/v1/chat/completions',
            method: 'POST'
        }).reply(200, {
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: Date.now(),
            model: 'gpt-4',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_error123',
                        type: 'function',
                        function: {
                            name: 'error_tool',
                            arguments: JSON.stringify({ input: 'test' })
                        }
                    }]
                },
                finish_reason: 'tool_calls'
            }]
        });

        // Mock error response
        mockPool.intercept({
            path: '/v1/chat/completions',
            method: 'POST'
        }).reply(200, {
            id: 'chatcmpl-test2',
            object: 'chat.completion',
            created: Date.now(),
            model: 'gpt-4',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: 'I encountered an error while using the tool.'
                },
                finish_reason: 'stop'
            }]
        });

        const response = await client.chat([
            { role: 'user', content: 'Use the error tool' }
        ]);

        assert.ok(response);
        assert.strictEqual(response.message.role, 'assistant');

        await client.dispose();
    });

    test('should execute tools with Ollama', async () => {
        const mockAgent = createTestAgent();
        const client = new AIModel(testProviders.ollama, mockAgent);

        // Register tool
        client.registerTool(
            testTool.name,
            testTool.description,
            testTool.parameters,
            testToolHandler
        );

        // Mock Ollama response with tool calls
        const mockPool = mockAgent.get(testProviders.ollama.url);
        mockPool.intercept({
            path: '/api/chat',
            method: 'POST'
        }).reply(200, {
            model: 'llama3.1:8b',
            created_at: new Date().toISOString(),
            message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'call_test123',
                    type: 'function',
                    function: {
                        name: 'get_weather',
                        arguments: JSON.stringify({ location: 'London, UK', unit: 'celsius' })
                    }
                }]
            },
            done: true
        });

        // Mock tool result response
        mockPool.intercept({
            path: '/api/chat',
            method: 'POST'
        }).reply(200, {
            model: 'llama3.1:8b',
            created_at: new Date().toISOString(),
            message: {
                role: 'assistant',
                content: 'The weather in London, UK is 22°C and sunny.'
            },
            done: true
        });

        const response = await client.chat([
            { role: 'user', content: 'What is the weather in London?' }
        ]);

        assert.ok(response);
        assert.strictEqual(response.message.role, 'assistant');
        assert.ok(response.message.content);
        assert.ok(response.message.content.includes('London'));

        await client.dispose();
    });

    test('should handle multiple tool registrations', async () => {
        const client = new AIModel(testProviders.ollama);

        const tools = [
            {
                name: 'tool1',
                description: 'First tool',
                parameters: { type: 'object', properties: {} },
                handler: async () => 'result1'
            },
            {
                name: 'tool2',
                description: 'Second tool',
                parameters: { type: 'object', properties: {} },
                handler: async () => 'result2'
            }
        ];

        // Register multiple tools
        client.registerTools(tools);

        // Should not throw - tools are registered successfully
        assert.doesNotThrow(() => {
            client.registerTool(
                'tool3',
                'Third tool',
                { type: 'object', properties: {} },
                async () => 'result3'
            );
        });

        await client.dispose();
    });

    test('should handle unknown tool calls gracefully', async () => {
        const mockAgent = createTestAgent();
        const client = new AIModel(testProviders.openai, mockAgent);

        // Don't register any tools, but mock response with unknown tool call
        const mockPool = mockAgent.get(testProviders.openai.url);
        mockPool.intercept({
            path: '/v1/chat/completions',
            method: 'POST'
        }).reply(200, {
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: Date.now(),
            model: 'gpt-4',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_unknown123',
                        type: 'function',
                        function: {
                            name: 'unknown_tool',
                            arguments: JSON.stringify({ param: 'value' })
                        }
                    }]
                },
                finish_reason: 'tool_calls'
            }]
        });

        // Mock error response for unknown tool
        mockPool.intercept({
            path: '/v1/chat/completions',
            method: 'POST'
        }).reply(200, {
            id: 'chatcmpl-test2',
            object: 'chat.completion',
            created: Date.now(),
            model: 'gpt-4',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: 'I cannot execute the requested tool as it is not available.'
                },
                finish_reason: 'stop'
            }]
        });

        const response = await client.chat([
            { role: 'user', content: 'Use unknown tool' }
        ]);

        assert.ok(response);
        assert.strictEqual(response.message.role, 'assistant');

        await client.dispose();
    });

});
