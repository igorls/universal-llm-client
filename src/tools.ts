/**
 * Universal LLM Client v3 — Tool Utilities
 *
 * ToolBuilder: Type-safe tool definition builder with fluent API.
 * ToolExecutor: Execution wrappers with timeout and validation.
 */

import type { LLMFunction, LLMToolDefinition, ToolHandler } from './interfaces.js';

// ============================================================================
// ToolBuilder
// ============================================================================

/**
 * Fluent builder for LLM tool definitions.
 *
 * Usage:
 *   const tool = new ToolBuilder('get_weather')
 *       .description('Get current weather for a location')
 *       .addParameter('location', 'string', 'City name', true)
 *       .addParameter('units', 'string', 'Temperature units', false, { enum: ['celsius', 'fahrenheit'] })
 *       .build();
 */
export class ToolBuilder {
    private name: string;
    private desc: string = '';
    private properties: Record<string, unknown> = {};
    private required: string[] = [];

    constructor(name: string) {
        this.name = name;
    }

    description(desc: string): this {
        this.desc = desc;
        return this;
    }

    addParameter(
        name: string,
        type: string,
        description: string,
        isRequired: boolean = false,
        extra?: Record<string, unknown>,
    ): this {
        this.properties[name] = {
            type,
            description,
            ...extra,
        };
        if (isRequired) {
            this.required.push(name);
        }
        return this;
    }

    build(): LLMToolDefinition {
        return {
            type: 'function',
            function: {
                name: this.name,
                description: this.desc,
                parameters: {
                    type: 'object',
                    properties: this.properties,
                    required: this.required.length > 0 ? this.required : undefined,
                },
            },
        };
    }

    /** Build and return the function definition only  */
    buildFunction(): LLMFunction {
        return this.build().function;
    }
}

// ============================================================================
// ToolExecutor
// ============================================================================

/**
 * Utility wrappers for creating safe tool handlers.
 */
export class ToolExecutor {
    /**
     * Wrap a handler with a timeout.
     * Rejects if the handler doesn't complete within the specified ms.
     */
    static withTimeout(handler: ToolHandler, timeoutMs: number): ToolHandler {
        return async (args: unknown) => {
            const result = await Promise.race([
                Promise.resolve(handler(args)),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`Tool execution timeout after ${timeoutMs}ms`)), timeoutMs),
                ),
            ]);
            return result;
        };
    }

    /**
     * Wrap a handler to catch errors and return them as strings
     * instead of throwing.
     */
    static safe(handler: ToolHandler): ToolHandler {
        return async (args: unknown) => {
            try {
                return await handler(args);
            } catch (error) {
                return {
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        };
    }

    /**
     * Wrap a handler with argument validation.
     * Checks that required fields are present before execution.
     */
    static withValidation(
        handler: ToolHandler,
        requiredFields: string[],
    ): ToolHandler {
        return async (args: unknown) => {
            if (!args || typeof args !== 'object') {
                throw new Error('Tool arguments must be an object');
            }
            const obj = args as Record<string, unknown>;
            for (const field of requiredFields) {
                if (obj[field] === undefined || obj[field] === null) {
                    throw new Error(`Missing required argument: ${field}`);
                }
            }
            return handler(args);
        };
    }

    /**
     * Create a handler that measures execution time and
     * returns both the result and duration.
     */
    static timed(handler: ToolHandler): ToolHandler {
        return async (args: unknown) => {
            const start = Date.now();
            const result = await handler(args);
            return {
                result,
                duration: Date.now() - start,
            };
        };
    }

    /**
     * Compose multiple wrappers around a handler.
     * Applied from right to left (innermost to outermost).
     */
    static compose(
        handler: ToolHandler,
        ...wrappers: Array<(h: ToolHandler) => ToolHandler>
    ): ToolHandler {
        return wrappers.reduceRight((h, wrapper) => wrapper(h), handler);
    }
}

// ============================================================================
// Common Tool Definitions
// ============================================================================

/**
 * Create a get_current_time tool definition and handler.
 */
export function createTimeTool(): {
    name: string;
    description: string;
    parameters: LLMFunction['parameters'];
    handler: ToolHandler;
} {
    return {
        name: 'get_current_time',
        description: 'Get the current date and time',
        parameters: {
            type: 'object',
            properties: {
                timezone: {
                    type: 'string',
                    description: 'IANA timezone (e.g. "America/New_York"). Defaults to UTC.',
                },
            },
        },
        handler: (args: unknown) => {
            const { timezone } = (args ?? {}) as { timezone?: string };
            const now = new Date();
            try {
                return {
                    iso: now.toISOString(),
                    formatted: now.toLocaleString('en-US', {
                        timeZone: timezone || 'UTC',
                        dateStyle: 'full',
                        timeStyle: 'long',
                    }),
                    timezone: timezone || 'UTC',
                    timestamp: now.getTime(),
                };
            } catch {
                return {
                    iso: now.toISOString(),
                    formatted: now.toUTCString(),
                    timezone: 'UTC',
                    timestamp: now.getTime(),
                };
            }
        },
    };
}

/**
 * Create a random_number tool definition and handler.
 */
export function createRandomNumberTool(): {
    name: string;
    description: string;
    parameters: LLMFunction['parameters'];
    handler: ToolHandler;
} {
    return {
        name: 'random_number',
        description: 'Generate a random number within a range',
        parameters: {
            type: 'object',
            properties: {
                min: { type: 'number', description: 'Minimum value (default 0)' },
                max: { type: 'number', description: 'Maximum value (default 100)' },
            },
        },
        handler: (args: unknown) => {
            const { min = 0, max = 100 } = (args ?? {}) as { min?: number; max?: number };
            return {
                value: Math.floor(Math.random() * (max - min + 1)) + min,
                min,
                max,
            };
        },
    };
}
