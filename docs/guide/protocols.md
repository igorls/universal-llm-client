# Protocols

`AIModel` speaks four wire protocols. A provider entry's `type` selects the protocol, and `url` points it at any endpoint that implements that protocol. Compatibility is stated per protocol, never per provider or model: if an endpoint implements the protocol, the matching `type` talks to it.

| Protocol | Provider `type` | Default `url` |
|---|---|---|
| OpenAI Chat Completions | `openai`, `llamacpp` | `openai`: the type's hosted API base. `llamacpp`: `http://localhost:8080` |
| Anthropic Messages | `anthropic` | The type's hosted API base |
| Gemini | `google`, `vertex` | Built by the client (Vertex uses `region`) |
| Ollama | `ollama` | `http://localhost:11434` |

## Support by protocol

| | OpenAI Chat Completions | Anthropic Messages | Gemini | Ollama |
|---|---|---|---|---|
| Chat | Yes | Yes | Yes | Yes |
| Streaming | Yes | Yes | Yes | Yes |
| Tool calling | Yes | Yes | Yes | Yes |
| Structured output | Yes, sent as `response_format` | Validated client-side; the schema is not sent | Yes, sent as `responseSchema` | Yes, sent as `format` |
| Vision | Yes | Yes | Yes | Yes |
| Embeddings | Yes | No | Yes | Yes |
| Native thinking | Through response fields or `<think>` tags | Yes, adaptive or extended thinking | Yes, `thinkingConfig` | Yes, `think` |

A row says what the library's client for that protocol implements. Whether a particular server honours a request field depends on the server; the sections below name the fields the client sends.

## Choosing a `type`

Pick by the wire protocol the endpoint exposes:

- It serves `POST /v1/chat/completions` (hosted gateways, aggregators, local inference servers): use `openai` with a `url`.
- It is a local llama.cpp server: use `llamacpp`, or `openai`. Both use the same client.
- It serves the Anthropic Messages API (`/v1/messages`): use `anthropic`.
- It serves the Gemini API, or Vertex AI: use `google` or `vertex`.
- It is an Ollama daemon: use `ollama`.

An endpoint with its own wire format that is not on this list needs a gateway in front of it that speaks one of the four.

## OpenAI Chat Completions

`type: 'openai'` (and `type: 'llamacpp'`, which defaults to `http://localhost:8080`) uses one client, `OpenAICompatibleClient`. Connect any endpoint that implements Chat Completions by setting `url`:

```typescript
import { AIModel } from 'universal-llm-client';

const model = new AIModel({
  model: 'model-id',
  providers: [
    { type: 'openai', url: 'https://llm.example.com/v1', apiKey: process.env.LLM_API_KEY },
  ],
});
```

The client appends `/v1` to `url` unless the URL already ends with it. Set `apiBasePath` to change or disable that (below).

### Transport options

Some endpoints expect the key in a different header, a query parameter on every request, or a path that does not use `/v1`. These options cover those cases without custom code:

| Option | Effect |
|---|---|
| `headers` | Extra headers merged into every request, after the auth header |
| `queryParams` | Query parameters appended to every endpoint URL |
| `authHeader` | Header that carries the key. Default `Authorization` |
| `authPrefix` | Text placed before the key. Default `Bearer ` for `Authorization`, empty otherwise |
| `apiBasePath` | Path appended after `url`. Default `/v1`. Use `''` when `url` already holds the full path |

```typescript
// A gateway that takes the key in an `api-key` header, needs a version
// query parameter, and serves the API at a deployment-specific path.
{
  type: 'openai',
  url: 'https://gateway.example.com/openai/deployments/my-deployment',
  apiBasePath: '',
  queryParams: { 'api-version': '2024-10-21' },
  authHeader: 'api-key',
  authPrefix: '',
  apiKey: process.env.GATEWAY_KEY,
}

// Extra headers, merged after the auth header.
{
  type: 'openai',
  url: 'https://gateway.example.com',
  apiKey: process.env.GATEWAY_KEY,
  headers: { 'x-team': 'research' },
}
```

Which protocols read which option:

| Option | OpenAI Chat Completions | Ollama | Anthropic | Gemini |
|---|---|---|---|---|
| `headers` | Yes | Yes | No | No |
| `authHeader`, `authPrefix` | Yes | Yes | No | No |
| `queryParams` | Yes | No | No | No |
| `apiBasePath` | Yes | No | No | No |

The Anthropic and Gemini clients build their own URLs and auth headers and ignore these options.

### Structured output

The schema is sent as `response_format: { type: 'json_schema' }` with `strict: true`. Pass `output: { strict: false }` for an endpoint that rejects strict mode:

```typescript
const result = await model.generateStructured(config, messages, {
  output: { strict: false },
});
```

For an endpoint that rejects `response_format` altogether, set `omitResponseFormat: true` on the provider entry. Structured output then relies on the prompt, and the response is still validated client-side.

### Behaviour to know about

- Tool calls with empty arguments are normalised to `{}`, and a missing tool call id is generated.
- A streamed tool call is reported once, complete, as a `tool_call` event. Argument fragments arrive earlier as `tool_call_delta` events for display only. See [Streaming](/guide/streaming).
- Reasoning is read from the `reasoning_content` or `reasoning` response field, or from inline `<think>` tags. See [Reasoning](/guide/reasoning) for the request fields.

## Anthropic Messages

```typescript
const model = new AIModel({
  model: 'model-id',
  providers: [
    { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY },
  ],
});
```

The client translates the library's message format to the Messages API:

- Content is sent as typed blocks (`text`, `image`, `tool_use`, `tool_result`, `thinking`).
- `system` is a top-level field, built from the `role: 'system'` messages.
- Tool results are placed in user messages as `tool_result` blocks.
- Streaming reads the typed `content_block_*` events, including `thinking_delta` and `signature_delta`.
- `maxTokens` defaults to 4096 when you do not set it.
- `toolChoice: 'none'` is sent as `auto`, because the API has no `none`.
- If a model answers that `temperature` is deprecated for it, the client sends the request again without it, warns once, and leaves it out of later requests to that model.

### Structured output

The client does not send a schema on this protocol. `generateStructured` and `chat({ output })` still parse and validate the response with your validator, so ask for the format in the prompt and handle `StructuredOutputError`.

### Thinking

When you set `thinking`, the client reads the model's card from `GET /v1/models/{id}`, once per model, and sends the shape the card lists:

- **Adaptive thinking**, where the model takes it. The level is sent as `output_config.effort`, and the reasoning comes back as a summary.
- **Extended thinking** otherwise, or when the server has no model card, with a `budget_tokens` derived from the level.

In both shapes the client omits `temperature` and raises `max_tokens` so there is room for the answer. `thinking: false` sends the off switch the card lists.

In a tool loop, the signed thinking blocks that came before a tool call go back with the next request, so the model keeps its reasoning between calls. See [Reasoning](/guide/reasoning#anthropic-and-the-model-card).

### Prompt caching

```typescript
const response = await model.chat(messages, { enablePromptCaching: true });
```

When enabled, the client marks the system prompt with `cache_control: { type: 'ephemeral' }`, marks the last two assistant messages, and sets the top-level `cache_control` so the API advances it over the growing conversation. Together these use at most four cache slots. Passing `false` or omitting the option sends no markers. See the Anthropic prompt caching documentation for lifetimes and minimum prompt sizes.

`usage.inputTokens` includes uncached input, cache reads and cache writes. `usage.cachedTokens` reports reads and `usage.cacheWriteTokens` reports writes; both are already counted in `inputTokens`. A counter the API did not report stays absent. Streaming counters are cumulative snapshots.

### Embeddings

This protocol has no embeddings endpoint. `embed()` on an `anthropic` provider throws. Use a separate `AIModel` for embeddings.

## Gemini

```typescript
// Gemini API
const model = new AIModel({
  model: 'model-id',
  providers: [
    { type: 'google', apiKey: process.env.GOOGLE_API_KEY },
  ],
});

// Vertex AI
const vertex = new AIModel({
  model: 'model-id',
  providers: [
    { type: 'vertex', apiKey: process.env.VERTEX_API_KEY, region: 'us-central1' },
  ],
});
```

`apiVersion` selects `'v1'` or `'v1beta'` (default `'v1beta'`). `region` applies to `vertex` only (default `us-central1`).

### Structured output

The schema is sent as `responseMimeType: 'application/json'` with a `responseSchema`. The Gemini schema format supports a subset of JSON Schema, so the client removes these keywords from the schema it sends:

- `pattern`
- `minLength`, `maxLength`
- `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
- `additionalProperties`

Your validator still runs on the response, so a Zod schema can keep `.min()`, `.max()` and `.regex()`.

### Thinking

`thinking` maps to `thinkingConfig`, with `includeThoughts` on so the reasoning text comes back. The client chooses `thinkingLevel` or `thinkingBudget` with a rule on the model id (see `buildGenerationConfig` in `src/providers/google.ts`). A `thinkingConfig` you pass in `parameters` is left untouched. See [Reasoning](/guide/reasoning).

### Service tier

`serviceTier: 'flex' | 'priority' | 'standard'` on `ChatOptions` selects the inference tier. `response.serviceTier` reports the tier that served the request when the response says so.

### Deep Research

The agentic Deep Research interaction uses this protocol's `interactions` endpoint and needs a `type: 'google'` provider. See [Deep Research](/guide/deep-research).

## Ollama

```typescript
const model = new AIModel({
  model: 'model-id',
  providers: [
    { type: 'ollama', url: 'http://localhost:11434' },
  ],
});
```

The client uses the native `/api/chat` endpoint and reads newline-delimited JSON when streaming.

- **Structured output** is sent as `format` with the JSON Schema.
- **Thinking** is sent as `think`: `true`, `false`, or `low`, `medium`, `high`, `max`. With `thinking` unset, `think` is left out and the server applies the model's default. When thinking is requested, the client checks `/api/show` for the model's `thinking` capability and leaves `think` out for a model that lacks it.
- **Context window**: `contextLength` is sent as `num_ctx`. Without it the server uses its own default, which may truncate long prompts.
- **Images** are sent in the message's `images` field.
- **Embeddings** support single and batch input (`embed`, `embedArray`).
- `headers`, `authHeader` and `authPrefix` apply, for a daemon behind an authenticating proxy.

## Failover across protocols

One `AIModel` can mix protocols in a single provider chain. A request that fails on one provider is replayed on the next, translated to that provider's wire format. Structured output validation runs once, in the router, so the same validator applies whichever provider answered. See [Failover](/guide/failover).
