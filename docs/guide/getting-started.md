# Getting Started

## Installation

::: code-group

```sh [bun]
bun add universal-llm-client
```

```sh [npm]
npm install universal-llm-client
```

```sh [pnpm]
pnpm add universal-llm-client
```

:::

The core library has no runtime dependencies. Two optional peer dependencies enable specific features:

| Package | Needed for |
|---|---|
| `zod` (`^4.0.0`) | Describing structured output with Zod schemas, through `universal-llm-client/zod` |
| `@modelcontextprotocol/sdk` | `MCPToolBridge` |

Install Zod only if you use Zod schemas. A schema can also be written as plain JSON Schema with a validate function; see [Structured Output](/guide/structured-output).

```sh
bun add zod                         # for Zod schemas
bun add @modelcontextprotocol/sdk   # for MCP
```

## Quick Start

### Basic chat

Pick the provider `type` for the wire protocol your endpoint implements. This example uses an endpoint that serves OpenAI Chat Completions; see [Protocols](/guide/protocols) for the other three.

```typescript
import { AIModel } from 'universal-llm-client';

const model = new AIModel({
  model: 'model-id',
  providers: [
    { type: 'openai', url: 'https://llm.example.com/v1', apiKey: process.env.LLM_API_KEY },
  ],
});

const response = await model.chat([
  { role: 'user', content: 'Hello!' },
]);

console.log(response.message.content);
```

### Structured output

Describe the shape you want and get a validated, typed object back. With Zod, wrap the schema with `fromZod`:

```typescript
import { fromZod } from 'universal-llm-client/zod';
import { z } from 'zod';

const User = fromZod(
  z.object({
    name: z.string(),
    age: z.number(),
    email: z.string(),
  }),
);

const user = await model.generateStructured(User, [
  { role: 'user', content: 'Generate a user profile for Alice, age 30' },
]);

// user is typed: { name: string; age: number; email: string }
console.log(user.name, user.age);
```

### Failover

List more than one provider and the router moves down the list on failure. The chain can mix protocols:

```typescript
const model = new AIModel({
  model: 'model-id',
  retries: 2,
  providers: [
    { type: 'openai', url: 'https://llm.example.com/v1', apiKey: process.env.LLM_API_KEY, priority: 0 },
    { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY, priority: 1 },
    { type: 'ollama', url: 'http://localhost:11434', model: 'local-model-id', priority: 2 },
  ],
});
```

If the first provider fails, the request is retried there, then replayed on the next provider in its own wire format. A provider's `model` overrides the shared model name. See [Failover](/guide/failover).

## Requirements

| Runtime | Version |
|---------|---------|
| Node.js | 22 or later |
| Bun     | 1.0 or later |
| Deno    | 2.0 or later |
| Browser | Modern, ESM. HTTP transport only for MCP |

## Next Steps

- [Protocols](/guide/protocols): the four wire protocols and what each supports
- [Failover](/guide/failover): provider chains, retries, health and pools
- [Structured Output](/guide/structured-output): schemas, validation and streaming
- [Features](/guide/features): streaming, tools, reasoning, observability, embeddings, vision
- [API Reference](/api/reference): every method and type
