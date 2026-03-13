# Structured Output

Get type-safe, validated responses from any LLM provider with Zod schemas. The library handles schema conversion, provider-specific formatting, response parsing, and validation automatically.

## Overview

Three methods for structured output:

| Method | Throws on failure | Returns |
|--------|:-----------------:|---------|
| `generateStructured()` | ✅ | `T` |
| `tryParseStructured()` | ❌ | `Result<T>` |
| `generateStructuredStream()` | ✅ (on final) | `AsyncGenerator<T>` |

## generateStructured

The primary method — sends your Zod schema to the LLM, parses the JSON response, and validates it against the schema. Returns a fully typed object.

```typescript
import { AIModel } from 'universal-llm-client';
import { z } from 'zod';

const model = new AIModel({
  model: 'gpt-4o-mini',
  providers: [{ type: 'openai', apiKey: process.env.OPENAI_API_KEY }],
});

const SentimentSchema = z.object({
  sentiment: z.enum(['positive', 'negative', 'neutral']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const result = await model.generateStructured(SentimentSchema, [
  { role: 'user', content: 'Analyze: "This product is amazing!"' },
]);

// result is typed as { sentiment: 'positive' | 'negative' | 'neutral', confidence: number, reasoning: string }
console.log(result.sentiment);  // "positive"
console.log(result.confidence); // 0.95
```

## tryParseStructured

Non-throwing variant that returns a discriminated union `Result<T>`:

```typescript
const result = await model.tryParseStructured(SentimentSchema, [
  { role: 'user', content: 'Analyze this text...' },
]);

if (result.ok) {
  // TypeScript narrows to { ok: true, value: T }
  console.log(result.value.sentiment);
} else {
  // TypeScript narrows to { ok: false, error: StructuredOutputError, rawOutput: string }
  console.error('Failed:', result.error.message);
  console.error('Raw LLM output:', result.rawOutput);
}
```

## generateStructuredStream

Stream partial validated objects as the LLM generates JSON token by token:

```typescript
const ArticleSchema = z.object({
  title: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
});

const stream = model.generateStructuredStream(ArticleSchema, [
  { role: 'user', content: 'Write an article about TypeScript' },
]);

for await (const partial of stream) {
  // partial is progressively filled as JSON streams in
  console.log(partial);
  // First:  { title: "TypeScript..." }
  // Then:   { title: "TypeScript...", summary: "A deep dive..." }
  // Final:  { title: "...", summary: "...", tags: ["typescript", "programming"] }
}
```

::: info
Partial yields are best-effort — only yielded when the partial JSON parses and validates successfully. The final object is always fully validated.
:::

## Inline via `chat()` Options

You can also pass structured output config directly to `chat()`:

```typescript
const response = await model.chat(
  [{ role: 'user', content: 'Generate a user profile' }],
  {
    output: {
      schema: UserSchema,
      name: 'user_profile',        // optional: hint for the LLM
      description: 'A user profile', // optional: hint for the LLM
    },
  },
);

// The response content will be the validated JSON
const user = JSON.parse(response.message.content as string);
```

## Error Handling

When validation fails, a `StructuredOutputError` is thrown with full debugging context:

```typescript
import { StructuredOutputError } from 'universal-llm-client';

try {
  const result = await model.generateStructured(StrictSchema, messages);
} catch (error) {
  if (error instanceof StructuredOutputError) {
    // The raw text the LLM returned (before parsing failed)
    console.log('Raw output:', error.rawOutput);

    // The underlying cause — ZodError for validation failures, SyntaxError for JSON parse errors
    if (error.cause instanceof z.ZodError) {
      console.log('Validation issues:', error.cause.issues);
    }
  }
}
```

### Error types

| Cause | Scenario |
|-------|----------|
| `SyntaxError` | LLM returned non-JSON text |
| `z.ZodError` | JSON parsed but doesn't match schema |

## Schema Tips

### Use `.describe()` for better LLM guidance

```typescript
const ReviewSchema = z.object({
  rating: z.number().min(1).max(5).describe('Rating from 1 (worst) to 5 (best)'),
  pros: z.array(z.string()).describe('List of positive aspects'),
  cons: z.array(z.string()).describe('List of negative aspects'),
});
```

### Optional fields with defaults

```typescript
const ConfigSchema = z.object({
  name: z.string(),
  debug: z.boolean().default(false),
  retries: z.number().default(3),
});
```

### Enums for constrained values

```typescript
const ClassificationSchema = z.object({
  category: z.enum(['bug', 'feature', 'question', 'docs']),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
});
```

### Nested objects

```typescript
const CompanySchema = z.object({
  name: z.string(),
  ceo: z.object({
    name: z.string(),
    age: z.number(),
  }),
  offices: z.array(z.object({
    city: z.string(),
    country: z.string(),
    employees: z.number(),
  })),
});
```

## Raw JSON Schema

If you don't want to use Zod, you can pass a raw JSON Schema directly:

```typescript
const response = await model.chat(messages, {
  output: {
    jsonSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name', 'age'],
    },
    name: 'user',
  },
});
```

::: warning
When using raw JSON Schema, responses are not type-checked at compile time and not validated at runtime by the Router. Use Zod schemas for full type safety.
:::

## OpenAI Strict Mode

OpenAI supports a `strict` mode that guarantees the response matches the schema exactly. This is enabled by default:

```typescript
const result = await model.generateStructured(MySchema, messages, {
  output: { strict: true }, // default for OpenAI
});
```

Set `strict: false` if you're using an OpenAI-compatible endpoint that doesn't support strict mode.

## Limitations

- **Cannot combine with tools** — structured output and tool calling are mutually exclusive per request
- **Streaming** — use `generateStructuredStream()` instead of `chatStream()` with output options
- **Provider support** — all built-in providers support structured output, but behavior varies (see [Providers](/guide/providers))
