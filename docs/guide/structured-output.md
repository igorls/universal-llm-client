# Structured Output

Ask for JSON in a shape you define and get back a parsed, validated, typed value. The library sends the schema in each protocol's native form where the protocol has one, parses the response, and runs your validator on it.

## Overview

| Method | Throws on failure | Returns |
|--------|:-----------------:|---------|
| `generateStructured()` | Yes | `T` |
| `tryParseStructured()` | No | `StructuredOutputResult<T>` |
| `generateStructuredStream()` | Yes, on the final object | `AsyncGenerator<T, T>` |
| `chat(messages, { output })` | Yes | `LLMChatResponse` with `structured` |

## Describing a schema

Every method takes a `SchemaConfig<T>`: a JSON Schema plus an optional validator.

```typescript
interface SchemaConfig<T> {
  jsonSchema: JSONSchema;                 // sent to the provider
  validate?: (data: unknown) => T;        // parse unknown to T, or throw
  name?: string;
  description?: string;
}
```

### With Zod

Zod is an optional peer dependency. Install it (`zod@^4`) and wrap a schema with `fromZod` from `universal-llm-client/zod`:

```typescript
import { fromZod } from 'universal-llm-client/zod';
import { z } from 'zod';

const Sentiment = fromZod(
  z.object({
    sentiment: z.enum(['positive', 'negative', 'neutral']),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
  }),
);
```

`fromZod` converts the schema with Zod 4's `z.toJSONSchema()` and uses `schema.safeParse` as the validator, so `T` is inferred from the Zod schema.

### Without Zod

Write the JSON Schema and a validator yourself. The core library does not import Zod:

```typescript
import type { SchemaConfig } from 'universal-llm-client';

type Person = { name: string; age: number };

const PersonSchema: SchemaConfig<Person> = {
  jsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
    },
    required: ['name', 'age'],
  },
  validate: (data) => {
    const p = data as Person;
    if (typeof p?.name !== 'string' || typeof p?.age !== 'number') {
      throw new Error('Not a Person');
    }
    return p;
  },
};
```

If `validate` is omitted, the parsed JSON is returned as is, with no runtime check.

## generateStructured

Sends the schema, parses the JSON response, validates it, and returns the typed value:

```typescript
import { AIModel } from 'universal-llm-client';

const model = new AIModel({
  model: 'model-id',
  providers: [{ type: 'openai', url: 'https://llm.example.com/v1', apiKey: process.env.LLM_API_KEY }],
});

const result = await model.generateStructured(Sentiment, [
  { role: 'user', content: 'Analyze: "This product is amazing!"' },
]);

// result: { sentiment: 'positive' | 'negative' | 'neutral'; confidence: number; reasoning: string }
console.log(result.sentiment);
```

## tryParseStructured

The non-throwing variant. It returns a discriminated union:

```typescript
const result = await model.tryParseStructured(Sentiment, [
  { role: 'user', content: 'Analyze this text...' },
]);

if (result.ok) {
  console.log(result.value.sentiment);
} else {
  console.error('Failed:', result.error.message);
  console.error('Raw output:', result.rawOutput);
}
```

This reports validation and parse failures as a result. A transport error after every provider has failed still throws.

## generateStructuredStream

Streams partial validated objects as the JSON generates:

```typescript
const Article = fromZod(
  z.object({
    title: z.string(),
    summary: z.string(),
    tags: z.array(z.string()),
  }),
);

for await (const partial of model.generateStructuredStream(Article, [
  { role: 'user', content: 'Write an article about TypeScript' },
])) {
  console.log(partial);
  // { title: '...' }
  // { title: '...', summary: '...' }
  // { title: '...', summary: '...', tags: [...] }
}
```

::: info
Partial yields are best-effort: one is yielded only when the partial JSON parses and validates. The final object is always fully validated, and a failure there throws `StructuredOutputError`.
:::

## Through `chat()`

Pass `output` to get the validated value on `response.structured`:

```typescript
const response = await model.chat(
  [{ role: 'user', content: 'Generate a user profile' }],
  {
    output: {
      schema: User,                    // a SchemaConfig
      name: 'user_profile',            // optional hint
      description: 'A user profile',   // optional hint
    },
  },
);

response.structured; // typed from the schema
```

`chatStream()` throws if you pass `output`. Use `generateStructuredStream()` for streaming.

## Error handling

A parse or validation failure throws `StructuredOutputError`, with the text the model returned:

```typescript
import { StructuredOutputError } from 'universal-llm-client';
import { z } from 'zod';

try {
  await model.generateStructured(Sentiment, messages);
} catch (error) {
  if (error instanceof StructuredOutputError) {
    console.log('Raw output:', error.rawOutput);

    if (error.cause instanceof z.ZodError) {
      console.log('Validation issues:', error.cause.issues);
    }
  }
}
```

| `error.cause` | Scenario |
|-------|----------|
| `SyntaxError` | The model returned text that is not JSON |
| `z.ZodError` | The JSON parsed but does not match the Zod schema |

Responses wrapped in a Markdown code fence are unwrapped before parsing.

## Schema tips

### Describe fields

Descriptions in the schema reach the model:

```typescript
const Review = fromZod(
  z.object({
    rating: z.number().min(1).max(5).describe('Rating from 1 (worst) to 5 (best)'),
    pros: z.array(z.string()).describe('Positive aspects'),
    cons: z.array(z.string()).describe('Negative aspects'),
  }),
);
```

### Constrain values with enums

```typescript
const Classification = fromZod(
  z.object({
    category: z.enum(['bug', 'feature', 'question', 'docs']),
    priority: z.enum(['low', 'medium', 'high', 'critical']),
  }),
);
```

## JSON Schema only

When you have a schema and no validator, pass `jsonSchema` in `output`:

```typescript
const response = await model.chat(messages, {
  output: {
    jsonSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name', 'age'],
    },
    name: 'user',
  },
});

response.structured; // parsed JSON, typed unknown
```

::: warning
With no validator, the router parses the JSON but does not check it against the schema. Use a validator for runtime safety.
:::

## How each protocol receives the schema

| Protocol | Request field | Notes |
|---|---|---|
| OpenAI Chat Completions | `response_format` of type `json_schema` | Sent with `strict: true` |
| Gemini | `responseMimeType` and `responseSchema` | Keywords the format does not support are removed from the schema before sending |
| Ollama | `format` | |
| Anthropic Messages | None | The client sends no schema. Describe the format in the prompt; the response is still parsed and validated |

Validation always runs in the router on the response, so it behaves the same whichever protocol answered, including during [failover](/guide/failover).

### Strict mode and endpoints that reject `response_format`

`OutputOptions.strict` is declared on the type, but the OpenAI Chat Completions client does not read it: the request always carries `strict: true`. For an endpoint that rejects `response_format`, set `omitResponseFormat: true` on that provider entry. The schema is then not sent, structured output relies on the prompt, and the response is validated as usual:

```typescript
{ type: 'openai', url: 'https://llm.example.com/v1', omitResponseFormat: true }
```

## Combining with tools

Structured output and tool calling can be used in one request. The provider receives both the schema and the tool definitions. If the model answers with text, the text is validated. If it answers with tool calls, validation is skipped and the calls are returned:

```typescript
const result = await model.chat(messages, {
  output: { schema: Result },
  tools: [myTool],
});

// result.structured is set when the model returned content
// result.message.tool_calls is set when the model called a tool
```

## Limitations

- **Streaming.** Use `generateStructuredStream()`, not `chatStream()` with `output`.
- **Protocols.** Enforcement differs by protocol (see the table above). The client-side validator is the guarantee.
- **Reasoning models.** For a model that thinks first, pass `thinking: false` so the object is emitted directly. See [Reasoning](/guide/reasoning).
