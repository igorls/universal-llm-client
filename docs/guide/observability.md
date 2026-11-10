# Observability

Every request, response, stream, retry, failover, tool call and structured output validation is emitted to an `Auditor`. The default, `NoopAuditor`, discards everything.

```typescript
import { AIModel, ConsoleAuditor, BufferedAuditor } from 'universal-llm-client';

// Log events to the console
const model = new AIModel({
  model: 'model-id',
  providers: [{ type: 'ollama' }],
  auditor: new ConsoleAuditor('[LLM]'),
});

// Collect events and send them to your own sink
const auditor = new BufferedAuditor({
  maxBufferSize: 100,
  onFlush: async (events) => {
    await sendToSink(events);
  },
});
```

## Auditor interface

```typescript
interface Auditor {
  record(event: AuditEvent): void;
  flush?(): Promise<void>;
}
```

`model.dispose()` calls `flush()`. Implement the interface to feed any logging, tracing or cost system.

| Class | Behaviour |
|---|---|
| `NoopAuditor` | Discards events. The default |
| `ConsoleAuditor` | Logs events to the console. Takes an optional prefix |
| `BufferedAuditor` | Keeps events in a buffer. Options: `maxBufferSize` (default 1000) and `onFlush`. `getEvents()` reads the buffer, `flush()` passes it to `onFlush` and empties it (it also runs when the buffer fills), `clear()` discards it |

## Events

| `type` | When |
|---|---|
| `request` | Before a request is sent to a provider |
| `response` | After a response arrives |
| `stream_start` | When a stream begins |
| `stream_end` | When a stream ends |
| `tool_call` | When the model calls a tool |
| `tool_result` | When a tool returns |
| `error` | On a provider error |
| `retry` | When a provider is retried |
| `failover` | When the router moves to the next provider |
| `structured_request` | Before structured output generation |
| `structured_response` | After a structured response validates |
| `structured_validation_error` | When a structured response fails validation |

An `AuditEvent` carries `timestamp` and `type`, plus whichever of these apply: `provider`, `model`, `duration`, `usage`, `toolExecution`, `error`, `schemaName`, `rawOutput` and a free-form `metadata` object.

## Usage and generation stats

Every response reports token usage on `usage`:

```typescript
const res = await model.chat(messages);
console.log(res.usage?.inputTokens, res.usage?.outputTokens);
console.log(res.usage?.tokensPerSecond, res.usage?.durationMs);
```

`tokensPerSecond` and `durationMs` come from the server when it reports timing (Ollama), and are measured by the client otherwise. `reasoningTokens`, `cachedTokens` and `cacheWriteTokens` are present when the protocol reports them. After a `chatWithTools` loop, `usage` is the cumulative total and `lastCallUsage` is the final call alone; use `lastCallUsage.inputTokens` to see the real size of the last prompt.

`response.provider` names the provider entry that answered, and `response.model` is the model id the server reported, when it reports one.

## Provider health

`model.getProviderStatus()` and `model.getPoolStatus()` report health, load and latency per provider. See [Failover](/guide/failover).
