# API Reference

## AIModel

The main class — the only import most users need.

```typescript
import { AIModel } from 'universal-llm-client';
```

### Constructor

```typescript
new AIModel(config: AIModelConfig)
```

| Config Option | Type | Default | Description |
|---------------|------|---------|-------------|
| `model` | `string` | — | Model name (e.g., `'gpt-4o-mini'`) |
| `providers` | `ProviderConfig[]` | — | Array of provider configurations |
| `retries` | `number` | `2` | Retries per provider before failover |
| `timeout` | `number` | `30000` | Request timeout in ms |
| `debug` | `boolean` | `false` | Enable debug logging |
| `auditor` | `Auditor` | `NoopAuditor` | Observability interface |
| `thinking` | `boolean` | `false` | Enable thinking/reasoning mode |
| `defaultParameters` | `object` | — | Default params sent with every request |

### Chat Methods

#### `chat(messages, options?)`

Send a chat request with automatic provider failover.

```typescript
async chat(messages: LLMChatMessage[], options?: ChatOptions): Promise<LLMChatResponse>
```

#### `chatWithTools(messages, options?)`

Chat with autonomous multi-turn tool execution.

```typescript
async chatWithTools(
  messages: LLMChatMessage[],
  options?: ChatOptions & { maxIterations?: number }
): Promise<LLMChatResponse>
```

#### `chatStream(messages, options?)`

Stream chat response with pluggable decoder.

```typescript
async *chatStream(
  messages: LLMChatMessage[],
  options?: ChatOptions
): AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>
```

### Structured Output Methods

#### `generateStructured(schema, messages, options?)`

Generate validated structured output. Throws `StructuredOutputError` on failure.

```typescript
async generateStructured<T>(
  schema: z.ZodType<T>,
  messages: LLMChatMessage[],
  options?: ChatOptions
): Promise<T>
```

#### `tryParseStructured(schema, messages, options?)`

Non-throwing variant. Returns a discriminated union result.

```typescript
async tryParseStructured<T>(
  schema: z.ZodType<T>,
  messages: LLMChatMessage[],
  options?: ChatOptions
): Promise<StructuredOutputResult<T>>
```

#### `generateStructuredStream(schema, messages, options?)`

Stream partial validated objects as JSON generates.

```typescript
async *generateStructuredStream<T>(
  schema: z.ZodType<T>,
  messages: LLMChatMessage[],
  options?: ChatOptions
): AsyncGenerator<T, T, unknown>
```

### Other Methods

| Method | Description |
|--------|-------------|
| `embed(text)` | Generate embedding for a single text |
| `embedArray(texts)` | Generate embeddings for multiple texts |
| `registerTool(name, description, parameters, handler)` | Register a callable tool |
| `registerTools(tools[])` | Register multiple tools |
| `getModels()` | Get available models from all providers |
| `getModelInfo()` | Get metadata about the current model |
| `setModel(name)` | Switch model at runtime |
| `getProviderStatus()` | Get health status of all providers |
| `dispose()` | Clean shutdown |

---

## ChatOptions

Options passed to chat and structured output methods.

```typescript
interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  tools?: LLMToolDefinition[];
  output?: OutputOptions;         // Structured output config
  responseFormat?: ResponseFormat; // json_object or json_schema
  decoder?: DecoderType;          // Stream decoder strategy
  stream?: boolean;

  // Deprecated — use output instead
  schema?: z.ZodType;
  jsonSchema?: Record<string, unknown>;
  schemaName?: string;
  schemaDescription?: string;
}
```

---

## OutputOptions

Configuration for structured output when using `chat()` directly.

```typescript
interface OutputOptions<T = unknown> {
  /** Zod schema for validation and type inference */
  schema?: z.ZodType<T>;

  /** Raw JSON Schema (alternative to Zod) */
  jsonSchema?: Record<string, unknown>;

  /** Schema name — hint for the LLM */
  name?: string;

  /** Schema description — hint for the LLM */
  description?: string;

  /** Enable strict mode (OpenAI only, default true) */
  strict?: boolean;
}
```

---

## StructuredOutputError

Error thrown when structured output generation or validation fails.

```typescript
class StructuredOutputError extends Error {
  /** The raw text output from the LLM */
  readonly rawOutput: string;

  /** The underlying cause (ZodError or SyntaxError) */
  readonly cause: Error;
}
```

### Usage

```typescript
try {
  await model.generateStructured(schema, messages);
} catch (error) {
  if (error instanceof StructuredOutputError) {
    console.log(error.rawOutput);  // Raw LLM text
    console.log(error.cause);      // ZodError or SyntaxError
  }
}
```

---

## StructuredOutputResult\<T\>

Discriminated union returned by `tryParseStructured()`.

```typescript
type StructuredOutputResult<T> =
  | { ok: true;  value: T }
  | { ok: false; error: StructuredOutputError; rawOutput: string }
```

### Type Guards

```typescript
import {
  isStructuredOutputSuccess,
  isStructuredOutputFailure,
} from 'universal-llm-client';

const result = await model.tryParseStructured(schema, messages);

if (isStructuredOutputSuccess(result)) {
  result.value; // T
}
if (isStructuredOutputFailure(result)) {
  result.error;     // StructuredOutputError
  result.rawOutput; // string
}
```

---

## Schema Utilities

Exported from the main package and the `./structured-output` sub-path:

```typescript
import {
  zodToJsonSchema,
  parseStructured,
  tryParseStructured,
  validateStructuredOutput,
  StreamingJsonParser,
  normalizeJsonSchema,
  stripUnsupportedFeatures,
  convertToProviderSchema,
  getJsonSchema,
} from 'universal-llm-client';
```

### `zodToJsonSchema(schema)`

Convert a Zod schema to JSON Schema using Zod 4's native `z.toJSONSchema()`.

```typescript
function zodToJsonSchema<T>(schema: z.ZodType<T>): JSONSchema
```

### `parseStructured(schema, rawOutput)`

Parse a raw string as JSON and validate against a Zod schema. Throws `StructuredOutputError`.

```typescript
function parseStructured<T>(schema: z.ZodType<T>, rawOutput: string): T
```

### `StreamingJsonParser<T>`

Incremental JSON parser for streaming structured output:

```typescript
const parser = new StreamingJsonParser(schema);

// Feed tokens as they arrive
const result = parser.feed(token);

if (result.partial) {
  // Valid partial object
  console.log(result.partial);
}
```

---

## ProviderConfig

Configuration for individual providers.

```typescript
interface ProviderConfig {
  type: 'openai' | 'google' | 'vertex' | 'ollama' | 'llamacpp';
  apiKey?: string;
  url?: string;
  model?: string;      // Override the global model for this provider
  priority?: number;   // Lower = higher priority (default: array index)
  region?: string;     // Vertex AI region
  apiVersion?: string; // API version override
}
```

---

## Auditor

Interface for observability:

```typescript
interface Auditor {
  record(event: AuditEvent): void;
  flush?(): Promise<void>;
}
```

### Built-in Implementations

| Class | Behavior |
|-------|----------|
| `NoopAuditor` | Discards all events (default) |
| `ConsoleAuditor` | Logs events to console |
| `BufferedAuditor` | Buffers events for batch retrieval |

---

## Message Helpers

```typescript
import {
  textContent,
  imageContent,
  multimodalMessage,
  extractTextContent,
  hasImages,
} from 'universal-llm-client';

// Create multimodal messages
const msg = multimodalMessage('user', [
  textContent('Describe this image'),
  imageContent('data:image/png;base64,...'),
]);

// Extract text from any message format
const text = extractTextContent(message);

// Check if message contains images
const hasImg = hasImages(message);
```
