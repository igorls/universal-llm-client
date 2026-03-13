/**
 * Structured Output Core Types
 *
 * Core types for structured output support in universal-llm-client.
 * Provides type-safe Zod schema integration and JSON Schema support.
 *
 * @module structured-output
 */

import { z } from 'zod';

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
// Re-exports for Convenience
// ============================================================================

// Re-export Zod for users who need it
export { z } from 'zod';
