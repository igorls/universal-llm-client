# Providers

Universal LLM Client supports multiple providers through a single API. Each provider has specific behaviors for structured output, streaming, and feature support.

## Provider Support Matrix

| Feature              | OpenAI (compat) | Google/Vertex | Ollama   | Anthropic | LlamaCpp |
|----------------------|:---------------:|:-------------:|:--------:|:---------:|:--------:|
| Chat                 | ✅              | ✅            | ✅       | ✅        | ✅       |
| Streaming            | ✅              | ✅            | ✅       | ✅        | ✅       |
| Structured Output    | ✅              | ✅            | ✅       | ✅        | ✅       |
| Tool Calling         | ✅              | ✅            | ✅       | ✅        | ✅       |
| Vision/Images        | ✅              | ✅            | ✅       | ✅        | ❌       |
| Embeddings           | ✅              | ✅            | ✅       | ❌        | ✅       |
| Strict JSON Mode     | ✅ (native)     | ❌ (stripped) | ❌       | ✅ (recent) | ❌     |
| Prompt Caching       | Provider-dependent | Limited    | N/A      | ✅ (strong) | N/A     |
| Native Thinking      | Via decoder / fields | ✅ (thinkingConfig) | ✅ (`think`) | ✅ (extended + signatures) | Via decoder |

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

**Advanced transport flexibility** (new in this release):

You can now control auth, query parameters, and base path without custom code:

```typescript
// Azure OpenAI (recommended pattern)
{
  type: 'openai',
  url: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT',
  apiBasePath: '',                    // do not append /v1
  queryParams: { 'api-version': '2024-10-21' },
  headers: { 'api-key': process.env.AZURE_OPENAI_KEY },
  // No need to put the query in the url string anymore
}

// Custom gateway with api-key style auth (no "Bearer")
{
  type: 'openai',
  url: 'https://my-gateway.example.com',
  authHeader: 'api-key',
  authPrefix: '',
  apiKey: process.env.GATEWAY_KEY,
  queryParams: { 'region': 'us-east' },
}

// Extra arbitrary headers (merged after auth)
{
  type: 'openai',
  url: '...',
  headers: { 'x-custom': 'value', 'anthropic-beta': '...' }, // works for any provider
}
```

These options (`headers`, `queryParams`, `authHeader`, `authPrefix`, `apiBasePath`) are available on every `ProviderConfig`.

For Anthropic-specific prompt caching:

```typescript
await model.chat(messages, { enablePromptCaching: true, maxTokens: 8192 });
```

This causes the client to mark the system prompt with Anthropic's `cache_control: { type: "ephemeral" }`. See the Anthropic section above for details.

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

## Anthropic (Claude)

Native support for Anthropic's Messages API (distinct from OpenAI wire format).

```typescript
const model = new AIModel({
  model: 'claude-sonnet-4-20250514',
  providers: [
    { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  ],
});
```

### Key Differences Handled by the Library
- Content blocks (`text`, `tool_use`, `tool_result`, `thinking`, `image`) instead of flat messages.
- `system` is a top-level field (extracted from `role: 'system'` messages).
- Tool results are placed inside user messages as `tool_result` blocks.
- Streaming uses typed `content_block_*` events (including `thinking_delta` and `signature_delta`).
- Strong prompt caching and extended thinking support.

### Prompt Caching
```typescript
const response = await model.chat(messages, {
  enablePromptCaching: true,
  // ... other options
});
```
When enabled, the client emits appropriate `cache_control` markers for supported Claude models.

### Structured Output & Thinking
Recent Claude 4.x models have improving native schema enforcement. The library always performs final validation. Thinking / reasoning is surfaced via the standard `reasoning` field and `DecodedEvent` stream events.

### Embeddings
Anthropic does not offer embeddings — use a different provider in your failover chain if you need them.

## Most Other Providers: Use the OpenAI-Compatible Path

The vast majority of inference providers (hosted and self-hosted) speak the OpenAI Chat Completions format (or a close superset). **You do not need a dedicated adapter**.

Just use `{ type: 'openai', url: '...' }`:

```typescript
// xAI Grok
{ type: 'openai', url: 'https://api.x.ai/v1', apiKey: process.env.XAI_API_KEY }

// Mistral
{ type: 'openai', url: 'https://api.mistral.ai/v1', apiKey: process.env.MISTRAL_API_KEY }

// DeepSeek (very low cost)
{ type: 'openai', url: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY }

// Cohere Compatibility API
{ type: 'openai', url: 'https://api.cohere.ai/compatibility/v1', apiKey: process.env.COHERE_API_KEY } // verify exact path in Cohere docs

// Groq (fast)
{ type: 'openai', url: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY }

// Together AI
{ type: 'openai', url: 'https://api.together.xyz/v1', apiKey: process.env.TOGETHER_API_KEY }

// Fireworks
{ type: 'openai', url: 'https://api.fireworks.ai/inference/v1', apiKey: process.env.FIREWORKS_API_KEY }

// OpenRouter (aggregator)
{ type: 'openai', url: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY }

// Perplexity Sonar (grounded)
{ type: 'openai', url: 'https://api.perplexity.ai', apiKey: process.env.PERPLEXITY_API_KEY }

// Self-hosted vLLM / TGI / LM Studio / etc.
{ type: 'openai', url: 'http://localhost:8000/v1', apiKey: 'not-needed-for-local' }
```

### Notes for Compatible Endpoints
- Many do not implement OpenAI's full `strict` JSON schema mode → pass `output: { strict: false }` when using `generateStructured` / `chat({ output })`.
- Tool streaming and parallel calls are widely supported but accumulation logic can be quirky; the library normalizes IDs and empty args.
- Usage / cost headers vary; the auditor still receives normalized `TokenUsageInfo`.
- For Azure OpenAI: the URL structure (`/deployments/{deployment}/chat/completions?api-version=...`) and `api-key` header are different. You can often construct the full URL + pass custom headers (see advanced config) or request an `azure` provider type for first-class ergonomics.

See the research document `docs/research/provider-api-landscape-2026.md` for a detailed 2026 survey of wire formats, why only Anthropic + Google warrant native clients, Bedrock guidance, Responses API notes, and more.

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
