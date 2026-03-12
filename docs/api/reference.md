# API Reference

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
