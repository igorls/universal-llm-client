# Providers

Universal LLM Client supports multiple providers through a single API. Each provider has specific behaviors for structured output, streaming, and feature support.

## Provider Support Matrix

| Feature | OpenAI | Google/Vertex | Ollama | LlamaCpp |
|---------|:------:|:-------------:|:------:|:--------:|
| Chat | ✅ | ✅ | ✅ | ✅ |
| Streaming | ✅ | ✅ | ✅ | ✅ |
| Structured Output | ✅ | ✅ | ✅ | ✅ |
| Tool Calling | ✅ | ✅ | ✅ | ✅ |
| Vision/Images | ✅ | ✅ | ✅ | ❌ |
| Embeddings | ✅ | ✅ | ✅ | ✅ |
| Strict JSON Mode | ✅ | ❌ | ❌ | ❌ |

## OpenAI

Supports OpenAI and any OpenAI-compatible API (OpenRouter, Groq, Together AI, LM Studio, vLLM, etc.).

```typescript
const model = new AIModel({
  model: 'gpt-4o-mini',
  providers: [
    { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  ],
});
```

### Structured Output

OpenAI uses `response_format: { type: 'json_schema' }` natively. The library sends your Zod schema as a JSON Schema in the request, and OpenAI constrains its output accordingly.

**Strict mode** is enabled by default — OpenAI guarantees the response matches the schema exactly:

```typescript
// Strict mode (default)
const result = await model.generateStructured(MySchema, messages);

// Disable strict for compatible endpoints that don't support it
const result = await model.generateStructured(MySchema, messages, {
  output: { strict: false },
});
```

### Compatible Services

For OpenAI-compatible endpoints, just set the `url`:

```typescript
{ type: 'openai', url: 'https://openrouter.ai/api/v1', apiKey: '...' }
{ type: 'openai', url: 'http://localhost:1234/v1', apiKey: 'lm-studio' }
{ type: 'openai', url: 'http://localhost:8000/v1', apiKey: '...' } // vLLM
```

## Google / Vertex AI

Supports Google's Generative AI API and Vertex AI.

```typescript
// Google AI Studio
const model = new AIModel({
  model: 'gemini-2.0-flash',
  providers: [
    { type: 'google', apiKey: process.env.GOOGLE_API_KEY },
  ],
});

// Vertex AI
const model = new AIModel({
  model: 'gemini-2.0-flash',
  providers: [
    {
      type: 'vertex',
      apiKey: process.env.VERTEX_API_KEY,
      region: 'us-central1',
    },
  ],
});
```

### Structured Output

Google uses `responseMimeType: 'application/json'` with a `responseSchema`. The library automatically strips JSON Schema features that Google doesn't support:

- `pattern`
- `minLength` / `maxLength`
- `minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum`
- `additionalProperties`

::: info
Your Zod schema can use `.min()`, `.max()`, `.regex()`, etc. freely — the library strips unsupported features from the schema sent to Google while keeping them for validation of the response.
:::

## Ollama

Local LLM provider using Ollama's REST API.

```typescript
const model = new AIModel({
  model: 'llama3.2',
  providers: [
    { type: 'ollama', url: 'http://localhost:11434' },
  ],
});
```

### Structured Output

Ollama accepts a `format` parameter with the JSON Schema object directly. The library converts your Zod schema and sends it as the format:

```typescript
const result = await model.generateStructured(MySchema, [
  { role: 'user', content: 'Extract entities from...' },
]);
```

::: tip
For best results with structured output on Ollama, use models that support JSON mode well (e.g., `llama3.2`, `mistral`, `qwen2.5`).
:::

## LlamaCpp

Direct connection to a llama.cpp server.

```typescript
const model = new AIModel({
  model: 'default',
  providers: [
    { type: 'llamacpp', url: 'http://localhost:8080' },
  ],
});
```

Uses the OpenAI-compatible API format internally.

## Provider Failover

When using multiple providers, the library automatically fails over to the next provider on errors:

```typescript
const model = new AIModel({
  model: 'gpt-4o-mini',
  providers: [
    { type: 'openai', apiKey: process.env.OPENAI_API_KEY, priority: 0 },
    { type: 'google', apiKey: process.env.GOOGLE_API_KEY, priority: 1 },
    { type: 'ollama', url: 'http://localhost:11434', priority: 2 },
  ],
  retries: 2, // retries per provider before moving to next
});
```

### How failover works with structured output

1. The schema is sent in the provider's native format (JSON Schema for OpenAI, responseSchema for Google, format for Ollama)
2. If a provider fails, the next provider receives the same schema re-formatted for its API
3. Response validation is centralized in the Router — regardless of which provider responds, the same Zod validation runs

### Health Tracking

Each provider has health status with automatic cooldowns:

```typescript
const statuses = model.getProviderStatus();
// [
//   { id: 'openai-0', healthy: true, errorCount: 0 },
//   { id: 'google-1', healthy: false, errorCount: 3, coolingDown: true },
// ]
```
