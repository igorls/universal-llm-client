# universal-llm-client

[![npm version](https://img.shields.io/npm/v/universal-llm-client.svg)](https://www.npmjs.com/package/universal-llm-client) [![CI](https://github.com/igorls/universal-llm-client/actions/workflows/ci.yml/badge.svg)](https://github.com/igorls/universal-llm-client/actions/workflows/ci.yml) [![npm downloads](https://img.shields.io/npm/dm/universal-llm-client.svg)](https://www.npmjs.com/package/universal-llm-client) [![License: MIT](https://img.shields.io/npm/l/universal-llm-client.svg)](https://github.com/igorls/universal-llm-client/blob/main/LICENSE)

One TypeScript client for four LLM wire protocols: OpenAI Chat Completions, Anthropic Messages, Gemini and Ollama. A provider chain with retries, health tracking and failover is built in, and the same code handles streaming, tool calling, structured output and reasoning control on every protocol.

Compatibility is stated per wire protocol, not per provider or model. If an endpoint implements one of the four protocols, the matching provider `type` and a `url` connect to it.

## Install

```bash
bun add universal-llm-client
# or
npm install universal-llm-client
```

The core library has no runtime dependencies. Two optional peer dependencies enable specific features: `zod` (`^4`) for describing structured output with Zod schemas, and `@modelcontextprotocol/sdk` for MCP.

```bash
bun add zod                         # only for Zod schemas
bun add @modelcontextprotocol/sdk   # only for MCP
```

## Five-minute start

Connect to an endpoint, chat, and stream. This example uses an endpoint that serves OpenAI Chat Completions; [Protocols](docs/guide/protocols.md) shows the `type` for the other three.

```typescript
import { AIModel } from 'universal-llm-client';

const model = new AIModel({
  model: 'model-id',
  providers: [
    { type: 'openai', url: 'https://llm.example.com/v1', apiKey: process.env.LLM_API_KEY },
  ],
});

// One response
const response = await model.chat([
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is the capital of France?' },
]);
console.log(response.message.content);

// Or a stream of typed events
for await (const event of model.chatStream([
  { role: 'user', content: 'Write a haiku about code.' },
])) {
  if (event.type === 'text') process.stdout.write(event.content);
  else if (event.type === 'thinking') console.error('[thinking]', event.content);
}
```

## Failover

List more than one provider and the router moves down the list when one fails. The chain can mix protocols; each provider receives the request in its own wire format.

```typescript
const model = new AIModel({
  model: 'model-id',
  retries: 2,       // retries per provider before failing over
  timeout: 30000,   // request timeout in ms
  providers: [
    { type: 'openai', url: 'https://llm.example.com/v1', apiKey: process.env.LLM_API_KEY, priority: 0 },
    { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY, priority: 1 },
    { type: 'ollama', url: 'http://localhost:11434', model: 'local-model-id', priority: 2 },
  ],
});

model.getProviderStatus(); // health, load and latency per provider
```

A provider that keeps failing is skipped for a cooldown. Providers that share a `priority` form a pool that the router load-balances. A stream can fail over only before its first event. See [Failover](docs/guide/failover.md).

## Capabilities

### Streaming

`chatStream()` yields `text`, `thinking`, `progress`, `tool_call` and `tool_call_delta` events, and a decoder option controls how tags in the text are parsed. See [Streaming](docs/guide/streaming.md).

### Tool calling

Register a tool once; `chatWithTools()` runs the loop of model call, tool execution and result until the model is done.

```typescript
model.registerTool(
  'get_weather',
  'Get the current weather for a city',
  {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
  async (args) => {
    const { city } = args as { city: string };
    return { city, temperature: 22 };
  },
);

const response = await model.chatWithTools([
  { role: 'user', content: "What's the weather in Tokyo?" },
]);
console.log(response.toolExecutions); // the full trace of tool calls
```

See [Tools and MCP](docs/guide/tools.md).

### Structured output

Describe the shape, get a validated and typed value. Zod schemas are wrapped with `fromZod`; a plain JSON Schema with a validate function works without Zod.

```typescript
import { fromZod } from 'universal-llm-client/zod';
import { z } from 'zod';

const User = fromZod(z.object({ name: z.string(), age: z.number() }));

const user = await model.generateStructured(User, [
  { role: 'user', content: 'Generate a user profile for a software developer' },
]);
console.log(user.name, user.age); // typed

const result = await model.tryParseStructured(User, messages); // never throws on bad output
if (!result.ok) console.error(result.error.message, result.rawOutput);
```

`generateStructuredStream()` yields validated partial objects as the JSON arrives. See [Structured Output](docs/guide/structured-output.md).

### Reasoning

One `thinking` option, a boolean or a level (`'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`), is mapped to each protocol's native control. The reasoning comes back on `response.reasoning` and as `thinking` stream events.

```typescript
const res = await model.chat(messages, { thinking: 'high' });
console.log(res.message.content); // the answer
console.log(res.reasoning);       // the reasoning, when the model exposes it
```

See [Reasoning](docs/guide/reasoning.md).

### Observability

Every request, response, stream, retry, failover, tool call and validation is emitted to an `Auditor`. `ConsoleAuditor` and `BufferedAuditor` are included, and `usage` carries token counts and throughput.

```typescript
import { AIModel, ConsoleAuditor } from 'universal-llm-client';

const model = new AIModel({
  model: 'model-id',
  providers: [{ type: 'ollama' }],
  auditor: new ConsoleAuditor('[LLM]'),
});
```

See [Observability](docs/guide/observability.md).

### MCP

`MCPToolBridge` connects to MCP servers and registers their tools on a model. It needs `@modelcontextprotocol/sdk`.

```typescript
import { MCPToolBridge } from 'universal-llm-client';

const bridge = new MCPToolBridge({
  servers: {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', './'] },
    remote: { url: 'https://mcp.example.com/tools' },
  },
});

await bridge.connect();
await bridge.registerTools(model);
// model.chatWithTools() can now call the MCP tools
await bridge.disconnect();
```

See [Tools and MCP](docs/guide/tools.md#mcp).

### Embeddings

```typescript
const embedder = new AIModel({ model: 'model-id', providers: [{ type: 'ollama' }] });

const vector = await embedder.embed('Hello world');                      // number[]
const vectors = await embedder.embedArray(['Hello', 'World']);           // number[][]
```

The Anthropic Messages protocol has no embeddings endpoint. See [Embeddings and Vision](docs/guide/embeddings-vision.md).

### Vision

```typescript
import { multimodalMessage } from 'universal-llm-client';

const response = await model.chat([
  multimodalMessage('What do you see in this image?', ['https://example.com/photo.jpg']),
]);
```

See [Embeddings and Vision](docs/guide/embeddings-vision.md).

### Deep Research

On the Gemini protocol, `deepResearch()` runs an agentic research interaction and polls it to completion; `deepResearchStream()` yields its intermediate steps. It needs a `type: 'google'` provider.

```typescript
const result = await model.deepResearch('Research the history of tensor processors.', {
  tools: ['google_search', 'url_context'],
});
console.log(result.status, result.report);
```

See [Deep Research](docs/guide/deep-research.md).

## Protocol support

| | OpenAI Chat Completions | Anthropic Messages | Gemini | Ollama |
|---|---|---|---|---|
| Provider `type` | `openai`, `llamacpp` | `anthropic` | `google`, `vertex` | `ollama` |
| Chat | Yes | Yes | Yes | Yes |
| Streaming | Yes | Yes | Yes | Yes |
| Tool calling | Yes | Yes | Yes | Yes |
| Structured output | Yes, as `response_format` | Validated client-side; the schema is not sent | Yes, as `responseSchema` | Yes, as `format` |
| Vision | Yes | Yes | Yes | Yes |
| Embeddings | Yes | No | Yes | Yes |
| Native thinking | Through response fields or `<think>` tags | Yes, adaptive or extended thinking | Yes, `thinkingConfig` | Yes, `think` |

`type: 'llamacpp'` uses the same client as `type: 'openai'`, with a different default `url`. On a self-hosted server, image input depends on the server and the loaded model.

Endpoints that speak OpenAI Chat Completions are reached with `type: 'openai'` and a `url`, with options for the key header, query parameters and base path. See [Protocols](docs/guide/protocols.md).

## Runtime support

| Runtime | Version | Notes |
|---|---|---|
| Node.js | 22 or later | |
| Bun | 1.0 or later | |
| Deno | 2.0 or later | |
| Browsers | Modern, ESM | HTTP transport only. No stdio MCP servers |

## For agent framework authors

`AIModel` is meant to be the transport layer under an agent framework:

- **Stateless.** It stores no conversation history. Your framework owns memory.
- **Composable.** Create separate instances for chat, embeddings and vision.
- **Tool tracing.** `chatWithTools()` returns every tool call in `toolExecutions`, and `droppedToolCalls` lists calls whose arguments were cut off.
- **Context budgeting.** `getModelInfo()` reports `contextLength`, and `response.lastCallUsage` gives the real size of the last prompt in a tool loop.
- **Routing.** `sessionKey` keeps a conversation on one node of a pool, so a prompt cache is reused.
- **Auditor as a bus.** Plug in your own sink for cost tracking and tracing.
- **Decoders.** Pick a stream decoder per call, or register your own with `registerDecoder()`.

## Architecture

```
universal-llm-client
├── AIModel            Public API
├── Router             Failover, health, pools, structured output validation
├── BaseLLMClient      Shared client logic and the tool loop
├── Clients (src/providers/)
│   ├── OpenAICompatibleClient   OpenAI Chat Completions (openai, llamacpp)
│   ├── AnthropicClient          Anthropic Messages (anthropic)
│   ├── GoogleClient             Gemini (google, vertex)
│   └── OllamaClient             Ollama (ollama)
├── StreamDecoder      Pluggable stream decoding
├── Auditor            Observability interface
├── MCPToolBridge      MCP server integration
└── HTTP utilities     fetch-based transport
```

See [Architecture](docs/guide/architecture.md) and the [API reference](docs/api/reference.md).

## License

MIT
