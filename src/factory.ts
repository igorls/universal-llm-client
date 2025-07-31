import {AIModelApiType, AIModelOptions, AIModelType} from "./interfaces.js";
import {AIModel} from "./universal-llm-client.js";
import {ToolBuilder} from "./tools.js";

/**
 * Utility functions for creating pre-configured model instances
 */
export class AIModelFactory {
    /**
     * Create an Ollama chat model instance
     */
    static createOllamaChatModel(model: string, url: string = 'http://localhost:11434', options?: Partial<AIModelOptions>): AIModel {
        return new AIModel({
            model,
            url,
            apiType: AIModelApiType.Ollama,
            modelType: AIModelType.Chat,
            defaultParameters: {
                max_tokens: 1024,
                temperature: 0.7,
                ...options?.defaultParameters
            },
            ...options
        });
    }

    /**
     * Create an OpenAI-compatible chat model instance (LM Studio, OpenAI, etc.)
     */
    static createOpenAIChatModel(model: string, url: string = 'http://localhost:1234/v1', options?: Partial<AIModelOptions>): AIModel {
        return new AIModel({
            model,
            url,
            apiType: AIModelApiType.OpenAI,
            modelType: AIModelType.Chat,
            defaultParameters: {
                max_tokens: 1024,
                temperature: 0.7,
                ...options?.defaultParameters
            },
            ...options
        });
    }

    /**
     * Create an Ollama embedding model instance
     */
    static createOllamaEmbeddingModel(
        model: string = 'snowflake-arctic-embed2:latest',
        url: string = 'http://localhost:11434',
        options?: Partial<AIModelOptions>
    ): AIModel {
        return new AIModel({
            model,
            url,
            apiType: AIModelApiType.Ollama,
            modelType: AIModelType.Embedding,
            defaultParameters: {},
            ...options
        });
    }

    /**
     * Create an OpenAI-compatible embedding model instance
     */
    static createOpenAIEmbeddingModel(
        model: string = 'text-embedding-snowflake-arctic-embed-l-v2.0',
        url: string = 'http://localhost:1234/v1',
        options?: Partial<AIModelOptions>
    ): AIModel {
        return new AIModel({
            model,
            url,
            apiType: AIModelApiType.OpenAI,
            modelType: AIModelType.Embedding,
            defaultParameters: {},
            ...options
        });
    }

    /**
     * Create a Google Generative AI chat model instance
     */
    static createGoogleChatModel(
        model: string = 'gemma-3-4b-it',
        apiKey: string,
        options?: Partial<AIModelOptions>
    ): AIModel {
        return new AIModel({
            model,
            url: 'https://generativelanguage.googleapis.com', // Base URL not used for Google
            apiType: AIModelApiType.Google,
            modelType: AIModelType.Chat,
            apiKey,
            defaultParameters: {
                temperature: 0.7,
                maxOutputTokens: 1024
            },
            ...options
        });
    }

    /**
     * Create both chat and embedding models for a complete setup
     */
    static createCompleteSetup(options: {
        ollama?: { chatModel?: string, embeddingModel?: string, url?: string },
        openai?: { chatModel?: string, embeddingModel?: string, url?: string, apiKey?: string },
        google?: { chatModel?: string, apiKey?: string }
    } = {}) {
        const setup: any = {};

        // Always create Ollama setup unless explicitly disabled
        setup.ollama = {
            chat: this.createOllamaChatModel(
                options.ollama?.chatModel || 'gemma3:4b-it-qat',
                options.ollama?.url || 'http://localhost:11434'
            ),
            embedding: this.createOllamaEmbeddingModel(
                options.ollama?.embeddingModel || 'snowflake-arctic-embed2:latest',
                options.ollama?.url || 'http://localhost:11434'
            )
        };

        // Always create OpenAI setup unless explicitly disabled
        setup.openai = {
            chat: this.createOpenAIChatModel(
                options.openai?.chatModel || 'google/gemma-3-4b',
                options.openai?.url || 'http://localhost:1234/v1',
                { apiKey: options.openai?.apiKey }
            ),
            embedding: this.createOpenAIEmbeddingModel(
                options.openai?.embeddingModel || 'text-embedding-snowflake-arctic-embed-l-v2.0',
                options.openai?.url || 'http://localhost:1234/v1',
                { apiKey: options.openai?.apiKey }
            )
        };

        // Add Google setup if API key is provided
        if (options.google?.apiKey) {
            setup.google = {
                chat: this.createGoogleChatModel(
                    options.google?.chatModel || 'gemma-3-4b-it',
                    options.google.apiKey
                )
            };
        }

        return setup;
    }

    /**
     * Create a model with pre-registered common tools
     */
    static createModelWithTools(
        options: AIModelOptions,
        tools?: Array<ReturnType<typeof ToolBuilder.createTool>>
    ): AIModel {
        const model = new AIModel(options);

        // Register default tools
        const defaultTools = [
            ToolBuilder.commonTools.calculator,
            ToolBuilder.commonTools.getCurrentTime,
            ToolBuilder.commonTools.randomNumber,
            ToolBuilder.commonTools.textProcessor
        ];

        // Register all tools
        model.registerTools([...defaultTools, ...(tools || [])]);

        return model;
    }

    /**
     * Create chat models with tools
     */
    static createOllamaChatModelWithTools(
        model: string = 'llama3.2:3b',
        url: string = 'http://localhost:11434',
        tools?: Array<ReturnType<typeof ToolBuilder.createTool>>
    ): AIModel {
        return this.createModelWithTools({
            model,
            modelType: AIModelType.Chat,
            url,
            apiType: AIModelApiType.Ollama,
            defaultParameters: {
                max_tokens: 1024,
                temperature: 0.7
            }
        }, tools);
    }

    static createOpenAIChatModelWithTools(
        model: string = 'google/gemma-3-4b',
        url: string = 'http://localhost:1234/v1',
        apiKey?: string,
        tools?: Array<ReturnType<typeof ToolBuilder.createTool>>
    ): AIModel {
        return this.createModelWithTools({
            model,
            modelType: AIModelType.Chat,
            url,
            apiType: AIModelApiType.OpenAI,
            apiKey,
            defaultParameters: {
                max_tokens: 1024,
                temperature: 0.7
            }
        }, tools);
    }

    static createGoogleChatModelWithTools(
        model: string = 'gemini-2.5-flash-lite',
        apiKey: string,
        tools?: Array<ReturnType<typeof ToolBuilder.createTool>>
    ): AIModel {
        return this.createModelWithTools({
            model,
            modelType: AIModelType.Chat,
            url: 'https://generativelanguage.googleapis.com',
            apiType: AIModelApiType.Google,
            apiKey,
            defaultParameters: {
                temperature: 0.7,
                maxOutputTokens: 1024
            }
        }, tools);
    }
}
