/**
 * Universal LLM API Client
 *
 * A high-performance, state-of-the-art universal client for Large Language Models
 * that supports multiple API providers, including Ollama and OpenAI-compatible endpoints.
 *
 * Features:
 * - 🚀 Built with undici for maximum performance and modern Node.js features
 * - 🔄 Connection pooling and keep-alive for optimal resource usage
 * - 🔁 Automatic retry logic with exponential backoff
 * - 🌊 Streaming support for real-time responses
 * - 🔗 Embeddings support for vector operations
 * - 🛡️ Comprehensive error handling and timeout management
 * - 🔧 Server health checking and model capability detection
 * - 📦 Auto-download of models (Ollama)
 * - 🔑 API key authentication support (OpenAI-compatible)
 * - 🔄 Multi-round tool execution with recursion depth protection
 *
 * Supported API Types:
 * - Ollama (http://localhost:11434)
 * - OpenAI API (https://api.openai.com/v1)
 * - LM Studio (http://localhost:1234/v1)
 * - Google Gemini API (https://generativelanguage.googleapis.com/v1beta)
 * - Any OpenAI-compatible API
 *
 * @author Your Team
 * @version 1.1.0
 */

import {Agent, Dispatcher, request} from 'undici';
import {
  AIModelApiType,
  AIModelOptions,
  AIModelType,
  GoogleContent,
  GoogleResponse,
  LLMChatMessage,
  LLMChatResponse,
  LLMToolCall,
  LLMToolDefinition,
  OllamaResponse,
  OpenAIResponse,
  TokenUsageInfo,
  ToolExecutionResult,
  ToolHandler,
  ToolRegistry
} from './interfaces.js';
import {parseToolCallsFromContent} from './tool-call-stream-parser.js';

export class AIModel {
  options: AIModelOptions;
  private agent: Dispatcher;
  private toolRegistry: ToolRegistry = {};
  private debug: boolean = false;
  private ownsAgent: boolean = false; // Track if we created the agent

  /**
   * Internal debug logger - only logs when debug mode is enabled
   */
  private debugLog(message: string, data?: any): void {
    if (this.debug) {
      if (data !== undefined) {
        console.log(`🔍 [AIModel Debug] ${message}`, data);
      } else {
        console.log(`🔍 [AIModel Debug] ${message}`);
      }
    }
  }

  constructor(options: AIModelOptions, externalAgent?: Dispatcher) {
    this.options = options;
    this.debug = options.debug || false;

    // Auto-detect model type if not specified
    if (!this.options.modelType) {
      this.options.modelType = this.inferModelType(this.options.model);
    }

    // Use provided agent or create a new one
    if (externalAgent) {
      this.agent = externalAgent;
      this.ownsAgent = false; // We don't own this agent, so don't dispose it
      this.debugLog('Using external agent for HTTP requests');
    } else {
      // Create a dedicated agent for connection pooling and better performance
      const agentOptions = this.options.agentOptions || {};
      this.agent = new Agent({
        connections: agentOptions.connections || 100,
        pipelining: agentOptions.pipelining || 10,
        keepAliveTimeout: agentOptions.keepAliveTimeout || 30_000,
        keepAliveMaxTimeout: agentOptions.keepAliveMaxTimeout || 60_000,
        headersTimeout: agentOptions.headersTimeout || this.options.timeout || 10_000,
        bodyTimeout: agentOptions.bodyTimeout || this.options.timeout || 10_000,
        connectTimeout: agentOptions.connectTimeout || this.options.timeout || 10_000,
      });
      this.ownsAgent = true; // We created this agent, so we can dispose it
      this.debugLog('Created new undici agent for HTTP requests');
    }
  }

  /**
   * Infers the model type based on the model name
   */
  private inferModelType(modelName: string): AIModelType {
    const embeddingPatterns = [
      'embed', 'embedding', 'arctic', 'nomic', 'text-embedding',
      'sentence-transformer', 'bge-', 'gte-', 'e5-'
    ];
    const lowerName = modelName.toLowerCase();
    const isEmbedding = embeddingPatterns.some(pattern => lowerName.includes(pattern));
    return isEmbedding ? AIModelType.Embedding : AIModelType.Chat;
  }

  /**
   * Validates that the model type supports the requested operation
   */
  private validateModelType(operation: AIModelType): void {
    if (this.options.modelType && this.options.modelType !== operation) {
      throw new Error(
        `Operation '${operation}' not supported by model type '${this.options.modelType}'. ` +
        `Model '${this.options.model}' is configured as a ${this.options.modelType} model.`
      );
    }
  }

  /**
   * Register a tool/function that can be called by the model
   */
  registerTool(name: string, description: string, parameters: any, handler: ToolHandler): void {
    this.toolRegistry[name] = {
      definition: {
        name,
        description,
        parameters
      },
      handler
    };
  }

  /**
   * Register multiple tools at once
   */
  registerTools(tools: Array<{ name: string; description: string; parameters: any; handler: ToolHandler }>): void {
    tools.forEach(tool => {
      this.registerTool(tool.name, tool.description, tool.parameters, tool.handler);
    });
  }

  /**
   * Get all registered tool definitions
   */
  private getToolDefinitions(): LLMToolDefinition[] {
    return Object.values(this.toolRegistry).map(tool => ({
      type: 'function' as const,
      function: tool.definition
    }));
  }

  /**
   * Execute a tool call
   */
  private async executeTool(toolCall: LLMToolCall): Promise<ToolExecutionResult> {
    const tool = this.toolRegistry[toolCall.function.name];

    if (!tool) {
      return {
        tool_call_id: toolCall.id,
        output: null,
        error: `Tool '${toolCall.function.name}' not found in registry`
      };
    }

    try {
      const args = JSON.parse(toolCall.function.arguments);
      const result = await tool.handler(args);

      return {
        tool_call_id: toolCall.id,
        output: result
      };
    } catch (error) {
      return {
        tool_call_id: toolCall.id,
        output: null,
        error: (error as Error).message
      };
    }
  }

  /**
   * Parse tool calls from text content using the enhanced stream parser
   */
  private async parseToolCallsFromContent(content: string): Promise<LLMToolCall[]> {
    return await parseToolCallsFromContent(content);
  }

  /**
   * Convert tools to provider-specific format
   */
  private convertToolsForProvider(tools: LLMToolDefinition[]): any {
    if (this.options.apiType === 'ollama') {
      // Ollama uses standard OpenAI format
      return tools;
    } else if (this.options.apiType === 'google') {
      // Google uses functionDeclarations
      return tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters
      }));
    } else {
      // OpenAI format
      return tools;
    }
  }

  /**
   * Convert tool calls from provider-specific format
   * 🔧 DEBUG AREA: Tool call parsing and text fallback parsing
   * - Enable debug mode to see tool call detection details
   * - Check here if tools aren't being detected from LLM responses
   */
  private async convertToolCallsFromProvider(response: any): Promise<LLMToolCall[] | undefined> {
    if (this.options.apiType === 'ollama' || this.options.apiType === 'openai') {
      const rawToolCalls = response.message?.tool_calls || response.choices?.[0]?.message?.tool_calls;

      if (rawToolCalls && rawToolCalls.length > 0) {
        // Normalize structured tool calls
        const normalizedCalls = rawToolCalls.map((call: any) => ({
          id: call.id || `call_${Date.now()}_${Math.random()}`,
          type: 'function',
          function: {
            name: call.function.name,
            arguments: typeof call.function.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function.arguments)
          }
        }));

        return normalizedCalls;
      }

      // Fallback: Parse tool calls from text content using enhanced stream parser
      const content = response.message?.content || response.choices?.[0]?.message?.content || '';
      if (content.trim()) {
        const parsedToolCalls = await this.parseToolCallsFromContent(content);
        if (parsedToolCalls.length > 0) {
          this.debugLog(`Parsed ${parsedToolCalls.length} tool calls from content for ${this.options.apiType} provider`);
          return parsedToolCalls;
        }
      }

      return undefined;
    } else if (this.options.apiType === 'google') {
      const candidate = response.candidates?.[0];
      if (!candidate) return undefined;

      const toolCalls: LLMToolCall[] = [];
      candidate.content.parts.forEach((part: any, index: number) => {
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${Date.now()}_${index}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args)
            }
          });
        }
      });

      return toolCalls.length > 0 ? toolCalls : undefined;
    }
    return undefined;
  }

  /**
   * Convert tool calls to provider-specific format for sending in messages
   */
  private convertToolCallsForMessages(toolCalls: LLMToolCall[]): any[] {
    return toolCalls.map(call => {
      if (this.options.apiType === 'ollama') {
        return {
          id: call.id,
          type: call.type,
          function: {
            name: call.function.name,
            arguments: JSON.parse(call.function.arguments) // Ollama expects object
          }
        };
      } else {
        return call; // OpenAI and Google expect string arguments
      }
    });
  }

  /**
   * Converts our standard chat messages to Google's format
   */
  private convertToGoogleMessages(messages: LLMChatMessage[]): GoogleContent[] {
    // Check if this is a Gemma model (doesn't support system role)
    const isGemmaModel = this.options.model.toLowerCase().includes('gemma');

    if (isGemmaModel) {
      // For Gemma models, embed system messages into the first user message
      return this.convertToGoogleMessagesForGemma(messages);
    } else {
      // For Gemini models, filter out system messages (handled separately)
      return messages
        .filter(msg => msg.role !== 'system')
        .map(msg => ({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{text: msg.content}]
        }));
    }
  }

  /**
   * Converts messages for Gemma models by embedding system instructions in user prompts
   */
  private convertToGoogleMessagesForGemma(messages: LLMChatMessage[]): GoogleContent[] {
    const systemMessages = messages.filter(msg => msg.role === 'system');
    const nonSystemMessages = messages.filter(msg => msg.role !== 'system');

    if (systemMessages.length === 0) {
      // No system messages, proceed normally
      return nonSystemMessages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{text: msg.content}]
      }));
    }

    // Combine system instructions with the first user message
    const systemInstruction = systemMessages.map(msg => msg.content).join('\n\n');
    const result: GoogleContent[] = [];
    let systemInstructionAdded = false;

    for (const msg of nonSystemMessages) {
      if (msg.role === 'user' && !systemInstructionAdded) {
        // Add system instruction to the first user message
        result.push({
          role: 'user',
          parts: [{text: `${systemInstruction}\n\n${msg.content}`}]
        });
        systemInstructionAdded = true;
      } else {
        result.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{text: msg.content}]
        });
      }
    }

    return result;
  }

  /**
   * Extracts system messages and combines them into a single system instruction for Google
   * Only used for Gemini models (not Gemma)
   */
  private extractGoogleSystemInstruction(messages: LLMChatMessage[]): string | undefined {
    // Don't use systemInstruction for Gemma models
    const isGemmaModel = this.options.model.toLowerCase().includes('gemma');
    if (isGemmaModel) {
      return undefined;
    }

    const systemMessages = messages.filter(msg => msg.role === 'system');
    if (systemMessages.length === 0) {
      return undefined;
    }
    return systemMessages.map(msg => msg.content).join('\n\n');
  }

  /**
   * Converts Google's response back to our standard format
   */
  private convertFromGoogleResponse(response: GoogleResponse): LLMChatMessage {
    if (!response.candidates || response.candidates.length === 0) {
      throw new Error('No candidates returned from Google API');
    }

    const candidate = response.candidates[0];
    const content = candidate.content.parts.map(part => part.text).join('');

    return {
      role: 'assistant',
      content: content
    };
  }

  async makeRequest(
    endpoint: string,
    body?: any,
    method: 'GET' | 'POST' = 'GET'
  ): Promise<any> {
    let url: URL;

    // Handle Google API URL construction differently
    if (this.options.apiType === 'google') {
      // For Google, the endpoint is the full URL with API key as query parameter
      url = new URL(endpoint);
      if (this.options.apiKey) {
        url.searchParams.set('key', this.options.apiKey);
      }
    } else {
      url = new URL(endpoint, this.options.url);
    }

    let maxRetries = 3;
    if (this.options.retries === 0) {
      maxRetries = 1;
    } else {
      if (this.options.retries && this.options.retries > 0) {
        maxRetries = this.options.retries;
      }
    }

    const timeout = this.options.timeout || 30000;

    const requestOptions: any = {
      method,
      headersTimeout: timeout,
      bodyTimeout: timeout,
      connectTimeout: timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Universal-LLM-API/1.0.0',
      }
    };

    // Add API key for OpenAI-compatible APIs (not Google, which uses query param)
    if (this.options.apiKey && this.options.apiType !== 'google') {
      requestOptions.headers['Authorization'] = `Bearer ${this.options.apiKey}`;
    }

    if (body && method === 'POST') {
      requestOptions.body = JSON.stringify(body);
    }

    let lastError: Error;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {

        // Set up a timeout promise to handle request timeouts
        let timeoutId: NodeJS.Timeout | string | number | undefined;
        let resolveFunction: (v: any) => void;
        const resolver = () => {
          if (timeoutId) clearTimeout(timeoutId);
          resolveFunction(null);
        };
        const timeoutPromise = new Promise<any>((resolve, reject) => {
          resolveFunction = resolve;
          timeoutId = setTimeout(() => {
            reject(new Error(`Request timeout after ${timeout}ms`));
          }, timeout);
        });

        // Race the actual request against the timeout
        const requestPromise = request(url.toString(), {
          dispatcher: this.agent,
          ...requestOptions
        });

        // Wait for either the request to complete or the timeout to trigger
        const response = await Promise.race([requestPromise, timeoutPromise]);
        resolver();

        if (response.statusCode >= 400) {
          const errorText = await response.body.text();
          throw new Error(`HTTP ${response.statusCode}: ${errorText}`);
        }

        const responseData = await response.body.json();
        return responseData;
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000; // Exponential backoff
          // Don't log retry attempts for cleaner output
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // Don't log every failed request attempt - only the final failure
        }
      }
    }
    throw lastError!;
  }

  /*
  * Ensures the model is ready to use, downloading it if necessary.
  */
  async ensureReady(): Promise<void> {
    // Google API doesn't require model checking
    if (this.options.apiType === AIModelApiType.Google) {
      this.debugLog(`Google model ${this.options.model} is ready.`);
      return;
    }

    try {
      const models = await this.listModels();
      const modelExists = models.some((model: any) => {
        if (this.options.apiType === AIModelApiType.Ollama) {
          return model.name === this.options.model;
        } else {
          return model.id === this.options.model;
        }
      });

      if (!modelExists) {
        if (this.options.apiType === AIModelApiType.Ollama) {
          console.log(`Model ${this.options.model} not found. Attempting to pull...`);
          await this.pullOllamaModel();
        } else {
          throw new Error(`Model ${this.options.model} not available on OpenAI-compatible server`);
        }
      } else {
        console.log(`✅ 🤖 Model [${this.options.model}] is ready.`);
      }
    } catch (error) {
      console.error(`Failed to ensure model readiness:`, error);
      throw error;
    }
  }

  private async listModels(): Promise<any[]> {
    if (this.options.apiType === AIModelApiType.Ollama) {
      const response = await this.makeRequest('/api/tags');
      return response.models || [];
    } else {
      const response = await this.makeRequest('/v1/models');
      return response.data || [];
    }
  }

  private async pullOllamaModel(): Promise<void> {
    if (this.options.apiType !== 'ollama') {
      throw new Error('Model pulling is only supported for Ollama');
    }

    console.log(`Pulling model ${this.options.model}...`);

    try {
      await this.makeRequest('/api/pull', {
        name: this.options.model,
        stream: false
      }, 'POST');

      console.log(`Successfully pulled model ${this.options.model}`);
    } catch (error) {
      console.error(`Failed to pull model ${this.options.model}:`, error);
      throw error;
    }
  }

  /**
   * Enhanced chat method with tool calling support
   */
  async chat(
    messages: LLMChatMessage[],
    parameters?: Record<string, any>,
    options?: {
      reasoning?: boolean; // Enable reasoning mode
      tools?: LLMToolDefinition[];
      tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
      executeTools?: boolean; // Auto-execute tools and continue conversation
      maxToolExecutionRounds?: number; // Maximum rounds of tool execution (default: 3)
    }
  ): Promise<LLMChatResponse> {
    return this.chatInternal(messages, parameters, options, 0);
  }

  /**
   * Internal chat method that handles recursive tool execution with depth tracking
   */
  private async chatInternal(
    messages: LLMChatMessage[],
    parameters?: Record<string, any>,
    options?: {
      reasoning?: boolean;
      tools?: LLMToolDefinition[];
      tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
      executeTools?: boolean;
      maxToolExecutionRounds?: number;
    },
    currentDepth: number = 0
  ): Promise<LLMChatResponse> {
    // Validate that this model supports chat operations
    this.validateModelType(AIModelType.Chat);

    const mergedParams = {...this.options.defaultParameters, ...parameters};
    const tools = options?.tools || this.getToolDefinitions();
    const hasTools = tools.length > 0;
    const maxRounds = options?.maxToolExecutionRounds ?? 3; // Default to 3 rounds

    // Check if we've exceeded the maximum tool execution rounds
    if (options?.executeTools && currentDepth >= maxRounds) {
      console.warn(`Maximum tool execution rounds (${maxRounds}) reached. Stopping tool execution to prevent infinite loops.`);
      // Continue without executeTools to get a final response
      options = {...options, executeTools: false};
    }

    let requestBody: any;
    let endpoint: string;

    if (this.options.apiType === AIModelApiType.Ollama) {
      endpoint = '/api/chat';
      requestBody = {
        model: this.options.model,
        messages: messages,
        stream: false,
        think: options?.reasoning || false,
        options: mergedParams
      };
      if (hasTools) {
        requestBody.tools = this.convertToolsForProvider(tools);
        if (options?.tool_choice && options.tool_choice !== 'auto') {
          requestBody.tool_choice = options.tool_choice;
        }
      }
    } else if (this.options.apiType === AIModelApiType.Google) {
      endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.options.model}:generateContent`;

      const googleRequest: any = {
        contents: this.convertToGoogleMessages(messages),
        generationConfig: {
          responseMimeType: 'text/plain',
          ...mergedParams
        }
      };

      // Add system instruction if system messages are present
      const systemInstruction = this.extractGoogleSystemInstruction(messages);
      if (systemInstruction) {
        googleRequest.systemInstruction = {
          parts: [{text: systemInstruction}]
        };
      }

      if (hasTools) {
        googleRequest.tools = [{
          functionDeclarations: this.convertToolsForProvider(tools)
        }];
        if (options?.tool_choice === 'required') {
          googleRequest.toolConfig = {
            functionCallingConfig: {
              mode: 'ANY'
            }
          };
        } else if (options?.tool_choice === 'none') {
          googleRequest.toolConfig = {
            functionCallingConfig: {
              mode: 'NONE'
            }
          };
        }
      }

      requestBody = googleRequest;
    } else {
      endpoint = '/v1/chat/completions';
      requestBody = {
        model: this.options.model,
        messages: messages,
        stream: false,
        ...mergedParams
      };

      if (hasTools) {
        requestBody.tools = tools;
        if (options?.tool_choice) {
          requestBody.tool_choice = options.tool_choice;
        }
      }
    }

    try {
      const response = await this.makeRequest(endpoint, requestBody, 'POST');

      // Remove the console.log that prints the full response

      let assistantMessage: LLMChatMessage;
      let usage: TokenUsageInfo | undefined;

      // Extract response, tool calls, and token usage
      if (this.options.apiType === AIModelApiType.Ollama) {
        const ollamaResponse = response as OllamaResponse;
        const toolCalls = await this.convertToolCallsFromProvider(response);
        assistantMessage = {
          role: ollamaResponse.message.role as 'assistant',
          content: ollamaResponse.message.content,
          tool_calls: toolCalls
        };
        // Ollama doesn't provide detailed token usage, so we estimate
        const inputTokens = Math.ceil(JSON.stringify(messages).length / 4);
        const outputTokens = Math.ceil(ollamaResponse.message.content.length / 4);
        usage = {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens
        };
      } else if (this.options.apiType === AIModelApiType.Google) {
        const toolCalls = await this.convertToolCallsFromProvider(response);
        const googleResponse = response as GoogleResponse;
        const textContent = this.convertFromGoogleResponse(googleResponse).content;

        assistantMessage = {
          role: 'assistant',
          content: textContent || '',
          tool_calls: toolCalls
        };

        // Extract real token usage from Google response
        if (googleResponse.usageMetadata) {
          usage = {
            inputTokens: googleResponse.usageMetadata.promptTokenCount,
            outputTokens: googleResponse.usageMetadata.candidatesTokenCount,
            totalTokens: googleResponse.usageMetadata.totalTokenCount
          };
        }
      } else {
        const openaiResponse = response as OpenAIResponse;
        if (openaiResponse.choices && openaiResponse.choices.length > 0) {
          const choice = openaiResponse.choices[0];
          const toolCalls = await this.convertToolCallsFromProvider(response);
          assistantMessage = {
            role: choice.message.role as 'assistant',
            content: choice.message.content || '',
            tool_calls: toolCalls
          };

          // Extract real token usage from OpenAI response
          if ((openaiResponse as any).usage) {
            const openaiUsage = (openaiResponse as any).usage;
            usage = {
              inputTokens: openaiUsage.prompt_tokens || 0,
              outputTokens: openaiUsage.completion_tokens || 0,
              totalTokens: openaiUsage.total_tokens || 0
            };
          }
        } else {
          throw new Error('No choices returned from OpenAI-compatible API');
        }
      }

      // Auto-execute tools if requested and tool calls are present
      // 🔧 DEBUG AREA: Tool execution and multi-round conversations
      // Enable debug mode to see tool execution details and round progression
      if (options?.executeTools && assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        this.debugLog(`Executing ${assistantMessage.tool_calls.length} tool(s) - Round ${currentDepth + 1}/${maxRounds}`);

        // Convert assistant message tool calls for provider compatibility
        const assistantMessageForProvider = {
          ...assistantMessage,
          tool_calls: this.convertToolCallsForMessages(assistantMessage.tool_calls)
        };

        const updatedMessages = [...messages, assistantMessageForProvider];

        // Execute all tool calls
        for (const toolCall of assistantMessage.tool_calls) {
          const result = await this.executeTool(toolCall);

          // Add tool result to conversation
          const toolMessage: LLMChatMessage = {
            role: 'tool',
            content: result.error || JSON.stringify(result.output),
            tool_call_id: result.tool_call_id
          };
          updatedMessages.push(toolMessage);
        }

        // Continue the conversation with tool results (allow further tool execution)
        return this.chatInternal(updatedMessages, parameters, options, currentDepth + 1);
      }

      return {message: assistantMessage, usage};
    } catch (error) {
      console.error(`Chat request failed:`, error);
      throw error;
    }
  }

  /**
   * Convenience method for chat with automatic tool execution
   */
  async chatWithTools(
    messages: LLMChatMessage[],
    options?: {
      parameters?: Record<string, any>;
      maxToolExecutionRounds?: number;
      tools?: LLMToolDefinition[];
      tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
    }
  ): Promise<LLMChatResponse> {
    return this.chat(messages, options?.parameters, {
      reasoning: true, // Enable reasoning by default
      executeTools: true,
      maxToolExecutionRounds: options?.maxToolExecutionRounds ?? 5, // Increased to 5 for complex tool operations
      tools: options?.tools,
      tool_choice: options?.tool_choice
    });
  }

  /**
   * Embeds a single text string using the model.
   */
  async embed(text: string): Promise<number[]> {
    const result = await this.embedArray([text]);
    return result[0];
  }

  /**
   * Embeds the provided text using the model.
   */
  async embedArray(text: string[]): Promise<number[][]> {
    // Validate that this model supports embedding operations
    this.validateModelType(AIModelType.Embedding);

    let requestBody: any;
    let endpoint: string;

    switch (this.options.apiType) {
      case AIModelApiType.Ollama: {
        endpoint = '/api/embed';
        requestBody = {
          model: this.options.model,
          input: text
        };
        break;
      }
      case AIModelApiType.OpenAI: {
        endpoint = '/v1/embeddings';
        requestBody = {
          model: this.options.model,
          input: text,
          encoding_format: 'float'
        };
        break;
      }
      case AIModelApiType.Google: {
        if (text.length === 1) {
          // Use single embedContent endpoint for single text
          endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.options.model}:embedContent`;
          requestBody = {
            model: `models/${this.options.model}`,
            content: {
              parts: [{text: text[0]}]
            }
          };
        } else {
          // Use batch endpoint for multiple texts
          endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.options.model}:batchEmbedContents`;
          const requests = text.map(t => ({
            model: `models/${this.options.model}`,
            content: {
              parts: [{text: t}]
            }
          }));
          requestBody = {
            requests: requests
          };
        }
        break;
      }
      default: {
        throw new Error(`[embedArray] Unsupported API type: ${this.options.apiType}`);
      }
    }

    let embeddings: number[][] | undefined;
    try {
      const response = await this.makeRequest(endpoint, requestBody, 'POST');
      switch (this.options.apiType) {
        case AIModelApiType.Ollama: {
          if (response && response.embeddings) {
            embeddings = response.embeddings;
          }
          break;
        }
        case AIModelApiType.OpenAI: {
          if (response.data && response.data.length > 0) {
            embeddings = response.data.map((item: any) => item.embedding || []);
          }
          break;
        }
        case AIModelApiType.Google: {
          if (response && response.embedding) {
            // Single embedContent response
            embeddings = [response.embedding.values || []];
          } else if (response && response.embeddings && Array.isArray(response.embeddings)) {
            // Batch embedContent response
            embeddings = response.embeddings.map((item: any) => item.values || []);
          }
          break;
        }
      }
    } catch (error) {
      console.error(`Embed request failed:`, error);
      throw error;
    }
    if (!embeddings || !Array.isArray(embeddings) || embeddings.length === 0) {
      throw new Error('No embeddings returned from the model');
    }
    return embeddings;
  }

  /**
   * Streams chat responses for real-time interaction.
   * 🔧 DEBUG AREA: Streaming response parsing and token processing
   * - Enable debug mode to see detailed streaming logs
   * - Check here if streaming responses aren't being processed correctly
   */
  async* chatStream(messages: LLMChatMessage[], parameters?: Record<string, any>): AsyncGenerator<string, void, unknown> {
    // Validate that this model supports chat operations
    this.validateModelType(AIModelType.Chat);

    const mergedParams = {...this.options.defaultParameters, ...parameters};

    let requestBody: any;
    let endpoint: string;

    if (this.options.apiType === 'ollama') {
      endpoint = '/api/chat';
      requestBody = {
        model: this.options.model,
        messages: messages,
        stream: true,
        options: mergedParams
      };
    } else if (this.options.apiType === 'google') {
      endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.options.model}:streamGenerateContent`;
      requestBody = {
        contents: this.convertToGoogleMessages(messages),
        generationConfig: {
          responseMimeType: 'text/plain',
          ...mergedParams
        }
      };

      // Add system instruction if system messages are present
      const systemInstruction = this.extractGoogleSystemInstruction(messages);
      if (systemInstruction) {
        requestBody.systemInstruction = {
          parts: [{text: systemInstruction}]
        };
      }
    } else {
      endpoint = '/v1/chat/completions';
      requestBody = {
        model: this.options.model,
        messages: messages,
        stream: true,
        ...mergedParams
      };
    }

    let url: URL;
    if (this.options.apiType === 'google') {
      url = new URL(endpoint);
      if (this.options.apiKey) {
        url.searchParams.set('key', this.options.apiKey);
      }
    } else {
      url = new URL(endpoint, this.options.url);
    }

    try {
      const response = await request(url.toString(), {
        method: 'POST',
        dispatcher: this.agent,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'User-Agent': 'Universal-LLM-API/1.0.0',
        },
        body: JSON.stringify(requestBody)
      });

      if (response.statusCode >= 400) {
        const errorText = await response.body.text();
        throw new Error(`HTTP ${response.statusCode}: ${errorText}`);
      }

      const decoder = new TextDecoder();

      if (this.options.apiType === 'google') {
        // Google's streaming API returns JSON array format, not SSE
        let buffer = '';

        for await (const chunk of response.body) {
          const text = decoder.decode(chunk, {stream: true});
          buffer += text;

          // Try to extract complete JSON objects from the buffer
          let startIndex = 0;
          let braceCount = 0;
          let inString = false;
          let escapeNext = false;

          for (let i = 0; i < buffer.length; i++) {
            const char = buffer[i];

            if (escapeNext) {
              escapeNext = false;
              continue;
            }

            if (char === '\\') {
              escapeNext = true;
              continue;
            }

            if (char === '"') {
              inString = !inString;
              continue;
            }

            if (!inString) {
              if (char === '{') {
                if (braceCount === 0) {
                  startIndex = i;
                }
                braceCount++;
              } else if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                  // Found complete JSON object
                  const jsonStr = buffer.slice(startIndex, i + 1);
                  try {
                    const parsed = JSON.parse(jsonStr);
                    if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
                      yield parsed.candidates[0].content.parts[0].text;
                    }
                    if (parsed.candidates?.[0]?.finishReason) {
                      return;
                    }
                  } catch (parseError) {
                    // Ignore parse errors for incomplete JSON
                  }

                  // Remove processed part from buffer
                  buffer = buffer.slice(i + 1);
                  i = -1; // Reset loop
                }
              }
            }
          }
        }
      } else {
        // Standard SSE parsing for Ollama and OpenAI
        this.debugLog(`Processing SSE stream for ${this.options.apiType}...`);
        for await (const chunk of response.body) {
          this.debugLog(`Raw chunk received: ${chunk.length} bytes`);
          const text = decoder.decode(chunk, {stream: true});
          this.debugLog(`Decoded text: "${text}"`);
          const lines = text.split('\n').filter(line => line.trim());
          this.debugLog(`Found ${lines.length} lines to process`);

          for (const line of lines) {
            // Handle different streaming formats
            let data: string;

            if (line.startsWith('data: ')) {
              // OpenAI SSE format
              data = line.slice(6);
              this.debugLog(`Processing SSE data line: "${data}"`);
            } else if (line.trim().startsWith('{')) {
              // Ollama raw JSON format (no SSE wrapper)
              data = line.trim();
              this.debugLog(`Processing raw JSON line: "${data}"`);
            } else {
              this.debugLog(`Skipping non-JSON line: "${line}"`);
              continue;
            }

            if (data === '[DONE]') {
              this.debugLog(`Stream complete marker found`);
              return;
            }

            try {
              const parsed = JSON.parse(data);
              this.debugLog(`Parsed JSON:`, parsed);

              if (this.options.apiType === 'ollama') {
                if (parsed.message?.content) {
                  this.debugLog(`Yielding Ollama content: "${parsed.message.content}"`);
                  yield parsed.message.content;
                }
                if (parsed.done) {
                  this.debugLog(`Ollama done flag found`);
                  return;
                }
              } else {
                if (parsed.choices?.[0]?.delta?.content) {
                  this.debugLog(`Yielding OpenAI content: "${parsed.choices[0].delta.content}"`);
                  yield parsed.choices[0].delta.content;
                }
                if (parsed.choices?.[0]?.finish_reason) {
                  this.debugLog(`OpenAI finish reason found`);
                  return;
                }
              }
            } catch (parseError) {
              // Always log parse errors as they indicate potential issues
              console.warn('❌ Failed to parse streaming response:', parseError, 'Data:', data);
            }
          }
        }
        this.debugLog(`Stream processing complete`);
      }
    } catch (error) {
      console.error(`Chat stream request failed:`, error);
      throw error;
    }
  }

  /**
   * Clean up resources when done.
   */
  async dispose(): Promise<void> {
    try {
      // Only dispose the agent if we own it
      if (this.ownsAgent && this.agent) {
        // Check if it's an Agent (has destroy/close methods)
        const agent = this.agent as any;
        if (typeof agent.destroy === 'function') {
          await agent.destroy();
        } else if (typeof agent.close === 'function') {
          await agent.close();
        }
      }
    } catch (error) {
      // Silently ignore disposal errors as they're not critical
    }
  }

  /**
   * Get server information and health status.
   */
  async getServerInfo(): Promise<any> {
    try {
      if (this.options.apiType === 'ollama') {
        // Ollama doesn't have a dedicated health endpoint, but we can use /api/tags
        const models = await this.makeRequest('/api/tags');
        return {
          status: 'healthy',
          type: 'ollama',
          models: models.models?.length || 0,
          url: this.options.url
        };
      } else {
        // Try OpenAI-style models endpoint
        const models = await this.makeRequest('/v1/models');
        return {
          status: 'healthy',
          type: 'openai-compatible',
          models: models.data?.length || 0,
          url: this.options.url
        };
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        error: (error as Error).message,
        url: this.options.url
      };
    }
  }

  /**
   * Check if the configured model supports embeddings.
   */
  async supportsEmbeddings(): Promise<boolean> {
    try {
      await this.embed('test');
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get model information if available.
   */
  async getModelInfo(): Promise<any> {
    try {
      if (this.options.apiType === 'ollama') {
        const response = await this.makeRequest(`/api/show`, {name: this.options.model}, 'POST');
        return response;
      } else {
        const models = await this.listModels();
        return models.find((model: any) => model.id === this.options.model);
      }
    } catch (error) {
      console.warn('Could not retrieve model info:', error);
      return null;
    }
  }

  /**
   * Get the configured model type
   */
  getModelType(): 'chat' | 'embedding' {
    return this.options.modelType || 'chat';
  }

  /**
   * Check if this is a chat model
   */
  isChatModel(): boolean {
    return this.getModelType() === 'chat';
  }

  /**
   * Check if this is an embedding model
   */
  isEmbeddingModel(): boolean {
    return this.getModelType() === 'embedding';
  }

  /**
   * Get all available models from the host/provider
   * This makes an actual API call to discover what models are available
   */
  async getHostModels(): Promise<string[]> {
    try {
      const models = await this.listModels();

      if (this.options.apiType === 'ollama') {
        // Ollama returns models with .name property
        return models.map((model: any) => model.name || model);
      } else {
        // OpenAI-compatible APIs return models with .id property
        return models.map((model: any) => model.id || model.name || model);
      }
    } catch (error: any) {
      console.warn(`Failed to discover models for ${this.options.apiType} provider at ${this.options.url}:`, error.message);
      return [];
    }
  }

  static async getModels(apiType: Exclude<AIModelApiType, AIModelApiType.Google>, url: string, apiKey?: string): Promise<string[]> {
    // Create a temporary instance to fetch models
    const startTime = Date.now();
    const client = new AIModel({model: 'null', apiType, url, apiKey, timeout: 500, retries: 1});
    try {
      const models = await client.getHostModels();
      const duration = Date.now() - startTime;
      if (models.length > 0) {
        // Only log success in debug mode to reduce noise
        if (client.debug) {
          console.log(`✅ Found ${models.length} models on ${apiType} provider at ${url} (${duration}ms)`);
        }
      }
      return models;
    } catch (error) {
      const duration = Date.now() - startTime;
      // Only log failures if they take longer than expected (connection issues)
      if (duration > 1000) {
        console.log(`❌ Provider ${apiType} at ${url} unavailable (${duration}ms)`);
      }
      return [];
    } finally {
      await client.dispose();
    }
  }
}
