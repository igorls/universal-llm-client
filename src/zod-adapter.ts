/**
 * Zod Adapter for Universal LLM Client
 *
 * Optional entrypoint for projects that use Zod for schema validation.
 * Import from 'universal-llm-client/zod' to use.
 *
 * @module universal-llm-client/zod
 */

import { z } from 'zod';
import type { SchemaConfig } from './structured-output.js';

/**
 * Create a SchemaConfig from a Zod schema.
 *
 * This bridges Zod's type-safe schema definitions to the library's
 * generic SchemaConfig interface, using Zod 4's native `z.toJSONSchema()`.
 *
 * @template T The type inferred from the Zod schema
 * @param schema The Zod schema
 * @param options Optional name and description for LLM guidance
 * @returns SchemaConfig ready for use with generateStructured, etc.
 *
 * @example
 * ```typescript
 * import { fromZod } from 'universal-llm-client/zod';
 * import { z } from 'zod';
 *
 * const UserSchema = z.object({
 *   name: z.string(),
 *   age: z.number(),
 * });
 *
 * const config = fromZod(UserSchema, { name: 'User' });
 *
 * const user = await model.generateStructured(config, messages);
 * // user.name: string, user.age: number (fully typed)
 * ```
 */
export function fromZod<T>(
    schema: z.ZodType<T>,
    options?: { name?: string; description?: string },
): SchemaConfig<T> {
    // Convert Zod schema to JSON Schema using Zod 4's native method
    const rawJsonSchema = z.toJSONSchema(schema, {
        target: 'draft-07',
        unrepresentable: 'any',
    });

    // Clean up — remove $schema since providers don't need it
    const jsonSchema = { ...rawJsonSchema } as Record<string, unknown>;
    delete jsonSchema.$schema;

    return {
        jsonSchema: jsonSchema as import('./structured-output.js').JSONSchema,
        validate: (data: unknown): T => {
            const result = schema.safeParse(data);
            if (!result.success) {
                throw result.error;
            }
            return result.data;
        },
        name: options?.name,
        description: options?.description,
    };
}

// Re-export z for convenience (users importing from /zod likely want it)
export { z } from 'zod';

// Re-export SchemaConfig for type usage
export type { SchemaConfig } from './structured-output.js';
