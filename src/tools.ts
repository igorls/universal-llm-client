/**
 * Tool utilities and pre-built tools for the Universal LLM Client
 */

import type { LLMFunction, ToolHandler } from './interfaces.js';

export class ToolBuilder {
    /**
     * Create a tool definition with type-safe parameters
     */
    static createTool<T = any>(
        name: string,
        description: string,
        parameters: {
            properties: Record<string, any>;
            required?: string[];
        },
        handler: (args: T) => Promise<any> | any
    ) {
        return {
            name,
            description,
            parameters: {
                type: 'object' as const,
                ...parameters
            },
            handler
        };
    }

    /**
     * Common pre-built tools
     */
    static commonTools = {
        /**
         * Calculator tool
         */
        calculator: ToolBuilder.createTool<{ expression: string }>(
            'calculator',
            'Evaluate mathematical expressions safely',
            {
                properties: {
                    expression: {
                        type: 'string',
                        description: 'The mathematical expression to evaluate (e.g., "2 + 2", "10 * 5 + 3")'
                    }
                },
                required: ['expression']
            },
            (args) => {
                try {
                    // Safe evaluation for basic math operations
                    const sanitized = args.expression.replace(/[^0-9+\-*/().\s]/g, '');
                    if (sanitized !== args.expression) {
                        return { error: 'Invalid characters in expression. Only numbers and +, -, *, /, () allowed.' };
                    }

                    const result = Function(`"use strict"; return (${sanitized})`)();
                    if (typeof result !== 'number' || !isFinite(result)) {
                        return { error: 'Invalid mathematical expression' };
                    }

                    return {
                        expression: args.expression,
                        result: result,
                        formatted: `${args.expression} = ${result}`
                    };
                } catch (error) {
                    return {
                        error: 'Invalid mathematical expression',
                        message: (error as Error).message
                    };
                }
            }
        ),

        /**
         * Current time tool
         */
        getCurrentTime: ToolBuilder.createTool<{ timezone?: string; format?: string }>(
            'get_current_time',
            'Get the current date and time',
            {
                properties: {
                    timezone: {
                        type: 'string',
                        description: 'The timezone (e.g., "America/New_York", "Europe/London", "Asia/Tokyo")',
                        default: 'UTC'
                    },
                    format: {
                        type: 'string',
                        description: 'The format for the time (e.g., "full", "short", "iso")',
                        enum: ['full', 'short', 'iso', 'time-only', 'date-only'],
                        default: 'full'
                    }
                }
            },
            (args) => {
                const date = new Date();
                const timezone = args.timezone || 'UTC';
                const format = args.format || 'full';

                let formatted: string;

                try {
                    switch (format) {
                        case 'iso':
                            formatted = date.toISOString();
                            break;
                        case 'short':
                            formatted = date.toLocaleString('en-US', {
                                timeZone: timezone,
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                            });
                            break;
                        case 'time-only':
                            formatted = date.toLocaleTimeString('en-US', {
                                timeZone: timezone,
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit'
                            });
                            break;
                        case 'date-only':
                            formatted = date.toLocaleDateString('en-US', {
                                timeZone: timezone,
                                weekday: 'long',
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric'
                            });
                            break;
                        default: // 'full'
                            formatted = date.toLocaleString('en-US', {
                                timeZone: timezone,
                                weekday: 'long',
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit'
                            });
                    }

                    return {
                        timestamp: date.getTime(),
                        iso: date.toISOString(),
                        timezone: timezone,
                        formatted: formatted,
                        unix: Math.floor(date.getTime() / 1000)
                    };
                } catch (error) {
                    return {
                        error: 'Invalid timezone',
                        message: `Invalid timezone: ${timezone}`,
                        fallback: date.toISOString()
                    };
                }
            }
        ),

        /**
         * Random number generator tool
         */
        randomNumber: ToolBuilder.createTool<{ min?: number; max?: number; count?: number }>(
            'random_number',
            'Generate random numbers within a specified range',
            {
                properties: {
                    min: {
                        type: 'number',
                        description: 'Minimum value (inclusive)',
                        default: 0
                    },
                    max: {
                        type: 'number',
                        description: 'Maximum value (inclusive)',
                        default: 100
                    },
                    count: {
                        type: 'number',
                        description: 'Number of random numbers to generate',
                        default: 1,
                        minimum: 1,
                        maximum: 100
                    }
                }
            },
            (args) => {
                const min = args.min ?? 0;
                const max = args.max ?? 100;
                const count = Math.min(Math.max(args.count ?? 1, 1), 100);

                if (min >= max) {
                    return { error: 'Minimum value must be less than maximum value' };
                }

                const numbers: number[] = [];
                for (let i = 0; i < count; i++) {
                    numbers.push(Math.floor(Math.random() * (max - min + 1)) + min);
                }

                return {
                    numbers: numbers,
                    count: count,
                    range: { min, max },
                    single: count === 1 ? numbers[0] : undefined
                };
            }
        ),

        /**
         * Text processing tool
         */
        textProcessor: ToolBuilder.createTool<{
            text: string;
            operation: 'uppercase' | 'lowercase' | 'title' | 'reverse' | 'count' | 'words'
        }>(
            'text_processor',
            'Process text with various operations',
            {
                properties: {
                    text: {
                        type: 'string',
                        description: 'The text to process'
                    },
                    operation: {
                        type: 'string',
                        description: 'The operation to perform on the text',
                        enum: ['uppercase', 'lowercase', 'title', 'reverse', 'count', 'words']
                    }
                },
                required: ['text', 'operation']
            },
            (args) => {
                const { text, operation } = args;

                switch (operation) {
                    case 'uppercase':
                        return {
                            original: text,
                            result: text.toUpperCase(),
                            operation: 'uppercase'
                        };
                    case 'lowercase':
                        return {
                            original: text,
                            result: text.toLowerCase(),
                            operation: 'lowercase'
                        };
                    case 'title':
                        return {
                            original: text,
                            result: text.replace(/\w\S*/g, (txt) =>
                                txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
                            ),
                            operation: 'title'
                        };
                    case 'reverse':
                        return {
                            original: text,
                            result: text.split('').reverse().join(''),
                            operation: 'reverse'
                        };
                    case 'count':
                        return {
                            original: text,
                            characters: text.length,
                            charactersNoSpaces: text.replace(/\s/g, '').length,
                            words: text.trim().split(/\s+/).length,
                            lines: text.split('\n').length,
                            operation: 'count'
                        };
                    case 'words':
                        const words = text.trim().split(/\s+/);
                        return {
                            original: text,
                            words: words,
                            count: words.length,
                            operation: 'words'
                        };
                    default:
                        return { error: `Unknown operation: ${operation}` };
                }
            }
        ),

        /**
         * Memory storage tool - Add information to RAG system
         */
        storeMemory: ToolBuilder.createTool<{
            content: string;
            category: string;
            importance?: 'low' | 'medium' | 'high';
            context?: string;
        }>(
            'store_memory',
            'Store important information in the AI memory system for future retrieval',
            {
                properties: {
                    content: {
                        type: 'string',
                        description: 'The information to store in memory (facts, preferences, important details, etc.)'
                    },
                    category: {
                        type: 'string',
                        description: 'Category of the memory',
                        enum: ['personal_info', 'preferences', 'facts', 'events', 'relationships', 'goals', 'skills', 'interests', 'other']
                    },
                    importance: {
                        type: 'string',
                        description: 'Importance level of this memory',
                        enum: ['low', 'medium', 'high'],
                        default: 'medium'
                    },
                    context: {
                        type: 'string',
                        description: 'Additional context about when/why this information is important'
                    }
                },
                required: ['content', 'category']
            },
            async (args) => {
                try {
                    // Note: This is a placeholder - in a real implementation, you'd inject ChromaDBService
                    console.log('🧠 Storing memory:', args);

                    // Simulated storage logic
                    const memoryId = `memory_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    const confidence = args.importance === 'high' ? 0.9 : args.importance === 'medium' ? 0.7 : 0.5;

                    return {
                        success: true,
                        memoryId,
                        stored: {
                            content: args.content,
                            category: args.category,
                            importance: args.importance || 'medium',
                            context: args.context,
                            timestamp: new Date().toISOString(),
                            confidence
                        },
                        message: `Memory stored successfully in category: ${args.category}`
                    };
                } catch (error) {
                    return {
                        success: false,
                        error: 'Failed to store memory',
                        message: (error as Error).message
                    };
                }
            }
        ),

        /**
         * Memory retrieval tool - Search for relevant information
         */
        searchMemory: ToolBuilder.createTool<{
            query: string;
            category?: string;
            limit?: number;
        }>(
            'search_memory',
            'Search the AI memory system for relevant information based on a query',
            {
                properties: {
                    query: {
                        type: 'string',
                        description: 'What to search for in memory (topics, keywords, concepts)'
                    },
                    category: {
                        type: 'string',
                        description: 'Optional: Filter by specific memory category',
                        enum: ['personal_info', 'preferences', 'facts', 'events', 'relationships', 'goals', 'skills', 'interests', 'other']
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum number of memories to retrieve',
                        default: 5,
                        minimum: 1,
                        maximum: 20
                    }
                },
                required: ['query']
            },
            async (args) => {
                try {
                    // Note: This is a placeholder - in a real implementation, you'd inject ChromaDBService
                    console.log('🔍 Searching memory for:', args.query);

                    // Simulated search logic
                    const mockMemories = [
                        {
                            content: `Sample memory related to: ${args.query}`,
                            category: args.category || 'facts',
                            similarity: 0.85,
                            timestamp: new Date().toISOString(),
                            context: 'Retrieved from memory system'
                        }
                    ];

                    return {
                        success: true,
                        query: args.query,
                        memories: mockMemories,
                        count: mockMemories.length,
                        stats: {
                            totalSearched: 100,
                            avgSimilarity: 0.85,
                            categories: [args.category || 'facts']
                        }
                    };
                } catch (error) {
                    return {
                        success: false,
                        error: 'Failed to search memory',
                        message: (error as Error).message
                    };
                }
            }
        ),

        /**
         * Memory analysis tool - Analyze if current conversation contains valuable information
         */
        analyzeConversation: ToolBuilder.createTool<{
            conversationText: string;
            previousContext?: string;
        }>(
            'analyze_conversation',
            'Analyze conversation content to identify information worth storing in memory',
            {
                properties: {
                    conversationText: {
                        type: 'string',
                        description: 'The conversation text to analyze for valuable information'
                    },
                    previousContext: {
                        type: 'string',
                        description: 'Optional: Previous context to help determine what is new/valuable'
                    }
                },
                required: ['conversationText']
            },
            async (args) => {
                try {
                    console.log('🔬 Analyzing conversation for valuable information...');

                    const text = args.conversationText.toLowerCase();
                    const insights: any[] = [];

                    // Simple heuristics to identify valuable information
                    const patterns = [
                        { pattern: /my name is|i'm called|call me/i, category: 'personal_info', importance: 'high' },
                        { pattern: /i like|i love|i enjoy|i prefer/i, category: 'preferences', importance: 'medium' },
                        { pattern: /i work|my job|i'm a|i do/i, category: 'personal_info', importance: 'medium' },
                        { pattern: /i live|i'm from|i'm based/i, category: 'personal_info', importance: 'medium' },
                        { pattern: /i learned|i discovered|interesting fact/i, category: 'facts', importance: 'medium' },
                        { pattern: /i want to|my goal|i plan to/i, category: 'goals', importance: 'high' },
                        { pattern: /i'm good at|i can|my skill/i, category: 'skills', importance: 'medium' },
                        { pattern: /remember that|important|don't forget/i, category: 'other', importance: 'high' }
                    ];

                    for (const { pattern, category, importance } of patterns) {
                        if (pattern.test(text)) {
                            // Extract relevant sentences
                            const sentences = args.conversationText.split(/[.!?]+/).filter(s =>
                                s.trim().length > 10 && pattern.test(s)
                            );

                            for (const sentence of sentences) {
                                insights.push({
                                    content: sentence.trim(),
                                    category,
                                    importance,
                                    confidence: 0.8,
                                    reason: `Matched pattern: ${pattern.source}`
                                });
                            }
                        }
                    }

                    return {
                        success: true,
                        analysis: {
                            totalInsights: insights.length,
                            worthStoring: insights.length > 0,
                            insights: insights.slice(0, 5), // Limit to top 5
                            recommendation: insights.length > 0
                                ? `Found ${insights.length} pieces of valuable information worth storing`
                                : 'No particularly valuable information detected for storage'
                        }
                    };
                } catch (error) {
                    return {
                        success: false,
                        error: 'Failed to analyze conversation',
                        message: (error as Error).message
                    };
                }
            }
        )
    };
}

/**
 * Tool execution utilities
 */
export class ToolExecutor {
    /**
     * Create a safe tool executor with error handling
     */
    static createSafeExecutor(handler: ToolHandler): ToolHandler {
        return async (args: any) => {
            try {
                const result = await handler(args);
                return result;
            } catch (error) {
                return {
                    error: true,
                    message: (error as Error).message,
                    type: 'execution_error'
                };
            }
        };
    }

    /**
     * Create a tool with validation
     */
    static createValidatedTool<T = any>(
        tool: ReturnType<typeof ToolBuilder.createTool>,
        validator: (args: T) => boolean | string
    ) {
        const originalHandler = tool.handler;

        return {
            ...tool,
            handler: async (args: T) => {
                const validation = validator(args);
                if (validation !== true) {
                    return {
                        error: true,
                        message: typeof validation === 'string' ? validation : 'Validation failed',
                        type: 'validation_error'
                    };
                }

                return originalHandler(args);
            }
        };
    }

    /**
     * Create a tool with timeout
     */
    static createTimedTool(
        tool: ReturnType<typeof ToolBuilder.createTool>,
        timeoutMs: number = 5000
    ) {
        const originalHandler = tool.handler;

        return {
            ...tool,
            handler: async (args: any) => {
                return Promise.race([
                    originalHandler(args),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms`)), timeoutMs)
                    )
                ]).catch(error => ({
                    error: true,
                    message: (error as Error).message,
                    type: 'timeout_error'
                }));
            }
        };
    }
}
