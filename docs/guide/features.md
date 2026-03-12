# Features

## Provider Failover

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

## Streaming

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

## Tool Calling

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

## Multimodal (Vision)

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

## Embeddings

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

## Observability

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

## MCP Integration

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

## Stream Decoders

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
