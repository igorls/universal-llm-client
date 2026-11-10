# Tools and MCP

Register a tool once and it is offered to every provider in the chain, translated to each protocol's tool format.

## Registering tools

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
  async (args) => {
    const { city } = args as { city: string };
    return { city, temperature: 22 };
  },
);
```

The handler receives the parsed arguments as `unknown` and may return any value, sync or async. `registerTools([...])` registers several at once, each as `{ name, description, parameters, handler }`.

## Running the tool loop

`chatWithTools()` calls the model, runs the tools it asks for, sends the results back, and repeats until the model stops calling tools:

```typescript
const response = await model.chatWithTools(
  [{ role: 'user', content: "What's the weather in Tokyo?" }],
  { maxIterations: 5 },
);

console.log(response.message.content);
console.log(response.toolExecutions);
// [{ tool_call_id: '...', output: { city: 'Tokyo', temperature: 22 }, duration: 5 }]
```

- Tool calls from one model turn run in parallel.
- A result that is not a string is sent back as JSON.
- A tool that throws is reported to the model as an error message, so the model can correct the call. The error is also in `toolExecutions[].error`.
- `maxIterations` (default 10) bounds the rounds. When it is reached, one last request is made without tools.
- `response.toolExecutions` is the full trace of every call across all rounds.

`chat()` and `chatStream()` do not run tools. They return the model's tool calls (`message.tool_calls`, or `tool_call` events) for you to handle.

### Arguments from small models

Tool arguments are checked against the tool's `parameters` schema before the handler runs, and loosely typed values are coerced. A required string sent as `""` counts as missing unless its property declares `minLength: 0`, which lets a tool accept genuinely empty content. When a call's arguments do not parse, typically because the output limit cut the call off, the call is dropped and its name is listed in `response.droppedToolCalls` (OpenAI Chat Completions protocol).

## ToolBuilder

`ToolBuilder` builds the tool definition. It does not hold the handler:

```typescript
import { ToolBuilder } from 'universal-llm-client';

const fn = new ToolBuilder('search_docs')
  .description('Search documentation by query')
  .addParameter('query', 'string', 'Search query', true)
  .addParameter('limit', 'number', 'Max results', false)
  .buildFunction();

model.registerTool(fn.name, fn.description, fn.parameters, async (args) => {
  const { query, limit } = args as { query: string; limit?: number };
  return searchDocs(query, limit ?? 10);
});
```

| Method | Returns |
|---|---|
| `new ToolBuilder(name)` | A builder |
| `.description(text)` | The builder |
| `.addParameter(name, type, description, required?, extra?)` | The builder. `extra` is merged into the property's schema, for example `{ enum: [...] }` |
| `.build()` | An `LLMToolDefinition`: `{ type: 'function', function: { name, description, parameters } }`, the shape to pass in `ChatOptions.tools` |
| `.buildFunction()` | The `function` part only |

## ToolExecutor

Static wrappers that return a new handler:

```typescript
import { ToolExecutor } from 'universal-llm-client';

const handler = ToolExecutor.compose(
  rawHandler,
  (h) => ToolExecutor.withTimeout(h, 5000),
  (h) => ToolExecutor.safe(h),
  (h) => ToolExecutor.withValidation(h, ['query']),
);
```

| Wrapper | Effect |
|---|---|
| `withTimeout(handler, ms)` | Rejects if the handler takes longer than `ms` |
| `safe(handler)` | Returns `{ error: message }` instead of throwing |
| `withValidation(handler, fields)` | Throws if a required field is missing or null |
| `timed(handler)` | Returns `{ result, duration }` |
| `compose(handler, ...wrappers)` | Applies the wrappers around the handler; the last wrapper is innermost |

`createTimeTool()` and `createRandomNumberTool()` return ready-made `{ name, description, parameters, handler }` objects for `registerTools`.

## MCP

`MCPToolBridge` connects to Model Context Protocol servers and registers their tools on a model. `servers` is a record keyed by server name:

```typescript
import { AIModel, MCPToolBridge } from 'universal-llm-client';

const bridge = new MCPToolBridge({
  servers: {
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', './'],
    },
    remote: {
      url: 'https://mcp.example.com/tools',
      headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` },
    },
  },
});

await bridge.connect();
await bridge.registerTools(model);

const response = await model.chatWithTools([
  { role: 'user', content: 'List the files in the current directory' },
]);

await bridge.disconnect();
```

Each server entry is either a stdio server (`command`, `args`, `env`) or an HTTP server (`url`, `headers`). A tool is registered under the name `serverName:toolName`.

| Member | Purpose |
|---|---|
| `connect()` | Connects to every server and lists its tools. Throws on the first server that fails |
| `registerTools(model)` | Registers every discovered tool on an `AIModel`. Connects first if needed |
| `getTools()` | The discovered tools as `{ serverName, name, qualifiedName, description, inputSchema }`. These are descriptions for inspection, not callable handlers |
| `disconnect()` | Closes every connection |

`@modelcontextprotocol/sdk` is an optional peer dependency; install it to use the bridge. Stdio servers need a runtime that can spawn processes, so browsers can use HTTP servers only. Pass `auditor` in the config to record connection and tool-call events.
