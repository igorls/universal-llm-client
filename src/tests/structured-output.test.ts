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
    // Schema conversion functions
    zodToJsonSchema,
    normalizeJsonSchema,
    convertToProviderSchema,
    stripUnsupportedFeatures,
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

// ============================================================================
// Schema Conversion Tests (VAL-SCHEMA-002)
// ============================================================================

describe('Schema Conversion (VAL-SCHEMA-002)', () => {
    describe('zodToJsonSchema', () => {
        it('converts Zod string schema to JSON Schema', () => {
            const stringSchema = z.string();
            const jsonSchema = zodToJsonSchema(stringSchema);
            
            expect(jsonSchema.type).toBe('string');
        });

        it('converts Zod number schema to JSON Schema', () => {
            const numberSchema = z.number();
            const jsonSchema = zodToJsonSchema(numberSchema);
            
            expect(jsonSchema.type).toBe('number');
        });

        it('converts Zod boolean schema to JSON Schema', () => {
            const boolSchema = z.boolean();
            const jsonSchema = zodToJsonSchema(boolSchema);
            
            expect(jsonSchema.type).toBe('boolean');
        });

        it('converts Zod object schema with required properties', () => {
            const objectSchema = z.object({
                name: z.string(),
                age: z.number(),
            });
            const jsonSchema = zodToJsonSchema(objectSchema);
            
            expect(jsonSchema.type).toBe('object');
            expect(jsonSchema.properties).toBeDefined();
            expect(jsonSchema.properties?.['name']).toEqual({ type: 'string' });
            expect(jsonSchema.properties?.['age']).toEqual({ type: 'number' });
            expect(jsonSchema.required).toEqual(['name', 'age']);
        });

        it('converts Zod object schema with optional properties', () => {
            const objectSchema = z.object({
                name: z.string(),
                email: z.string().optional(),
            });
            const jsonSchema = zodToJsonSchema(objectSchema);
            
            expect(jsonSchema.type).toBe('object');
            expect(jsonSchema.required).toEqual(['name']);
            expect(jsonSchema.properties?.['name']).toEqual({ type: 'string' });
            expect(jsonSchema.properties?.['email']).toEqual({ type: 'string' });
        });

        it('converts nested Zod object schema', () => {
            const nestedAddressSchema = z.object({
                city: z.string(),
                country: z.string(),
            });
            const personSchema = z.object({
                name: z.string(),
                address: nestedAddressSchema,
            });
            const jsonSchema = zodToJsonSchema(personSchema);
            
            expect(jsonSchema.type).toBe('object');
            // zod-to-json-schema adds additionalProperties: false by default
            const addressProp = jsonSchema.properties?.['address'] as JSONSchema;
            expect(addressProp.type).toBe('object');
            expect(addressProp.properties?.['city']).toEqual({ type: 'string' });
            expect(addressProp.properties?.['country']).toEqual({ type: 'string' });
            expect(addressProp.required).toEqual(['city', 'country']);
        });
    });

    describe('normalizeJsonSchema', () => {
        it('passes through JSON Schema without modification when not needed', () => {
            const input: JSONSchema = {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    count: { type: 'number' },
                },
                required: ['name'],
            };
            
            const result = normalizeJsonSchema(input);
            
            expect(result.type).toBe('object');
            expect(result.properties).toEqual(input.properties);
            expect(result.required).toEqual(['name']);
        });

        it('preserves description in JSON Schema', () => {
            const input: JSONSchema = {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'User name' },
                },
                description: 'A user object',
            };
            
            const result = normalizeJsonSchema(input);
            
            expect(result.description).toBe('A user object');
            expect(result.properties?.['name']?.description).toBe('User name');
        });
    });
});

// ============================================================================
// Schema Name/Description Tests (VAL-SCHEMA-004)
// ============================================================================

describe('Schema Name and Description (VAL-SCHEMA-004)', () => {
    describe('convertToProviderSchema', () => {
        it('includes schema name in OpenAI-compatible format', () => {
            const schema = z.object({ name: z.string() });
            const options: StructuredOutputOptions<{ name: string }> = {
                schema,
                name: 'User',
                description: 'A user object',
            };
            
            const result = convertToProviderSchema('openai', options);
            
            expect(result.name).toBe('User');
            expect(result.description).toBe('A user object');
        });

        it('works without name/description (optional)', () => {
            const schema = z.object({ name: z.string() });
            const options: StructuredOutputOptions<{ name: string }> = {
                schema,
            };
            
            const result = convertToProviderSchema('openai', options);
            
            expect(result.schema).toBeDefined();
            expect(result.schema.type).toBe('object');
        });

        it('generates default name if not provided for providers that require it', () => {
            const schema = z.object({ value: z.number() });
            const options: StructuredOutputOptions<{ value: number }> = {
                schema,
            };
            
            const result = convertToProviderSchema('openai', options);
            
            // Should have a name, either provided or auto-generated
            expect(result.name).toBeDefined();
            expect(typeof result.name).toBe('string');
        });
    });
});

// ============================================================================
// Enum Schema Tests (VAL-SCHEMA-008)
// ============================================================================

describe('Schema with Enums (VAL-SCHEMA-008)', () => {
    it('converts Zod enum to JSON Schema with enum constraint', () => {
        const statusSchema = z.enum(['active', 'inactive', 'pending']);
        const jsonSchema = zodToJsonSchema(statusSchema);
        
        expect(jsonSchema.type).toBe('string');
        expect(jsonSchema.enum).toEqual(['active', 'inactive', 'pending']);
    });

    it('converts Zod native enum to JSON Schema', () => {
        enum Color {
            Red = 'red',
            Green = 'green',
            Blue = 'blue',
        }
        const colorSchema = z.nativeEnum(Color);
        const jsonSchema = zodToJsonSchema(colorSchema);
        
        expect(jsonSchema.type).toBe('string');
        expect(jsonSchema.enum).toContain('red');
        expect(jsonSchema.enum).toContain('green');
        expect(jsonSchema.enum).toContain('blue');
    });

    it('converts object with enum property', () => {
        const userSchema = z.object({
            name: z.string(),
            status: z.enum(['active', 'inactive']),
        });
        const jsonSchema = zodToJsonSchema(userSchema);
        
        expect(jsonSchema.type).toBe('object');
        expect(jsonSchema.properties?.['status']).toEqual({
            type: 'string',
            enum: ['active', 'inactive'],
        });
    });

    it('validates enum values correctly', () => {
        const schema = z.enum(['a', 'b', 'c']);
        const jsonSchema = zodToJsonSchema(schema);
        
        expect(jsonSchema.enum).toEqual(['a', 'b', 'c']);
        expect(jsonSchema.type).toBe('string');
    });
});

// ============================================================================
// Nested Object Schema Tests (VAL-SCHEMA-009)
// ============================================================================

describe('Nested Object Schema (VAL-SCHEMA-009)', () => {
    it('converts deeply nested object schema', () => {
        const addressSchema = z.object({
            street: z.string(),
            city: z.string(),
            country: z.string(),
        });
        
        const userSchema = z.object({
            name: z.string(),
            address: addressSchema,
        });
        
        const companySchema = z.object({
            name: z.string(),
            users: z.array(userSchema),
        });
        
        const jsonSchema = zodToJsonSchema(companySchema);
        
        expect(jsonSchema.type).toBe('object');
        // Check the structure exists
        const usersSchema = jsonSchema.properties?.['users'] as JSONSchema;
        expect(usersSchema.type).toBe('array');
        
        const itemsSchema = usersSchema.items as JSONSchema;
        expect(itemsSchema.type).toBe('object');
        expect(itemsSchema.properties?.['name']).toEqual({ type: 'string' });
        
        // Navigate deep into the schema
        const addressProp = itemsSchema.properties?.['address'] as JSONSchema;
        expect(addressProp.type).toBe('object');
        expect(addressProp.properties?.['street']).toEqual({ type: 'string' });
        expect(addressProp.properties?.['city']).toEqual({ type: 'string' });
        expect(addressProp.properties?.['country']).toEqual({ type: 'string' });
    });

    it('handles three levels of nesting', () => {
        const citySchema = z.object({
            name: z.string(),
            population: z.number(),
        });
        
        const addressSchema = z.object({
            street: z.string(),
            city: citySchema,
        });
        
        const personSchema = z.object({
            name: z.string(),
            address: addressSchema,
        });
        
        const jsonSchema = zodToJsonSchema(personSchema);
        
        // Navigate deep into the schema
        const addressProps = jsonSchema.properties?.['address'];
        const cityProps = (addressProps as JSONSchema)?.properties?.['city'];
        const citySchemaProps = (cityProps as JSONSchema)?.properties;
        
        expect(citySchemaProps?.['name']).toEqual({ type: 'string' });
        expect(citySchemaProps?.['population']).toEqual({ type: 'number' });
    });

    it('handles optional nested objects', () => {
        const schema = z.object({
            name: z.string(),
            metadata: z.object({
                created: z.string(),
            }).optional(),
        });
        
        const jsonSchema = zodToJsonSchema(schema);
        
        expect(jsonSchema.required).toEqual(['name']);
        expect(jsonSchema.properties?.['metadata']?.type).toBe('object');
    });
});

// ============================================================================
// Array Schema Tests (VAL-SCHEMA-010)
// ============================================================================

describe('Array Schema (VAL-SCHEMA-010)', () => {
    it('converts Zod array of strings to JSON Schema', () => {
        const schema = z.array(z.string());
        const jsonSchema = zodToJsonSchema(schema);
        
        expect(jsonSchema.type).toBe('array');
        expect(jsonSchema.items).toEqual({ type: 'string' });
    });

    it('converts Zod array of numbers to JSON Schema', () => {
        const schema = z.array(z.number());
        const jsonSchema = zodToJsonSchema(schema);
        
        expect(jsonSchema.type).toBe('array');
        expect(jsonSchema.items).toEqual({ type: 'number' });
    });

    it('converts Zod array of objects to JSON Schema', () => {
        const schema = z.array(z.object({
            id: z.string(),
            name: z.string(),
        }));
        const jsonSchema = zodToJsonSchema(schema);
        
        expect(jsonSchema.type).toBe('array');
        // zod-to-json-schema adds additionalProperties: false by default
        const items = jsonSchema.items as JSONSchema;
        expect(items.type).toBe('object');
        expect(items.properties?.['id']).toEqual({ type: 'string' });
        expect(items.properties?.['name']).toEqual({ type: 'string' });
        expect(items.required).toEqual(['id', 'name']);
    });

    it('converts nested arrays', () => {
        const schema = z.array(z.array(z.string()));
        const jsonSchema = zodToJsonSchema(schema);
        
        expect(jsonSchema.type).toBe('array');
        expect(jsonSchema.items).toEqual({
            type: 'array',
            items: { type: 'string' },
        });
    });

    it('handles array with min/max constraints', () => {
        const schema = z.array(z.string()).min(1).max(10);
        const jsonSchema = zodToJsonSchema(schema);
        
        expect(jsonSchema.type).toBe('array');
        expect(jsonSchema.minItems).toBe(1);
        expect(jsonSchema.maxItems).toBe(10);
    });
});

// ============================================================================
// Primitives Schema Tests
// ============================================================================

describe('Primitive Schemas', () => {
    it('converts Zod null schema', () => {
        const schema = z.null();
        const jsonSchema = zodToJsonSchema(schema);
        
        expect(jsonSchema.type).toBe('null');
    });

    it('converts Zod literal schema', () => {
        const schema = z.literal('fixed');
        const jsonSchema = zodToJsonSchema(schema);
        
        expect(jsonSchema.const).toBe('fixed');
    });

    it('converts Zod union schema', () => {
        const schema = z.union([z.string(), z.number()]);
        const jsonSchema = zodToJsonSchema(schema);
        
        // For primitive unions, zod-to-json-schema uses type array
        expect(jsonSchema.type).toEqual(['string', 'number']);
    });

    it('converts Zod record schema', () => {
        const schema = z.record(z.string(), z.number());
        const jsonSchema = zodToJsonSchema(schema);
        
        expect(jsonSchema.type).toBe('object');
        expect(jsonSchema.additionalProperties).toEqual({ type: 'number' });
    });

    it('converts Zod tuple schema', () => {
        const schema = z.tuple([z.string(), z.number()]);
        const jsonSchema = zodToJsonSchema(schema);
        
        expect(jsonSchema.type).toBe('array');
        expect(jsonSchema.minItems).toBe(2);
        expect(jsonSchema.maxItems).toBe(2);
    });
});

// ============================================================================
// Google-Specific Schema Transformation Tests (VAL-PROVIDER-GOOGLE-006)
// ============================================================================

describe('Google Schema Transformation (VAL-PROVIDER-GOOGLE-006)', () => {
    describe('stripUnsupportedFeatures', () => {
        it('removes pattern property (not supported by Gemini)', () => {
            const input: JSONSchema = {
                type: 'string',
                pattern: '^[a-zA-Z]+$',
            };
            
            const result = stripUnsupportedFeatures(input, 'google');
            
            expect(result.pattern).toBeUndefined();
            expect(result.type).toBe('string');
        });

        it('removes minLength/maxLength for strings', () => {
            const input: JSONSchema = {
                type: 'string',
                minLength: 1,
                maxLength: 100,
            };
            
            const result = stripUnsupportedFeatures(input, 'google');
            
            expect(result.minLength).toBeUndefined();
            expect(result.maxLength).toBeUndefined();
            expect(result.type).toBe('string');
        });

        it('keeps minLength/maxLength for other providers', () => {
            const input: JSONSchema = {
                type: 'string',
                minLength: 1,
                maxLength: 100,
            };
            
            const result = stripUnsupportedFeatures(input, 'openai');
            
            expect(result.minLength).toBe(1);
            expect(result.maxLength).toBe(100);
        });

        it('removes minimum/maximum for numbers', () => {
            const input: JSONSchema = {
                type: 'number',
                minimum: 0,
                maximum: 100,
            };
            
            const result = stripUnsupportedFeatures(input, 'google');
            
            expect(result.minimum).toBeUndefined();
            expect(result.maximum).toBeUndefined();
        });

        it('removes exclusiveMinimum/exclusiveMaximum', () => {
            const input: JSONSchema = {
                type: 'number',
                exclusiveMinimum: 0,
                exclusiveMaximum: 100,
            };
            
            const result = stripUnsupportedFeatures(input, 'google');
            
            expect(result.exclusiveMinimum).toBeUndefined();
            expect(result.exclusiveMaximum).toBeUndefined();
        });

        it('removes unsupported features recursively in nested objects', () => {
            const input: JSONSchema = {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        pattern: '^[a-z]+$',
                    },
                    age: {
                        type: 'number',
                        minimum: 0,
                    },
                },
            };
            
            const result = stripUnsupportedFeatures(input, 'google');
            
            expect(result.properties?.['name']?.pattern).toBeUndefined();
            expect(result.properties?.['age']?.minimum).toBeUndefined();
        });

        it('removes unsupported features in array items', () => {
            const input: JSONSchema = {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        code: {
                            type: 'string',
                            pattern: '^[A-Z]{3}$',
                        },
                    },
                },
            };
            
            const result = stripUnsupportedFeatures(input, 'google');
            
            const items = result.items as JSONSchema;
            expect(items.properties?.['code']?.pattern).toBeUndefined();
        });

        it('preserves required array', () => {
            const input: JSONSchema = {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    age: { type: 'number' },
                },
                required: ['name', 'age'],
            };
            
            const result = stripUnsupportedFeatures(input, 'google');
            
            expect(result.required).toEqual(['name', 'age']);
        });

        it('preserves enum array', () => {
            const input: JSONSchema = {
                type: 'string',
                enum: ['active', 'inactive', 'pending'],
            };
            
            const result = stripUnsupportedFeatures(input, 'google');
            
            expect(result.enum).toEqual(['active', 'inactive', 'pending']);
        });

        it('preserves description', () => {
            const input: JSONSchema = {
                type: 'object',
                description: 'User object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'User name',
                    },
                },
            };
            
            const result = stripUnsupportedFeatures(input, 'google');
            
            expect(result.description).toBe('User object');
            expect(result.properties?.['name']?.description).toBe('User name');
        });
    });

    describe('convertToProviderSchema for Google', () => {
        it('applies Google-specific transformations', () => {
            const schema = z.object({
                email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
            });
            
            const options: StructuredOutputOptions<{ email: string }> = {
                schema,
            };
            
            const result = convertToProviderSchema('google', options);
            
            // Google doesn't support pattern, should be stripped
            const emailProp = result.schema.properties?.['email'] as JSONSchema;
            expect(emailProp.pattern).toBeUndefined();
            expect(emailProp.type).toBe('string');
        });
    });
});
