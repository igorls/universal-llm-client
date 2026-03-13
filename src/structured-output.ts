/**
 * Structured Output Core Types
 *
 * Core types for structured output support in universal-llm-client.
 * Provides type-safe Zod schema integration and JSON Schema support.
 *
 * @module structured-output
 */

import { z } from 'zod';
import { zodToJsonSchema as zodToJsonSchemaLib } from 'zod-to-json-schema';

// ============================================================================
// JSON Schema Types
// ============================================================================

/**
 * JSON Schema definition for structured output.
 * This is a subset of JSON Schema focused on what providers need.
 */
export interface JSONSchema {
    type?: string | string[];
    properties?: Record<string, JSONSchema>;
    items?: JSONSchema | { type: string };
    required?: string[];
    additionalProperties?: boolean | JSONSchema;
    enum?: (string | number | boolean | null)[];
    const?: unknown;
    oneOf?: JSONSchema[];
    anyOf?: JSONSchema[];
    allOf?: JSONSchema[];
    not?: JSONSchema;
    description?: string;
    default?: unknown;
    examples?: unknown[];
    title?: string;
    format?: string;
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    minProperties?: number;
    maxProperties?: number;
    $ref?: string;
    $id?: string;
    $schema?: string;
    definitions?: Record<string, JSONSchema>;
    $defs?: Record<string, JSONSchema>;
}

// ============================================================================
// Provider Schema Types
// ============================================================================

/**
 * Provider identifier for schema conversion.
 */
export type SchemaProvider = 'openai' | 'ollama' | 'google';

/**
 * Result of converting a schema for a specific provider.
 */
export interface ProviderSchema {
    /** The JSON Schema for the provider */
    schema: JSONSchema;
    /** Optional schema name (used by OpenAI) */
    name?: string;
    /** Optional schema description (used by OpenAI) */
    description?: string;
}

// ============================================================================
// Structured Output Error
// ============================================================================

/**
 * Error options for StructuredOutputError
 */
export interface StructuredOutputErrorOptions {
    /** The raw output from the LLM that failed validation */
    rawOutput: string;
    /** The underlying cause (e.g., ZodError) */
    cause?: Error;
}

/**
 * Custom error class for structured output validation failures.
 *
 * Thrown when:
 * - JSON parsing of LLM response fails
 * - Zod schema validation fails
 *
 * Features:
 * - `rawOutput` property containing the original LLM response
 * - `cause` property for the underlying error (ZodError, SyntaxError, etc.)
 *
 * @example
 * ```typescript
 * try {
 *   const result = await model.generateStructured(UserSchema, messages);
 * } catch (error) {
 *   if (error instanceof StructuredOutputError) {
 *     console.log('Raw LLM output:', error.rawOutput);
 *     if (error.cause instanceof z.ZodError) {
 *       console.log('Validation errors:', error.cause.errors);
 *     }
 *   }
 * }
 * ```
 */
export class StructuredOutputError extends Error {
    /** The raw output from the LLM that failed validation */
    public readonly rawOutput: string;

    /** The underlying cause (e.g., ZodError for schema validation failures) */
    public override readonly cause?: Error;

    constructor(message: string, options: StructuredOutputErrorOptions) {
        super(message);
        this.rawOutput = options.rawOutput;
        this.cause = options.cause;

        // Maintains proper stack trace for where error was thrown (only available in V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, StructuredOutputError);
        }
    }
}

// ============================================================================
// Structured Output Options
// ============================================================================

/**
 * Options for structured output generation.
 *
 * Accepts either:
 * - A Zod schema (`schema`) for type-safe validation
 * - A raw JSON Schema object (`jsonSchema`) for flexibility
 *
 * Optional `name` and `description` can be provided for LLM guidance
 * (used by providers like OpenAI that support schema names).
 *
 * @template T The expected output type (inferred from Zod schema)
 *
 * @example
 * ```typescript
 * // Using Zod schema (recommended)
 * const UserSchema = z.object({
 *   name: z.string(),
 *   age: z.number(),
 * });
 *
 * const options: StructuredOutputOptions<User> = {
 *   schema: UserSchema,
 *   name: 'User',
 *   description: 'A user object',
 * };
 * ```
 *
 * @example
 * ```typescript
 * // Using raw JSON Schema
 * const options: StructuredOutputOptions<User> = {
 *   jsonSchema: {
 *     type: 'object',
 *     properties: {
 *       name: { type: 'string' },
 *       age: { type: 'number' },
 *     },
 *     required: ['name', 'age'],
 *   },
 * };
 * ```
 */
export interface StructuredOutputOptions<T> {
    /**
     * Zod schema for structured output.
     * Use this for type-safe validation with automatic type inference.
     */
    schema?: z.ZodType<T>;

    /**
     * Raw JSON Schema for structured output.
     * Use this when you have a pre-defined schema without Zod.
     */
    jsonSchema?: JSONSchema;

    /**
     * Optional name for the schema.
     * Used by providers like OpenAI for better LLM guidance.
     */
    name?: string;

    /**
     * Optional description for the schema.
     * Used by providers like OpenAI for better LLM guidance.
     */
    description?: string;
}

// ============================================================================
// Structured Output Result
// ============================================================================

/**
 * Successful structured output result.
 *
 * @template T The output type
 */
export interface StructuredOutputSuccess<T> {
    /** Indicates success */
    readonly ok: true;
    /** The validated output value */
    readonly value: T;
}

/**
 * Failed structured output result.
 *
 * @template _T The expected output type (unused but kept for type alignment with StructuredOutputSuccess)
 */
export interface StructuredOutputFailure<_T> {
    /** Indicates failure */
    readonly ok: false;
    /** The error that occurred */
    readonly error: StructuredOutputError;
    /** The raw output from the LLM */
    readonly rawOutput: string;
}

/**
 * Result of structured output parsing.
 *
 * Discriminated union type that provides type-safe result handling:
 * - `ok: true` → `{ value: T }`
 * - `ok: false` → `{ error: StructuredOutputError, rawOutput: string }`
 *
 * @template T The output type
 *
 * @example
 * ```typescript
 * const result = await model.tryParseStructured(UserSchema, messages);
 *
 * if (result.ok) {
 *   // TypeScript knows result.value is User
 *   console.log('User:', result.value.name);
 * } else {
 *   // TypeScript knows result.error is StructuredOutputError
 *   console.log('Error:', result.error.message);
 *   console.log('Raw output:', result.rawOutput);
 * }
 * ```
 */
export type StructuredOutputResult<T> =
    | StructuredOutputSuccess<T>
    | StructuredOutputFailure<T>;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if a structured output result is successful.
 *
 * @param result The result to check
 * @returns true if the result is successful
 *
 * @example
 * ```typescript
 * const result = await model.tryParseStructured(UserSchema, messages);
 *
 * if (isStructuredOutputSuccess(result)) {
 *   console.log('User:', result.value.name);
 * } else {
 *   console.log('Error:', result.error.message);
 * }
 * ```
 */
export function isStructuredOutputSuccess<T>(
    result: StructuredOutputResult<T>,
): result is StructuredOutputSuccess<T> {
    return result.ok === true;
}

/**
 * Type guard to check if a structured output result is a failure.
 *
 * @param result The result to check
 * @returns true if the result is a failure
 *
 * @example
 * ```typescript
 * const result = await model.tryParseStructured(UserSchema, messages);
 *
 * if (isStructuredOutputFailure(result)) {
 *   console.log('Error:', result.error.message);
 *   console.log('Raw:', result.rawOutput);
 * }
 * ```
 */
export function isStructuredOutputFailure<T>(
    result: StructuredOutputResult<T>,
): result is StructuredOutputFailure<T> {
    return result.ok === false;
}

// ============================================================================
// Schema Conversion Utilities
// ============================================================================

/**
 * Convert a Zod schema to JSON Schema.
 *
 * Uses zod-to-json-schema library for conversion.
 * Handles all Zod types including objects, arrays, primitives, enums, and nested structures.
 *
 * @param schema The Zod schema to convert
 * @returns JSON Schema representation
 *
 * @example
 * ```typescript
 * const UserSchema = z.object({
 *   name: z.string(),
 *   age: z.number(),
 * });
 *
 * const jsonSchema = zodToJsonSchema(UserSchema);
 * // { type: 'object', properties: { name: { type: 'string' }, ... }, required: ['name', 'age'] }
 * ```
 */
export function zodToJsonSchema<T>(schema: z.ZodType<T>): JSONSchema {
    const result = zodToJsonSchemaLib(schema, {
        // Don't add $schema to output
        $refStrategy: 'none',
        // Don't include definitions for simple schemas
        target: 'jsonSchema7',
    });

    // Remove $schema and other metadata we don't need
    const cleanResult = result as JSONSchema;
    delete cleanResult.$schema;
    delete cleanResult.definitions;
    delete cleanResult.$defs;

    return cleanResult;
}

/**
 * Normalize a raw JSON Schema.
 *
 * Currently passes through without modification.
 * Future versions may add normalization for provider compatibility.
 *
 * @param schema The JSON Schema to normalize
 * @returns Normalized JSON Schema
 */
export function normalizeJsonSchema(schema: JSONSchema): JSONSchema {
    // Deep clone to avoid mutating the input
    return JSON.parse(JSON.stringify(schema)) as JSONSchema;
}

/**
 * Get the JSON Schema from options.
 *
 * Converts Zod schema to JSON Schema if necessary, or normalizes raw JSON Schema.
 *
 * @param options The structured output options
 * @returns JSON Schema
 */
export function getJsonSchema<T>(options: StructuredOutputOptions<T>): JSONSchema {
    if (options.schema) {
        return zodToJsonSchema(options.schema);
    }
    if (options.jsonSchema) {
        return normalizeJsonSchema(options.jsonSchema);
    }
    throw new Error('Either schema or jsonSchema must be provided');
}

/**
 * Features that some providers don't support.
 * These are removed when transforming schemas for those providers.
 */
const GOOGLE_UNSUPPORTED_FEATURES = [
    'pattern',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
] as const;

/**
 * Strip unsupported features from a JSON Schema for a specific provider.
 *
 * Google/Gemini doesn't support certain JSON Schema features like pattern, min/max.
 * This function removes those recursively.
 *
 * @param schema The JSON Schema to transform
 * @param provider The target provider
 * @returns Cleaned JSON Schema
 *
 * @example
 * ```typescript
 * const schema = {
 *   type: 'string',
 *   pattern: '^[a-z]+$',
 *   minLength: 1,
 * };
 *
 * const cleaned = stripUnsupportedFeatures(schema, 'google');
 * // { type: 'string' } - pattern and minLength removed
 * ```
 */
export function stripUnsupportedFeatures(
    schema: JSONSchema,
    provider: SchemaProvider,
): JSONSchema {
    // Only Google needs transformation currently
    if (provider !== 'google') {
        return schema;
    }

    // Deep clone to avoid mutating input
    const result: JSONSchema = JSON.parse(JSON.stringify(schema));

    // Remove unsupported top-level properties
    for (const feature of GOOGLE_UNSUPPORTED_FEATURES) {
        delete (result as Record<string, unknown>)[feature];
    }

    // Recursively clean nested schemas
    if (result.properties) {
        for (const key of Object.keys(result.properties)) {
            if (result.properties[key]) {
                result.properties[key] = stripUnsupportedFeatures(result.properties[key], provider);
            }
        }
    }

    if (result.items) {
        if (Array.isArray(result.items)) {
            (result as Record<string, unknown>).items = result.items.map(item => stripUnsupportedFeatures(item as JSONSchema, provider));
        } else {
            result.items = stripUnsupportedFeatures(result.items as JSONSchema, provider);
        }
    }

    // Handle oneOf, anyOf, allOf
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        const schemas = result[key];
        if (Array.isArray(schemas)) {
            (result as Record<string, unknown>)[key] = schemas.map(s => stripUnsupportedFeatures(s, provider));
        }
    }

    // Handle additionalProperties
    if (typeof result.additionalProperties === 'object' && result.additionalProperties !== null) {
        result.additionalProperties = stripUnsupportedFeatures(result.additionalProperties as JSONSchema, provider);
    }

    return result;
}

/**
 * Convert structured output options to a provider-specific schema.
 *
 * This function:
 * 1. Extracts/converts the JSON Schema from options
 * 2. Applies provider-specific transformations (e.g., removing unsupported features for Google)
 * 3. Adds name/description for LLM guidance
 *
 * @param provider The target provider
 * @param options The structured output options
 * @returns Provider-ready schema with name and description
 *
 * @example
 * ```typescript
 * const result = convertToProviderSchema('openai', {
 *   schema: z.object({ name: z.string() }),
 *   name: 'User',
 *   description: 'A user object',
 * });
 *
 * // result.schema - JSON Schema
 * // result.name - 'User'
 * // result.description - 'A user object'
 * ```
 */
export function convertToProviderSchema<T>(
    provider: SchemaProvider,
    options: StructuredOutputOptions<T>,
): ProviderSchema {
    // Get the JSON Schema (convert from Zod or normalize raw)
    const jsonSchema = getJsonSchema(options);

    // Apply provider-specific transformations
    const schema = stripUnsupportedFeatures(jsonSchema, provider);

    // Generate a default name if not provided (some providers require it)
    const name = options.name ?? 'response';

    return {
        schema,
        name,
        description: options.description,
    };
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Parse and validate structured output from raw LLM response text.
 *
 * This function:
 * 1. Parses JSON from the raw output string
 * 2. Validates the parsed data against the Zod schema
 * 3. Throws StructuredOutputError on failure
 *
 * @param schema The Zod schema to validate against
 * @param rawOutput The raw string output from the LLM
 * @returns The validated and typed data
 * @throws StructuredOutputError if JSON parsing fails or schema validation fails
 *
 * @example
 * ```typescript
 * const schema = z.object({ name: z.string(), age: z.number() });
 * const rawOutput = '{"name": "Alice", "age": 30}';
 * const result = parseStructured(schema, rawOutput); // { name: "Alice", age: 30 }
 * ```
 */
export function parseStructured<T>(
    schema: z.ZodType<T>,
    rawOutput: string,
): T {
    // Step 1: Parse JSON
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawOutput);
    } catch (error) {
        // JSON parsing failed - wrap in StructuredOutputError
        const syntaxError = error instanceof SyntaxError
            ? error
            : new SyntaxError(String(error));
        throw new StructuredOutputError(
            `Failed to parse JSON: ${syntaxError.message}`,
            { rawOutput, cause: syntaxError },
        );
    }

    // Step 2: Validate against Zod schema
    const result = schema.safeParse(parsed);
    if (!result.success) {
        // Schema validation failed - throw with ZodError as cause
        throw new StructuredOutputError(
            `Validation failed: ${result.error.errors.map(e => e.message).join(', ')}`,
            { rawOutput, cause: result.error },
        );
    }

    return result.data;
}

/**
 * Try to parse and validate structured output, returning a result object.
 *
 * This is the non-throwing variant of `parseStructured`. Instead of throwing
 * on validation failure, it returns a result object with `ok: false` and
 * the error details.
 *
 * @param schema The Zod schema to validate against
 * @param rawOutput The raw string output from the LLM
 * @returns A result object: `{ ok: true, value }` on success, `{ ok: false, error, rawOutput }` on failure
 *
 * @example
 * ```typescript
 * const schema = z.object({ name: z.string(), age: z.number() });
 *
 * // Success case
 * const result1 = tryParseStructured(schema, '{"name": "Alice", "age": 30}');
 * if (result1.ok) {
 *   console.log(result1.value.name); // "Alice"
 * }
 *
 * // Failure case
 * const result2 = tryParseStructured(schema, 'invalid json');
 * if (!result2.ok) {
 *   console.log(result2.error.message); // Error message
 *   console.log(result2.rawOutput); // Original output
 * }
 * ```
 */
export function tryParseStructured<T>(
    schema: z.ZodType<T>,
    rawOutput: string,
): StructuredOutputResult<T> {
    try {
        const value = parseStructured(schema, rawOutput);
        return { ok: true, value };
    } catch (error) {
        if (error instanceof StructuredOutputError) {
            return {
                ok: false,
                error,
                rawOutput,
            };
        }
        // Re-throw unexpected errors
        throw error;
    }
}

/**
 * Validate already-parsed data against a Zod schema.
 *
 * This is useful when you have already parsed JSON and need to validate
 * it against a schema, with optional raw output for error messages.
 *
 * @param schema The Zod schema to validate against
 * @param data The parsed data to validate
 * @param rawOutput Optional raw output string for error messages
 * @returns The validated and typed data
 * @throws StructuredOutputError if schema validation fails
 *
 * @example
 * ```typescript
 * const schema = z.object({ name: z.string(), age: z.number() });
 * const data = JSON.parse('{"name": "Alice", "age": 30}');
 * const result = validateStructuredOutput(schema, data); // { name: "Alice", age: 30 }
 * ```
 */
export function validateStructuredOutput<T>(
    schema: z.ZodType<T>,
    data: unknown,
    rawOutput?: string,
): T {
    const result = schema.safeParse(data);
    if (!result.success) {
        const rawData = rawOutput ?? JSON.stringify(data);
        throw new StructuredOutputError(
            `Validation failed: ${result.error.errors.map(e => e.message).join(', ')}`,
            { rawOutput: rawData, cause: result.error },
        );
    }
    return result.data;
}

// ============================================================================
// Re-exports for Convenience
// ============================================================================

// Re-export Zod for users who need it
export { z } from 'zod';
