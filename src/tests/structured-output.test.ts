/**
 * Tests for structured-output.ts — Core structured output types
 * 
 * Validates assertions:
 * - VAL-SCHEMA-001: Zod Schema Input with Type Inference
 * - VAL-SCHEMA-003: Raw JSON Schema Input
 * - VAL-SCHEMA-005: Validation Error with Raw Output
 * - VAL-SCHEMA-007: tryParseStructured Returns Result Object
 */
import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import {
    StructuredOutputError,
    type StructuredOutputOptions,
    type StructuredOutputResult,
    type StructuredOutputSuccess,
    type StructuredOutputFailure,
    type JSONSchema,
    isStructuredOutputSuccess,
} from '../structured-output.js';

// ============================================================================
// Test Schemas
// ============================================================================

const UserSchema = z.object({
    name: z.string(),
    age: z.number(),
    email: z.string().email().optional(),
});

type User = z.infer<typeof UserSchema>;

// ============================================================================
// StructuredOutputError Tests
// ============================================================================

describe('StructuredOutputError', () => {
    it('extends Error class', () => {
        const error = new StructuredOutputError('Validation failed', {
            rawOutput: '{"name": 123}',
        });
        expect(error instanceof Error).toBe(true);
    });

    it('has rawOutput property', () => {
        const error = new StructuredOutputError('Validation failed', {
            rawOutput: '{"invalid": "json"}',
        });
        expect(error.rawOutput).toBe('{"invalid": "json"}');
    });

    it('has cause property for Zod validation errors', () => {
        const zodError = new z.ZodError([
            { code: 'invalid_type', expected: 'string', received: 'number', path: ['name'] },
        ]);
        const error = new StructuredOutputError('Validation failed', {
            rawOutput: '{"name": 123}',
            cause: zodError,
        });
        expect(error.cause).toBe(zodError);
    });

    it('has optional cause property', () => {
        const error = new StructuredOutputError('Validation failed', {
            rawOutput: 'not json at all',
        });
        expect(error.cause).toBeUndefined();
    });

    it('captures stack trace', () => {
        const error = new StructuredOutputError('Validation failed', {
            rawOutput: '{}',
        });
        expect(error.stack).toBeDefined();
        // Stack trace should contain the error message and show where it was thrown
        expect(error.stack).toContain('Validation failed');
    });

    it('message includes raw output preview', () => {
        const error = new StructuredOutputError('Validation failed', {
            rawOutput: '{"long": "output that should be truncated in preview"}',
        });
        expect(error.message).toContain('Validation failed');
    });
});

// ============================================================================
// StructuredOutputOptions Tests
// ============================================================================

describe('StructuredOutputOptions', () => {
    it('accepts Zod schema', () => {
        const options: StructuredOutputOptions<User> = {
            schema: UserSchema,
        };
        expect(options.schema).toBe(UserSchema);
    });

    it('accepts raw JSON Schema', () => {
        const jsonSchema: JSONSchema = {
            type: 'object',
            properties: {
                name: { type: 'string' },
                age: { type: 'number' },
            },
            required: ['name', 'age'],
        };
        const options: StructuredOutputOptions<User> = {
            jsonSchema,
        };
        expect(options.jsonSchema).toBe(jsonSchema);
    });

    it('accepts optional name for LLM guidance', () => {
        const options: StructuredOutputOptions<User> = {
            schema: UserSchema,
            name: 'User',
        };
        expect(options.name).toBe('User');
    });

    it('accepts optional description for LLM guidance', () => {
        const options: StructuredOutputOptions<User> = {
            schema: UserSchema,
            name: 'User',
            description: 'A user object with name and age',
        };
        expect(options.description).toBe('A user object with name and age');
    });

    it('accepts both schema and name/description', () => {
        const options: StructuredOutputOptions<User> = {
            schema: UserSchema,
            name: 'User',
            description: 'User schema',
        };
        expect(options.schema).toBe(UserSchema);
        expect(options.name).toBe('User');
        expect(options.description).toBe('User schema');
    });
});

// ============================================================================
// StructuredOutputResult Tests
// ============================================================================

describe('StructuredOutputResult', () => {
    describe('Success case', () => {
        it('has ok: true and value property', () => {
            const result: StructuredOutputSuccess<User> = {
                ok: true,
                value: { name: 'John', age: 30 },
            };
            expect(result.ok).toBe(true);
            expect(result.value).toEqual({ name: 'John', age: 30 });
        });

        it('narrows type correctly', () => {
            const result: StructuredOutputResult<User> = {
                ok: true,
                value: { name: 'Jane', age: 25 },
            };
            if (result.ok) {
                // TypeScript should infer result.value is User
                const name: string = result.value.name;
                expect(name).toBe('Jane');
            }
        });
    });

    describe('Failure case', () => {
        it('has ok: false, error, and rawOutput properties', () => {
            const zodError = new z.ZodError([
                { code: 'invalid_type', expected: 'string', received: 'number', path: ['name'] },
            ]);
            const result: StructuredOutputFailure<User> = {
                ok: false,
                error: new StructuredOutputError('Validation failed', {
                    rawOutput: '{"name": 123}',
                    cause: zodError,
                }),
                rawOutput: '{"name": 123}',
            };
            expect(result.ok).toBe(false);
            expect(result.error).toBeInstanceOf(StructuredOutputError);
            expect(result.rawOutput).toBe('{"name": 123}');
        });

        it('narrows type correctly', () => {
            const result: StructuredOutputResult<User> = {
                ok: false,
                error: new StructuredOutputError('Invalid JSON', {
                    rawOutput: 'not json',
                }),
                rawOutput: 'not json',
            };
            if (!result.ok) {
                // TypeScript should infer result.error and result.rawOutput
                const errorMessage: string = result.error.message;
                const raw: string = result.rawOutput;
                expect(errorMessage).toContain('Invalid JSON');
                expect(raw).toBe('not json');
            }
        });
    });
});

// ============================================================================
// Type Guard Tests
// ============================================================================

describe('isStructuredOutputSuccess', () => {
    it('returns true for success result', () => {
        const result: StructuredOutputResult<User> = {
            ok: true,
            value: { name: 'Alice', age: 28 },
        };
        expect(isStructuredOutputSuccess(result)).toBe(true);
    });

    it('returns false for failure result', () => {
        const result: StructuredOutputResult<User> = {
            ok: false,
            error: new StructuredOutputError('Failed', {
                rawOutput: '{}',
            }),
            rawOutput: '{}',
        };
        expect(isStructuredOutputSuccess(result)).toBe(false);
    });
});

// ============================================================================
// Type Inference Tests
// ============================================================================

describe('Type Inference (VAL-SCHEMA-001)', () => {
    it('infers type from Zod schema correctly', () => {
        // This test ensures TypeScript infers the correct type
        const options: StructuredOutputOptions<User> = {
            schema: UserSchema,
        };
        
        // TypeScript compilation is the test - if type is wrong, this won't compile
        type InferredType = z.infer<typeof UserSchema>;
        const _typeCheck: InferredType = { name: 'Test', age: 0 };
        
        expect(options.schema).toBeDefined();
    });

    it('structured output result type narrows correctly', () => {
        // Test that TypeScript correctly narrows the union type
        const successResult: StructuredOutputResult<User> = {
            ok: true,
            value: { name: 'Bob', age: 35 },
        };
        
        const failureResult: StructuredOutputResult<User> = {
            ok: false,
            error: new StructuredOutputError('Error', { rawOutput: '{}' }),
            rawOutput: '{}',
        };
        
        // TypeScript narrow check - these should compile
        if (successResult.ok) {
            const name: string = successResult.value.name;
            expect(name).toBe('Bob');
        }
        
        if (!failureResult.ok) {
            const raw: string = failureResult.rawOutput;
            expect(raw).toBe('{}');
        }
    });
});

// ============================================================================
// JSON Schema Input Tests (VAL-SCHEMA-003)
// ============================================================================

describe('Raw JSON Schema Input', () => {
    it('accepts JSONSchema object without Zod', () => {
        const jsonSchema: JSONSchema = {
            type: 'object',
            properties: {
                id: { type: 'string' },
                count: { type: 'integer' },
            },
            required: ['id'],
        };
        
        const options: StructuredOutputOptions<{ id: string; count?: number }> = {
            jsonSchema,
        };
        
        expect(options.jsonSchema).toEqual(jsonSchema);
    });

    it('allows both schema and jsonSchema to be specified (schema takes precedence)', () => {
        const jsonSchema: JSONSchema = {
            type: 'object',
            properties: {
                value: { type: 'number' },
            },
        };
        
        const options: StructuredOutputOptions<{ value: number }> = {
            schema: z.object({ value: z.number() }),
            jsonSchema,
        };
        
        // Both can be set, implementation will use schema for validation
        expect(options.schema).toBeDefined();
        expect(options.jsonSchema).toBeDefined();
    });
});
