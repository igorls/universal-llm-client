# API Reference

The package exports from `universal-llm-client`. These sub-paths export a subset: `/interfaces`, `/tools`, `/auditor`, `/stream-decoder`, `/http`, `/structured-output` and `/zod`.

## AIModel

The main class.

```typescript
import { AIModel } from 'universal-llm-client';
```

### Constructor

```typescript
new AIModel(config: AIModelConfig)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | `string` | none | Model name, shared by every provider unless an entry sets its own |
| `providers` | `ProviderConfig[]` | none | Provider entries, in priority order |
| `retries` | `number` | `2` | Retries per provider before failing over |
| `timeout` | `number` | `30000` | Request timeout in ms |
| `spillAfterMs` | `number` | `750` | How long a request waits for a slot in a full pool before spilling to the next priority. Used only when entries set `maxConcurrent` |
| `thinking` | `boolean \| ThinkingLevel` | unset | Thinking for every request. Unset sends nothing |
| `contextLength` | `number` | unset | Context window requested from the server, for providers that take one (Ollama `num_ctx`) |
| `defaultParameters` | `Record<string, unknown>` | none | Default request parameters |
| `auditor` | `Auditor` | `NoopAuditor` | Observability sink |
| `debug` | `boolean` | `false` | Debug logging |

### Chat

#### `chat(messages, options?)`

```typescript
chat(messages: LLMChatMessage[], options?: ChatOptions): Promise<LLMChatResponse>
```

Sends a request with failover.

#### `chatWithTools(messages, options?)`

```typescript
chatWithTools(
  messages: LLMChatMessage[],
  options?: ChatOptions & { maxIterations?: number },
): Promise<LLMChatResponse>
```

Runs the tool loop. See [Tools and MCP](/guide/tools).

#### `chatStream(messages, options?)`

```typescript
chatStream(
  messages: LLMChatMessage[],
  options?: ChatOptions,
): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>
```

Yields typed events. Throws if `options.output` is set. See [Streaming](/guide/streaming).

### Structured output

All three take a `SchemaConfig<T>`. Build one from a Zod schema with `fromZod`.

```typescript
generateStructured<T>(config: SchemaConfig<T>, messages: LLMChatMessage[], options?: ChatOptions): Promise<T>

tryParseStructured<T>(config: SchemaConfig<T>, messages: LLMChatMessage[], options?: ChatOptions): Promise<StructuredOutputResult<T>>

generateStructuredStream<T>(config: SchemaConfig<T>, messages: LLMChatMessage[], options?: ChatOptions): AsyncGenerator<T, T, unknown>
```

`generateStructured` throws `StructuredOutputError` when the response does not parse or validate. `tryParseStructured` returns the failure instead. `generateStructuredStream` yields validated partial objects and returns the final one.

### Deep Research

```typescript
deepResearch(input: string, options?: DeepResearchOptions): Promise<DeepResearchResult>

deepResearchStream(
  input: string,
  options?: DeepResearchOptions,
): AsyncGenerator<DeepResearchEvent, DeepResearchResult, unknown>
```

`deepResearch` creates a background interaction and polls until it completes or `timeoutMs` passes. `deepResearchStream` yields events as the agent works and returns the final result. Both need a `type: 'google'` provider and throw otherwise. See [Deep Research](/guide/deep-research).

```typescript
interface DeepResearchOptions {
  agent?: string;                       // research agent id; the library supplies a default
  tools?: string[];                     // for example 'google_search', 'url_context', 'code_execution'
  thinkingSummaries?: 'auto' | 'none';  // default 'auto'
  previousInteractionId?: string;       // continue a prior interaction
  pollIntervalMs?: number;              // default 5000
  timeoutMs?: number;                   // default 600000
  signal?: AbortSignal;
}

interface DeepResearchResult {
  id: string;
  status: 'in_progress' | 'completed' | 'failed' | string;
  report?: string;
  steps?: DeepResearchStep[];
  error?: unknown;
  raw?: unknown;
}

type DeepResearchEvent =
  | { type: 'thought'; content: string }
  | { type: 'text'; content: string }
  | { type: 'image'; content: unknown }
  | { type: 'status'; status: string };
```

### Decisions

```typescript
decide<Questions>(
  state: DecisionState,
  questions: Questions,
  options?: DecideOptions,
): Promise<DecisionResult<Questions>>
```

Asks a decision model typed questions about a state. See [Decisions](/guide/decisions).

```typescript
type DecisionState = string | Record<string, unknown> | unknown[];

type DecisionQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

interface DecideOptions {
  images?: string[];                      // raw base64, shared by every question
  model?: string;                         // for this call
  timeout?: number;
  signal?: AbortSignal;
  sessionKey?: string;
  extraBody?: Record<string, unknown>;    // OpenAI-compatible protocol only
  fetch?: typeof fetch;                   // transport for this call
}

interface DecisionResult<Questions> {
  answers: DecisionAnswers<Questions>;    // noul: number; choice and score: the objects below
  model: string | null;                   // as the answering server named it
  url: string;                            // base URL of the endpoint that answered
  usage?: { inputTokens: number; details: Record<string, unknown> };
}

interface DecisionChoiceAnswer<Option> {
  type: 'choice';
  choice: Option;
  confidence: number;
  probabilities: Record<Option, number>;
}

interface DecisionScoreAnswer {
  type: 'score';
  score: number;                          // expected level index
  confidence: number;
  probabilities: number[];                // ordered by level
}
```

| Export | Description |
|--------|-------------|
| `DecisionContextLimitError` | Every provider that answered refused the request as too large. Extends `LLMHttpError` |
| `DecisionResponseError` | A response without a valid answer to every question. Extends `DecisionError` |
| `DecisionUnsupportedError` | The provider's protocol has no decision endpoint. Extends `DecisionError` |
| `parseDecisionResponse(questions, body, url, options?)` | Validates a `/v1/systemone` response body against the questions asked |
| `assertDecisionQuestions(questions)` | Throws when a request is outside the protocol's bounds |
| `isDecisionContextLimit(error)` | Whether an `LLMHttpError` is a refusal for context size |

### Other methods

| Method | Description |
|--------|-------------|
| `embed(text)` | Embedding for one text: `Promise<number[]>` |
| `embedArray(texts)` | Embeddings for several texts: `Promise<number[][]>` |
| `registerTool(name, description, parameters, handler)` | Register a tool |
| `registerTools(tools)` | Register several tools, each `{ name, description, parameters, handler }` |
| `getModels()` | Models available from the configured providers: `Promise<string[]>` |
| `getModelInfo()` | Metadata for the current model: `Promise<ModelMetadata>` |
| `setModel(name)` | Change the model name |
| `model` | The current model name (getter) |
| `getProviderStatus()` | Health and load per provider: `ProviderStatus[]` |
| `getPoolStatus()` | Load per priority tier: `PoolStatus[]` |
| `dispose()` | Flush the auditor |

---

## ProviderConfig

One entry in `providers`.

```typescript
interface ProviderConfig {
  type: 'openai' | 'llamacpp' | 'anthropic' | 'google' | 'vertex' | 'ollama';
  url?: string;                          // endpoint base URL; each type has a default
  apiKey?: string;
  model?: string;                        // overrides the shared model name for this entry
  priority?: number;                     // lower is tried first; default is the array index
  maxConcurrent?: number;                // in-flight cap for this entry; default no cap
  contextLength?: number;                // overrides AIModelConfig.contextLength
  defaultParameters?: Record<string, unknown>; // merged over the model-level block
  region?: string;                       // vertex only
  apiVersion?: 'v1' | 'v1beta';          // google, vertex; default 'v1beta'
  headers?: Record<string, string>;      // openai, llamacpp, ollama
  queryParams?: Record<string, string>;  // openai, llamacpp
  authHeader?: string;                   // openai, llamacpp, ollama
  authPrefix?: string;                   // openai, llamacpp, ollama
  apiBasePath?: string;                  // openai, llamacpp; '' disables the /v1 suffix
  omitResponseFormat?: boolean;          // openai, llamacpp; never send response_format
}
```

`type` selects the wire protocol; see [Protocols](/guide/protocols). Entries with the same `priority` form a pool; see [Failover](/guide/failover).

---

## ChatOptions

Per-call options for `chat`, `chatWithTools`, `chatStream` and the structured output methods.

```typescript
interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;                  // use this model name for this call only
  thinking?: boolean | ThinkingLevel;
  contextLength?: number;
  sessionKey?: string;             // routing affinity; never sent to the provider
  tools?: LLMToolDefinition[];     // default: the registered tools
  toolChoice?: 'none' | 'auto' | 'required';
  parameters?: Record<string, unknown>; // extra provider-specific parameters
  signal?: AbortSignal;
  executeTools?: boolean;
  maxIterations?: number;          // tool rounds; default 10
  enablePromptCaching?: boolean;   // Anthropic Messages
  decoder?: DecoderType | string | StreamDecoder;
  output?: OutputOptions;          // structured output
  responseFormat?: ResponseFormat; // raw response_format, without a schema
  serviceTier?: 'flex' | 'priority' | 'standard'; // Gemini
  conversationId?: string;         // used by the Responses client only

  // Deprecated. Use `output`, or the structured output methods.
  schema?: SchemaConfig<unknown>;
  jsonSchema?: JSONSchema;
  schemaName?: string;
  schemaDescription?: string;
}
```

`ThinkingLevel` is `'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`. For provider-specific settings that have no dedicated option, use `parameters`.

---

## OutputOptions

Structured output through `chat()`.

```typescript
interface OutputOptions<T = unknown> {
  schema?: SchemaConfig<T>;        // JSON Schema plus validator; see fromZod
  jsonSchema?: JSONSchema;         // JSON Schema without a validator
  name?: string;                   // hint for the model
  description?: string;            // hint for the model
  strict?: boolean;                // declared; the OpenAI Chat Completions client does not read it
}
```

The result is on `response.structured`. See [Structured Output](/guide/structured-output).

---

## SchemaConfig and fromZod

```typescript
interface SchemaConfig<T = unknown> {
  readonly jsonSchema: JSONSchema;
  readonly validate?: (data: unknown) => T;
  readonly name?: string;
  readonly description?: string;
}
```

`fromZod` builds a `SchemaConfig` from a Zod 4 schema. It lives in the `/zod` sub-path because Zod is an optional peer dependency:

```typescript
import { fromZod } from 'universal-llm-client/zod';

function fromZod<T>(
  schema: z.ZodType<T>,
  options?: { name?: string; description?: string },
): SchemaConfig<T>
```

---

## StructuredOutputError

Thrown when a response cannot be parsed or fails validation.

```typescript
class StructuredOutputError extends Error {
  readonly rawOutput: string;   // the text the model returned
  readonly cause?: Error;       // SyntaxError for bad JSON; the validator's error otherwise
}
```

## StructuredOutputResult\<T\>

```typescript
type StructuredOutputResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: StructuredOutputError; rawOutput: string };
```

`isStructuredOutputSuccess(result)` and `isStructuredOutputFailure(result)` narrow it.

## Schema utilities

Exported from the main package and from `/structured-output`:

| Export | Signature | Purpose |
|---|---|---|
| `parseStructured` | `(config, rawOutput) => T` | Parse text as JSON, unwrap a code fence if present, validate. Throws `StructuredOutputError` |
| `tryParseStructured` | `(config, rawOutput) => StructuredOutputResult<T>` | The non-throwing variant |
| `validateStructuredOutput` | `(config, data, rawOutput?) => T` | Validate already-parsed data |
| `stripJsonFences` | `(rawOutput) => string` | Extract the first fenced block |
| `getJsonSchemaFromConfig` | `(config) => JSONSchema` | The config's schema, cloned |
| `normalizeJsonSchema` | `(schema) => JSONSchema` | Deep clone |
| `stripUnsupportedFeatures` | `(schema, provider) => JSONSchema` | Remove keywords the Gemini format does not accept |
| `convertToProviderSchema` | `(provider, options) => ProviderSchema` | Schema, name and description for one protocol |
| `StreamingJsonParser` | `new StreamingJsonParser(config)` | Incremental parser. `feed(chunk)` returns `{ partial, complete }`; also `getBuffer()` and `reset()` |

`parseStructured` and `tryParseStructured` here take a `SchemaConfig` and the raw text. They are not the `AIModel` methods of the same name.

---

## Tools

```typescript
import { ToolBuilder, ToolExecutor, createTimeTool, createRandomNumberTool } from 'universal-llm-client';
```

### ToolBuilder

Builds a tool definition. It does not hold a handler.

```typescript
new ToolBuilder(name: string)
  .description(text: string): this
  .addParameter(name: string, type: string, description: string, required?: boolean, extra?: Record<string, unknown>): this
  .build(): LLMToolDefinition      // { type: 'function', function: { name, description, parameters } }
  .buildFunction(): LLMFunction    // the `function` part
```

```typescript
const fn = new ToolBuilder('search')
  .description('Search the web')
  .addParameter('query', 'string', 'Search query', true)
  .buildFunction();

model.registerTool(fn.name, fn.description, fn.parameters, handler);
```

### ToolExecutor

Static methods that wrap a `ToolHandler` (`(args: unknown) => unknown | Promise<unknown>`):

| Method | Effect |
|---|---|
| `withTimeout(handler, ms)` | Reject after `ms` |
| `safe(handler)` | Return `{ error }` instead of throwing |
| `withValidation(handler, requiredFields)` | Throw on a missing or null required field |
| `timed(handler)` | Return `{ result, duration }` |
| `compose(handler, ...wrappers)` | Apply wrappers; the last is innermost |

`createTimeTool()` and `createRandomNumberTool()` return `{ name, description, parameters, handler }` for `registerTools`.

### MCPToolBridge

```typescript
import { MCPToolBridge } from 'universal-llm-client';

new MCPToolBridge(config: MCPBridgeConfig)

interface MCPBridgeConfig {
  servers: Record<string, MCPServerConfig>;  // keyed by server name
  auditor?: Auditor;
}

interface MCPServerConfig {
  command?: string;                  // stdio
  args?: string[];                   // stdio
  env?: Record<string, string>;      // stdio
  url?: string;                      // HTTP
  headers?: Record<string, string>;  // HTTP
}
```

| Method | Description |
|---|---|
| `connect(): Promise<void>` | Connect to every server and discover tools. Throws on the first failure |
| `registerTools(model: AIModel): Promise<void>` | Register every discovered tool on the model, as `serverName:toolName`. Connects first if needed |
| `getTools(): ReadonlyArray<MCPTool>` | Discovered tools: `{ serverName, name, qualifiedName, description, inputSchema }` |
| `disconnect(): Promise<void>` | Close every connection |

Requires the optional peer dependency `@modelcontextprotocol/sdk`.

---

## Stream decoders

```typescript
import { createDecoder, registerDecoder, getRegisteredDecoders } from 'universal-llm-client';
```

### `createDecoder(type, callback, options?)`

```typescript
function createDecoder(
  type: DecoderType | string,
  callback: (event: DecodedEvent) => void,
  options?: { knownToolNames?: Set<string> },
): StreamDecoder
```

Looks up `type` in the registry and returns a decoder. Throws if it is not registered. Built-in types: `'passthrough'`, `'standard-chat'`, `'interleaved-reasoning'`.

```typescript
interface StreamDecoder {
  push(token: string): void;
  flush(): void;
  getCleanContent(): string;
  getReasoning(): string | undefined;
  pushReasoning?(content: string): void;
  pushToolCalls?(calls: LLMToolCall[]): void;
}

type DecodedEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'progress'; content: string }
  | { type: 'tool_call'; calls: LLMToolCall[] }
  | { type: 'tool_call_delta'; calls: LLMToolCall[] };
```

`registerDecoder(type, factory)` adds a custom decoder, usable as `decoder: type` in `ChatOptions`. `getRegisteredDecoders()` lists the names. See [Streaming](/guide/streaming).

---

## Auditor

```typescript
interface Auditor {
  record(event: AuditEvent): void;
  flush?(): Promise<void>;
}
```

| Class | Behaviour |
|-------|----------|
| `NoopAuditor` | Discards events. The default |
| `ConsoleAuditor(prefix?)` | Logs events to the console |
| `BufferedAuditor({ maxBufferSize?, onFlush? })` | Buffers events. `getEvents()`, `flush()`, `clear()` |

Event types are listed in [Observability](/guide/observability).

---

## Message helpers

```typescript
import {
  textContent,
  imageContent,
  multimodalMessage,
  extractTextContent,
  hasImages,
  audioContent,
  hasAudio,
} from 'universal-llm-client';
```

| Helper | Signature |
|---|---|
| `multimodalMessage` | `(text: string, images: string[], mimeType = 'image/jpeg') => LLMChatMessage` |
| `textContent` | `(text: string) => LLMTextContent` |
| `imageContent` | `(base64DataOrUrl: string, mimeType = 'image/jpeg', detail?: 'auto' \| 'low' \| 'high') => LLMImageContent` |
| `audioContent` | `(base64Data: string, mimeType: string) => LLMAudioContent` |
| `extractTextContent` | `(content: LLMMessageContent) => string` |
| `hasImages`, `hasAudio` | `(content: LLMMessageContent) => boolean` |

```typescript
// A user message with one text part and one image part
const message = multimodalMessage('Describe this image', ['https://example.com/photo.jpg']);

// Raw base64 data needs its type
const png = multimodalMessage('Describe this chart', [base64Png], 'image/png');
```

`multimodalMessage` always returns a message with `role: 'user'`. See [Embeddings and Vision](/guide/embeddings-vision).
