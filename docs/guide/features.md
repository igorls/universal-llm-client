# Features

## Structured Output

Type-safe responses with automatic schema validation. See the [Structured Output guide](/guide/structured-output) for a comprehensive tutorial.

```typescript
import { z } from 'zod';

const UserSchema = z.object({
  name: z.string(),
  age: z.number(),
  interests: z.array(z.string()),
});

// Throws StructuredOutputError on validation failure
const user = await model.generateStructured(UserSchema, [
  { role: 'user', content: 'Generate a user profile' },
]);

// Non-throwing variant
const result = await model.tryParseStructured(UserSchema, messages);
if (result.ok) {
  console.log(result.value);
}

// Streaming with partial objects
for await (const partial of model.generateStructuredStream(UserSchema, messages)) {
  console.log(partial); // progressive object build-up
}
```

## Provider Failover

Configure multiple backends with priority-based failover. See the [Providers guide](/guide/providers) for details.

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

Features:
- **Priority ordering** — lower number = higher priority
- **Automatic retries** — configurable retries per provider
- **Health tracking** — unhealthy providers are temporarily skipped
- **Cooldown timers** — failed providers re-enter the pool after a cooldown period

## Streaming

First-class async generator streaming with pluggable decoder strategies:

```typescript
const stream = model.chatStream([
  { role: 'user', content: 'Write a poem about TypeScript' },
]);

for await (const event of stream) {
  if (event.type === 'text') {
    process.stdout.write(event.content);
  }
}
```

### Stream Events

| Event Type | Content |
|-----------|---------|
| `text` | Text token |
| `reasoning` | Reasoning/thinking token |
| `tool_call` | Tool call from the model |
| `tool_result` | Result of tool execution |

### Stream Decoders

Choose how to decode the stream:

```typescript
// Standard chat (default)
const stream = model.chatStream(messages, { decoder: 'standard' });

// Interleaved reasoning (for thinking models)
const stream = model.chatStream(messages, { decoder: 'interleaved-reasoning' });
```

## Tool Calling

Register tools that the LLM can call autonomously:

```typescript
model.registerTool(
  'get_weather',
  'Get the current weather for a city',
  {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
    },
    required: ['city'],
  },
  async ({ city }) => {
    const data = await fetchWeather(city);
    return JSON.stringify(data);
  },
);

// Multi-turn autonomous execution
const response = await model.chatWithTools(messages, {
  maxIterations: 5, // max tool-call rounds
});
```

### ToolBuilder API

Fluent API for building tool definitions:

```typescript
import { ToolBuilder } from 'universal-llm-client';

const tool = new ToolBuilder('search_docs')
  .description('Search documentation by query')
  .addParameter('query', 'string', 'Search query', true)
  .addParameter('limit', 'number', 'Max results', false)
  .handler(async ({ query, limit }) => {
    return JSON.stringify(await searchDocs(query, limit ?? 10));
  })
  .build();

model.registerTool(tool.name, tool.description, tool.parameters, tool.handler);
```

## MCP Integration

Bridge Model Context Protocol servers into LLM tools:

```typescript
import { MCPToolBridge } from 'universal-llm-client';

const bridge = new MCPToolBridge({
  servers: [
    { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
  ],
});

await bridge.connect();

// Register all MCP tools with the model
const tools = await bridge.getTools();
for (const tool of tools) {
  model.registerTool(tool.name, tool.description, tool.parameters, tool.handler);
}
```

## Multimodal

Send images alongside text:

```typescript
import { multimodalMessage, imageContent, textContent } from 'universal-llm-client';

const response = await model.chat([
  multimodalMessage('user', [
    textContent('What do you see in this image?'),
    imageContent('data:image/png;base64,iVBORw0KGgo...'),
  ]),
]);
```

Supported image formats:
- Base64 data URLs (`data:image/png;base64,...`)
- HTTP URLs (`https://example.com/image.png`)
- Raw base64 strings

## Embeddings

Generate vector embeddings:

```typescript
// Single text
const embedding = await model.embed('Hello, world!');
// number[]

// Multiple texts (batched)
const embeddings = await model.embedArray([
  'First document',
  'Second document',
]);
// number[][]
```

## Observability

Built-in auditing for logging, cost tracking, and analytics:

```typescript
import { ConsoleAuditor, BufferedAuditor } from 'universal-llm-client';

// Log all events to console
const model = new AIModel({
  ...config,
  auditor: new ConsoleAuditor(),
});

// Buffer events for batch processing
const auditor = new BufferedAuditor();
const model = new AIModel({ ...config, auditor });

// Flush events periodically
const events = await auditor.flush();
```

### Audit Event Types

| Event | When |
|-------|------|
| `request` | Before sending to provider |
| `response` | After receiving response |
| `error` | On provider error |
| `failover` | When switching to next provider |
| `structured_request` | Before structured output generation |
| `structured_response` | After successful structured output |
| `structured_validation_error` | When structured output validation fails |
| `tool_call` | When model calls a tool |
| `tool_result` | When tool returns a result |
