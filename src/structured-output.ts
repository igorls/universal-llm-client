/**
 * Structured Output Core Types
 *
 * Core types for structured output support in universal-llm-client.
 * Zero-dependency — works with raw JSON Schema and optional validate functions.
 *
 * For Zod integration, use the `universal-llm-client/zod` entrypoint.
 *
 * @module structured-output
 */

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
// SchemaConfig — The core abstraction replacing z.ZodType<T>
// ============================================================================

/**
 * Universal schema configuration for structured output.
 *
 * This is the Bring-Your-Own-Validator interface. The core library never
 * imports Zod — instead it accepts a JSON Schema + optional validate function.
 *
 * Use `universal-llm-client/zod` → `fromZod()` to create this from Zod schemas.
 *
 * @template T The expected output type
 *
 * @example
 * ```typescript
 * // Zero-dep usage (no Zod):
 * const config: SchemaConfig<{ name: string; age: number }> = {
 *     jsonSchema: {
 *         type: 'object',
 *         properties: {
 *             name: { type: 'string' },
 *             age: { type: 'number' },
 *         },
 *         required: ['name', 'age'],
 *     },
 *     validate: (data) => data as { name: string; age: number },
 * };
 *
 * // With Zod (via adapter):
 * import { fromZod } from 'universal-llm-client/zod';
 * const config = fromZod(z.object({ name: z.string(), age: z.number() }));
 * ```
 */
export interface SchemaConfig<T = unknown> {
    /** JSON Schema sent to the LLM provider */
    readonly jsonSchema: JSONSchema;
    /**
     * Optional validator: parse unknown → T or throw.
     * If omitted, JSON.parse() result is returned as-is (unsafe cast).
     */
    readonly validate?: (data: unknown) => T;
    /** Schema name (for provider guidance, e.g. OpenAI strict mode) */
    readonly name?: string;
    /** Schema description (for provider guidance) */
    readonly description?: string;
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
    /** The underlying cause (e.g., validation error) */
    cause?: Error;
}

/**
 * Custom error class for structured output validation failures.
 *
 * Thrown when:
 * - JSON parsing of LLM response fails
 * - Schema validation fails
 *
 * Features:
 * - `rawOutput` property containing the original LLM response
 * - `cause` property for the underlying error
 *
 * @example
 * ```typescript
 * try {
 *   const result = await model.generateStructured(schema, messages);
 * } catch (error) {
 *   if (error instanceof StructuredOutputError) {
 *     console.log('Raw LLM output:', error.rawOutput);
 *     console.log('Cause:', error.cause);
 *   }
 * }
 * ```
 */
export class StructuredOutputError extends Error {
    /** The raw output from the LLM that failed validation */
    public readonly rawOutput: string;

    /** The underlying cause (e.g., validation error) */
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
// Structured Output Options (legacy — prefer SchemaConfig)
// ============================================================================

/**
 * Options for structured output generation.
 *
 * Accepts either:
 * - A SchemaConfig (recommended)
 * - A raw JSON Schema object for flexibility
 *
 * @template T The expected output type
 *
 * @example
 * ```typescript
 * // Using SchemaConfig
 * const options: StructuredOutputOptions<User> = {
 *   schemaConfig: mySchemaConfig,
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
     * Schema configuration for structured output.
     * Contains JSON Schema + optional validator.
     */
    schemaConfig?: SchemaConfig<T>;

    /**
     * Raw JSON Schema for structured output.
     * Use this when you have a pre-defined schema without validation.
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
 */
export type StructuredOutputResult<T> =
    | StructuredOutputSuccess<T>
    | StructuredOutputFailure<T>;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if a structured output result is successful.
 */
export function isStructuredOutputSuccess<T>(
    result: StructuredOutputResult<T>,
): result is StructuredOutputSuccess<T> {
    return result.ok === true;
}

/**
 * Type guard to check if a structured output result is a failure.
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
 * Get the JSON Schema from a SchemaConfig or StructuredOutputOptions.
 *
 * @param options The structured output options
 * @returns JSON Schema
 */
export function getJsonSchema<T>(options: StructuredOutputOptions<T>): JSONSchema {
    if (options.schemaConfig) {
        return normalizeJsonSchema(options.schemaConfig.jsonSchema);
    }
    if (options.jsonSchema) {
        return normalizeJsonSchema(options.jsonSchema);
    }
    throw new Error('Either schemaConfig or jsonSchema must be provided');
}

/**
 * Get the JSON Schema from a SchemaConfig directly.
 */
export function getJsonSchemaFromConfig<T>(config: SchemaConfig<T>): JSONSchema {
    return normalizeJsonSchema(config.jsonSchema);
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
    // Google doesn't support additionalProperties in response schema
    'additionalProperties',
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

    if (result['items']) {
        if (Array.isArray(result['items'])) {
            (result as Record<string, unknown>)['items'] = result['items'].map(item => stripUnsupportedFeatures(item as JSONSchema, provider));
        } else {
            result['items'] = stripUnsupportedFeatures(result['items'] as JSONSchema, provider);
        }
    }

    // Handle oneOf, anyOf, allOf
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        const schemas = result[key];
        if (Array.isArray(schemas)) {
            (result as Record<string, unknown>)[key] = schemas.map(s => stripUnsupportedFeatures(s, provider));
        }
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
 */
export function convertToProviderSchema<T>(
    provider: SchemaProvider,
    options: StructuredOutputOptions<T>,
): ProviderSchema {
    // Get the JSON Schema
    const jsonSchema = getJsonSchema(options);

    // Apply provider-specific transformations
    const schema = stripUnsupportedFeatures(jsonSchema, provider);

    // Generate a default name if not provided (some providers require it)
    const name = options.name ?? options.schemaConfig?.name ?? 'response';

    return {
        schema,
        name,
        description: options.description ?? options.schemaConfig?.description,
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
 * 2. Validates using the SchemaConfig's validate function (if provided)
 * 3. Throws StructuredOutputError on failure
 *
 * @param config The schema configuration with optional validator
 * @param rawOutput The raw string output from the LLM
 * @returns The validated and typed data
 * @throws StructuredOutputError if JSON parsing fails or validation fails
 */
export function parseStructured<T>(
    config: SchemaConfig<T>,
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

    // Step 2: Validate if validator is provided
    if (config.validate) {
        try {
            return config.validate(parsed);
        } catch (error) {
            const validationError = error instanceof Error ? error : new Error(String(error));
            throw new StructuredOutputError(
                `Validation failed: ${validationError.message}`,
                { rawOutput, cause: validationError },
            );
        }
    }

    // No validator — return as-is (unsafe cast, user chose to skip validation)
    return parsed as T;
}

/**
 * Try to parse and validate structured output, returning a result object.
 *
 * This is the non-throwing variant of `parseStructured`. Instead of throwing
 * on validation failure, it returns a result object with `ok: false` and
 * the error details.
 *
 * @param config The schema configuration with optional validator
 * @param rawOutput The raw string output from the LLM
 * @returns A result object: `{ ok: true, value }` on success, `{ ok: false, error, rawOutput }` on failure
 */
export function tryParseStructured<T>(
    config: SchemaConfig<T>,
    rawOutput: string,
): StructuredOutputResult<T> {
    try {
        const value = parseStructured(config, rawOutput);
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
 * Validate already-parsed data using a SchemaConfig's validator.
 *
 * This is useful when you have already parsed JSON and need to validate it.
 *
 * @param config The schema configuration with optional validator
 * @param data The parsed data to validate
 * @param rawOutput Optional raw output string for error messages
 * @returns The validated and typed data
 * @throws StructuredOutputError if validation fails
 */
export function validateStructuredOutput<T>(
    config: SchemaConfig<T>,
    data: unknown,
    rawOutput?: string,
): T {
    if (config.validate) {
        try {
            return config.validate(data);
        } catch (error) {
            const rawData = rawOutput ?? JSON.stringify(data);
            const validationError = error instanceof Error ? error : new Error(String(error));
            throw new StructuredOutputError(
                `Validation failed: ${validationError.message}`,
                { rawOutput: rawData, cause: validationError },
            );
        }
    }
    return data as T;
}

// ============================================================================
// Streaming JSON Parsing
// ============================================================================

/**
 * Incremental JSON parser for streaming structured output.
 *
 * Allows parsing partial JSON as it streams in, returning validated partial
 * objects when possible. Useful for structured output streaming where you
 * want to see partial results before the complete JSON arrives.
 */
export class StreamingJsonParser<T> {
    private buffer = '';
    private readonly validateFn?: (data: unknown) => T;

    constructor(config: SchemaConfig<T>) {
        this.validateFn = config.validate;
    }

    /**
     * Feed a chunk of JSON text to the parser.
     * Returns a validated partial object if the current buffer can be parsed
     * as valid JSON that passes validation, or undefined if not yet valid.
     */
    feed(chunk: string): { partial: T | undefined; complete: boolean } {
        this.buffer += chunk;

        // Try to parse as complete JSON first
        try {
            const parsed = JSON.parse(this.buffer);
            if (this.validateFn) {
                try {
                    const validated = this.validateFn(parsed);
                    return { partial: validated, complete: true };
                } catch {
                    // Validation failed on complete JSON — return parsed but not validated
                }
            }
            return { partial: parsed as T, complete: true };
        } catch {
            // Not yet valid complete JSON
        }

        // Try to create a valid partial by closing braces
        const partialResult = this.tryParsePartial();
        return { partial: partialResult, complete: false };
    }

    /**
     * Get the current buffer content.
     */
    getBuffer(): string {
        return this.buffer;
    }

    /**
     * Reset the parser state.
     */
    reset(): void {
        this.buffer = '';
    }

    /**
     * Attempt to parse partial JSON by adding closing brackets.
     */
    private tryParsePartial(): T | undefined {
        // Count unclosed brackets and braces
        let braceCount = 0;
        let bracketCount = 0;
        let inString = false;
        let escaped = false;

        for (let i = 0; i < this.buffer.length; i++) {
            const char = this.buffer[i];

            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === '\\' && inString) {
                escaped = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (inString) continue;

            if (char === '{') braceCount++;
            else if (char === '}') braceCount--;
            else if (char === '[') bracketCount++;
            else if (char === ']') bracketCount--;
        }

        // Build closing sequence
        let closing = '';
        while (bracketCount > 0) {
            closing += ']';
            bracketCount--;
        }
        while (braceCount > 0) {
            closing += '}';
            braceCount--;
        }

        // Try parsing with closing
        const candidate = this.buffer + closing;
        try {
            const parsed = JSON.parse(candidate);
            if (this.validateFn) {
                try {
                    return this.validateFn(parsed);
                } catch {
                    // Partial validation failed — that's expected for partials
                }
            }
            return parsed as T;
        } catch {
            // Silently fail for partial JSON
        }

        return undefined;
    }
}

/**
 * Streaming structured output result.
 * Each partial yield from the generator is a validated object (possibly partial).
 * The final return value is the complete validated object.
 */
export interface StreamingStructuredResult<T> {
    /** Whether this is partial (incomplete) data */
    partial: boolean;
    /** The validated partial or complete object */
    value: T;
}
