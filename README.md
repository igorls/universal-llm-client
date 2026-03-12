# universal-llm-client

A universal LLM client for JavaScript/TypeScript with **transparent provider failover**, streaming tool execution, pluggable reasoning strategies, and native observability.

```typescript
import { AIModel } from 'universal-llm-client';

const model = new AIModel({
    model: 'gemini-2.5-flash',
    providers: [
        { type: 'google', apiKey: process.env.GOOGLE_API_KEY },
        { type: 'openai', url: 'https://openrouter.ai/api', apiKey: process.env.OPENROUTER_KEY },
        { type: 'ollama' },
    ],
});

const response = await model.chat([
    { role: 'user', content: 'Hello!' },
]);
```

> **One model, multiple backends.** If Google fails, it transparently fails over to OpenRouter, then to local Ollama. Your code never knows the difference.

---

## Features

- 🔄 **Transparent Failover** — Priority-ordered provider chain with retries, health tracking, and cooldowns
- 🛠️ **Tool Calling** — Register tools once, works across all providers. Autonomous multi-turn execution loop
- 🌊 **Streaming** — First-class async generator streaming with pluggable decoder strategies
- 🧠 **Reasoning** — Native `<think>` tag parsing, interleaved reasoning, and model thinking support
- 🔍 **Observability** — Built-in auditor interface for logging, cost tracking, and behavioral analysis
- 🌐 **Universal Runtime** — Node.js 22+, Bun, Deno, and modern browsers
- 🤖 **MCP Native** — Bridge MCP servers to LLM tools with zero glue code
- 📊 **Embeddings** — Single and batch embedding generation

## Supported Providers

| Provider | Type | Notes |
|---|---|---|
| **Ollama** | `ollama` | Local or cloud models, NDJSON streaming, model pulling, vision/multimodal |
| **OpenAI** | `openai` | GPT-4o, o3, etc. Also works with OpenRouter, Groq, LM Studio, vLLM |
| **Google AI Studio** | `google` | Gemini models, system instructions, multimodal |
| **Vertex AI** | `vertex` | Same as Google AI but with regional endpoints and Bearer tokens |
| **LlamaCpp** | `llamacpp` | Local llama.cpp / llama-server instances |

---

## Installation

```bash
bun add universal-llm-client
# or
npm install universal-llm-client
```

**Optional**: For MCP integration:
```bash
bun add @modelcontextprotocol/sdk
```

---

## Quick Start

### Basic Chat

```typescript
import { AIModel } from 'universal-llm-client';

const model = new AIModel({
    model: 'qwen3:4b',
    providers: [{ type: 'ollama' }],
});

const response = await model.chat([
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is the capital of France?' },
]);

console.log(response.message.content);
// "The capital of France is Paris."
```

### Streaming

```typescript
for await (const event of model.chatStream([
    { role: 'user', content: 'Write a haiku about code.' },
])) {
    if (event.type === 'text') {
        process.stdout.write(event.content);
    } else if (event.type === 'thinking') {
        // Model reasoning (when supported)
        console.log('[thinking]', event.content);
    }
}
```

### Tool Calling

```typescript
model.registerTool(
    'get_weather',
    'Get current weather for a location',
    {
        type: 'object',
        properties: {
            city: { type: 'string', description: 'City name' },
        },
        required: ['city'],
    },
    async (args) => {
        const { city } = args as { city: string };
        return { temperature: 22, condition: 'sunny', city };
    },
);

// Autonomous tool execution — the model calls tools and loops until done
const response = await model.chatWithTools([
    { role: 'user', content: "What's the weather in Tokyo?" },
]);

console.log(response.message.content);
// "The weather in Tokyo is 22°C and sunny."
console.log(response.toolTrace);
// [{ name: 'get_weather', args: { city: 'Tokyo' }, result: {...}, duration: 5 }]
```

### Provider Failover

```typescript
const model = new AIModel({
    model: 'gemini-2.5-flash',
    retries: 2,        // retries per provider before failover
    timeout: 30000,    // request timeout in ms
    providers: [
        { type: 'google', apiKey: process.env.GOOGLE_KEY, priority: 0 },
        { type: 'openai', url: 'https://openrouter.ai/api', apiKey: process.env.OPENROUTER_KEY, priority: 1 },
        { type: 'ollama', url: 'http://localhost:11434', priority: 2 },
    ],
});

// If Google returns 500, retries twice, then seamlessly tries OpenRouter.
// If OpenRouter also fails, falls back to local Ollama.
// Your code sees a single response.
const response = await model.chat([{ role: 'user', content: 'Hello' }]);

// Check provider health at any time
console.log(model.getProviderStatus());
// [{ id: 'google-0', healthy: true }, { id: 'openai-1', healthy: true }, ...]
```

### Multimodal (Vision)

```typescript
import { AIModel, multimodalMessage } from 'universal-llm-client';

const model = new AIModel({
    model: 'gemini-2.5-flash',
    providers: [{ type: 'google', apiKey: process.env.GOOGLE_KEY }],
});

const response = await model.chat([
    multimodalMessage('What do you see in this image?', [
        'https://example.com/photo.jpg',
    ]),
]);
```

### Embeddings

```typescript
const embedModel = new AIModel({
    model: 'nomic-embed-text-v2-moe:latest',
    providers: [{ type: 'ollama' }],
});

const vector = await embedModel.embed('Hello world');
// [0.006, 0.026, -0.009, ...]

const vectors = await embedModel.embedArray(['Hello', 'World']);
// [[0.006, ...], [0.012, ...]]
```

### Observability

```typescript
import { AIModel, ConsoleAuditor, BufferedAuditor } from 'universal-llm-client';

// Simple console logging
const model = new AIModel({
    model: 'qwen3:4b',
    providers: [{ type: 'ollama' }],
    auditor: new ConsoleAuditor('[LLM]'),
});
// [LLM] REQUEST [ollama] (qwen3:4b) →
// [LLM] RESPONSE [ollama] (qwen3:4b) 1200ms 68 tokens

// Buffered for custom sinks (OpenTelemetry, DB, etc.)
const auditor = new BufferedAuditor({
    maxBufferSize: 100,
    onFlush: async (events) => {
        await sendToOpenTelemetry(events);
    },
});
```

### MCP Integration

```typescript
import { AIModel, MCPToolBridge } from 'universal-llm-client';

const model = new AIModel({
    model: 'qwen3:4b',
    providers: [{ type: 'ollama' }],
});

const mcp = new MCPToolBridge({
    servers: {
        filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', './'],
        },
        weather: {
            url: 'https://mcp.example.com/weather',
        },
    },
});

await mcp.connect();
await mcp.registerTools(model);

// MCP tools are now callable via chatWithTools
const response = await model.chatWithTools([
    { role: 'user', content: 'List files in the current directory' },
]);

await mcp.disconnect();
```

### Stream Decoders

```typescript
import { AIModel, createDecoder } from 'universal-llm-client';

// Passthrough — raw text, no parsing
// Standard Chat — text + native reasoning + tool calls
// Interleaved Reasoning — parses <think> and <progress> tags from text streams

const decoder = createDecoder('interleaved-reasoning', (event) => {
    switch (event.type) {
        case 'text': console.log(event.content); break;
        case 'thinking': console.log('[think]', event.content); break;
        case 'progress': console.log('[progress]', event.content); break;
        case 'tool_call': console.log('[tool]', event.calls); break;
    }
});

decoder.push('<think>Let me analyze this</think>The answer is 42');
decoder.flush();

console.log(decoder.getCleanContent());  // "The answer is 42"
console.log(decoder.getReasoning());      // "Let me analyze this"
```

---

## API Reference

### `AIModel`

The universal client. One class, multiple backends.

```typescript
new AIModel(config: AIModelConfig)
```

**Config:**

| Property | Type | Default | Description |
|---|---|---|---|
| `model` | `string` | — | Model name (e.g., `'gemini-2.5-flash'`) |
| `providers` | `ProviderConfig[]` | — | Ordered list of provider backends |
| `retries` | `number` | `2` | Retries per provider before failover |
| `timeout` | `number` | `30000` | Request timeout in ms |
| `auditor` | `Auditor` | `NoopAuditor` | Observability sink |
| `thinking` | `boolean` | `false` | Enable model thinking/reasoning |
| `debug` | `boolean` | `false` | Debug logging |
| `defaultParameters` | `object` | — | Default parameters for all requests |

**Provider Config:**

| Property | Type | Description |
|---|---|---|
| `type` | `string` | `'ollama'`, `'openai'`, `'google'`, `'vertex'`, `'llamacpp'` |
| `url` | `string` | Provider URL (has sensible defaults) |
| `apiKey` | `string` | API key or Bearer token |
| `priority` | `number` | Lower = tried first (defaults to array index) |
| `model` | `string` | Override model name for this provider |
| `region` | `string` | Vertex AI region (e.g., `'us-central1'`) |
| `apiVersion` | `string` | API version (e.g., `'v1beta'`) |

**Methods:**

| Method | Returns | Description |
|---|---|---|
| `chat(messages, options?)` | `Promise<LLMChatResponse>` | Send chat request |
| `chatWithTools(messages, options?)` | `Promise<LLMChatResponse>` | Chat with autonomous tool execution |
| `chatStream(messages, options?)` | `AsyncGenerator<DecodedEvent>` | Stream chat response |
| `embed(text)` | `Promise<number[]>` | Generate single embedding |
| `embedArray(texts)` | `Promise<number[][]>` | Generate batch embeddings |
| `registerTool(name, desc, params, handler)` | `void` | Register a callable tool |
| `registerTools(tools)` | `void` | Register multiple tools |
| `getModels()` | `Promise<string[]>` | List available models |
| `getModelInfo()` | `Promise<ModelMetadata>` | Get model metadata |
| `getProviderStatus()` | `ProviderStatus[]` | Check provider health |
| `setModel(name)` | `void` | Switch model at runtime |
| `dispose()` | `Promise<void>` | Clean shutdown |

### `ToolBuilder` / `ToolExecutor`

```typescript
import { ToolBuilder, ToolExecutor } from 'universal-llm-client';

// Fluent builder
const tool = new ToolBuilder('search')
    .description('Search the web')
    .addParameter('query', 'string', 'Search query', true)
    .addParameter('limit', 'number', 'Max results', false)
    .build();

// Execution wrappers
const safeHandler = ToolExecutor.compose(
    myHandler,
    h => ToolExecutor.withTimeout(h, 5000),
    h => ToolExecutor.safe(h),
    h => ToolExecutor.withValidation(h, ['query']),
);
```

### Auditor Interface

Implement custom observability by providing an `Auditor`:

```typescript
interface Auditor {
    record(event: AuditEvent): void;
    flush?(): Promise<void>;
}
```

**Built-in implementations:**
- `NoopAuditor` — Zero overhead (default)
- `ConsoleAuditor` — Structured console logging
- `BufferedAuditor` — Collects events for custom sinks

---

## Architecture

```
universal-llm-client
├── AIModel          ← Public API (the only class you import)
├── Router           ← Internal failover engine
├── BaseLLMClient    ← Abstract client with tool execution
├── Providers
│   ├── OllamaClient
│   ├── OpenAICompatibleClient  (OpenAI, OpenRouter, Groq, LM Studio, vLLM, LlamaCpp)
│   └── GoogleClient            (AI Studio + Vertex AI)
├── StreamDecoder    ← Pluggable reasoning strategies
├── Auditor          ← Observability interface
├── MCPToolBridge    ← MCP server integration
└── HTTP Utilities   ← Universal fetch-based transport
```

### Design Principles

1. **Single import** — `AIModel` is the only class users need
2. **Provider agnostic** — Same code works with any backend
3. **Transparent failover** — Health tracking and cooldowns happen behind the scenes
4. **Zero dependencies** — Core library depends only on native `fetch`
5. **Agent-ready** — Stateless, composable instances designed as foundation for agent frameworks
6. **Observable** — Every request, response, tool call, retry, and failover is auditable

---

## Runtime Support

| Runtime | Version | Status |
|---|---|---|
| **Node.js** | 22+ | ✅ Full support |
| **Bun** | 1.0+ | ✅ Full support |
| **Deno** | 2.0+ | ✅ Full support |
| **Browsers** | Modern | ✅ No stdio MCP, HTTP transport only |

---

## For Agent Framework Authors

`AIModel` is designed as the transport layer for agentic systems:

- **Stateless** — No conversation history stored. Your framework manages memory
- **Composable** — Create separate instances for chat, embeddings, vision
- **Tool tracing** — `chatWithTools()` returns full execution trace
- **Context budget** — `getModelInfo()` exposes `contextLength`
- **Auditor as system bus** — Inject custom sinks for cost tracking, behavioral scoring
- **StreamDecoder as UI bridge** — Select decoder strategy per-call

---

## License

MIT
