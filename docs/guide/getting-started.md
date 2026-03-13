# Getting Started

## Installation

::: code-group

```sh [bun]
bun add universal-llm-client zod
```

```sh [npm]
npm install universal-llm-client zod
```

```sh [pnpm]
pnpm add universal-llm-client zod
```

:::

> **Zod 4 is required.** `universal-llm-client` v4 uses Zod 4's native `z.toJSONSchema()` for schema conversion. Make sure you're on `zod@^4.0.0`.

## Quick Start

### Basic Chat

```typescript
import { AIModel } from 'universal-llm-client';

const model = new AIModel({
  model: 'gpt-4o-mini',
  providers: [
    { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  ],
});

const response = await model.chat([
  { role: 'user', content: 'Hello!' },
]);

console.log(response.message.content);
```

### Structured Output

Get type-safe, validated responses with Zod schemas:

```typescript
import { AIModel } from 'universal-llm-client';
import { z } from 'zod';

const model = new AIModel({
  model: 'gpt-4o-mini',
  providers: [
    { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  ],
});

const UserSchema = z.object({
  name: z.string(),
  age: z.number(),
  email: z.string(),
});

const user = await model.generateStructured(UserSchema, [
  { role: 'user', content: 'Generate a user profile for Alice, age 30' },
]);

// user is fully typed: { name: string, age: number, email: string }
console.log(user.name);  // "Alice"
console.log(user.age);   // 30
```

### Provider Failover

Configure multiple providers for automatic failover:

```typescript
const model = new AIModel({
  model: 'gpt-4o-mini',
  providers: [
    { type: 'openai', apiKey: process.env.OPENAI_API_KEY, priority: 0 },
    { type: 'google', apiKey: process.env.GOOGLE_API_KEY, priority: 1 },
    { type: 'ollama', url: 'http://localhost:11434', priority: 2 },
  ],
  retries: 2,
});
```

If OpenAI fails, the request automatically retries on Google, then Ollama.

## Requirements

| Runtime | Version |
|---------|---------|
| Node.js | ≥ 22.0 |
| Bun     | ≥ 1.0  |
| Deno    | ≥ 2.0  |
| Browser | Modern (ESM) |

## Next Steps

- [**Structured Output**](/guide/structured-output) — Deep dive into type-safe responses, streaming, and error handling
- [**Providers**](/guide/providers) — Provider-specific configuration and behaviors
- [**Features**](/guide/features) — Streaming, tool calling, multimodal, and more
- [**API Reference**](/api/reference) — Complete method and type reference
