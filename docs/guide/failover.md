# Failover

One `AIModel` can hold several provider entries. A request goes to the first available provider; if it fails, the router retries it, then moves to the next. Your code sees one response.

```typescript
import { AIModel } from 'universal-llm-client';

const model = new AIModel({
  model: 'model-id',
  retries: 2,      // retries per provider before failing over
  timeout: 30000,  // request timeout in ms
  providers: [
    { type: 'openai', url: 'https://llm.example.com/v1', apiKey: process.env.LLM_API_KEY, priority: 0 },
    { type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY, priority: 1 },
    { type: 'ollama', url: 'http://localhost:11434', priority: 2 },
  ],
});

const response = await model.chat([{ role: 'user', content: 'Hello' }]);
```

The chain can mix protocols. Each provider receives the request translated to its own wire format.

## The model name

`model` is shared by every provider in the chain. If a provider needs a different name, set `model` on its entry:

```typescript
providers: [
  { type: 'openai', url: 'https://llm.example.com/v1', apiKey: process.env.LLM_API_KEY },
  { type: 'ollama', model: 'local-model-id' },
]
```

## Order, retries and health

- **Priority.** A lower `priority` is tried first. It defaults to the entry's position in the array.
- **Retries.** `retries` (default 2) is the number of retries on one provider before moving on. A failure that cannot be helped by retrying, such as an authentication or rate-limit response, skips the retries.
- **Health tracking.** A provider that fails three times in a row is marked unhealthy and skipped for a 30 second cooldown. A provider that is unreachable, unauthorised, rate limited or missing the endpoint enters the cooldown at once. These thresholds are router defaults; `AIModel` does not expose them.
- **If every provider is cooling down**, the router re-admits the one whose cooldown ends soonest instead of failing every request for the whole cooldown.
- **Cold nodes.** A provider with no recent success is probed with a short liveness check before a request is sent to it, so a powered-off host does not stall the first request for the length of an OS connect timeout.
- **Shared endpoint health.** When a request finds a host unreachable (connection refused or reset, DNS failure, no route), every router in the process learns it, so other models and routers pointing at the same host stop waiting on it. Only unreachability is shared: an HTTP response of any status, a timeout, and a slow cold-node probe stay with the router that saw them, because they can be one caller's key or quota, or a healthy server that is busy. A host marked unreachable is deferred, not removed: routers prefer other providers, and when none is left they send the request anyway. A background `HEAD` request (every 30 seconds) clears the mark, and so does any successful request. A provider entry can start with an external signal, `availability: { status: 'down', checkedAt, retryAfterMs }`, for example from a control plane; an older signal never overrides a newer success. `getStatus()` reports the mark as `endpointDown`.

## Streaming

A stream can fail over only before it has produced its first event. Once events have been emitted, a failure is raised to the caller instead of replaying the request on another provider, which would duplicate output.

## Pools

Provider entries that share the same `priority` form a pool. The router spreads requests across a pool by fewest requests in flight, and moves to the next priority only when the pool fails or is full. Distinct priorities keep strict ordered failover.

```typescript
providers: [
  { type: 'ollama', url: 'http://gpu-a.example.com:11434', priority: 0, maxConcurrent: 4 },
  { type: 'ollama', url: 'http://gpu-b.example.com:11434', priority: 0, maxConcurrent: 4 },
  { type: 'openai', url: 'https://llm.example.com/v1', apiKey: process.env.LLM_API_KEY, priority: 1 },
]
```

- `maxConcurrent` caps the in-flight requests one entry accepts. The default is no cap.
- When every entry in a pool is at its cap, a request waits up to `spillAfterMs` (default 750) for a slot, then spills to the next priority.
- `sessionKey` on `ChatOptions` is a routing hint, never sent to the provider. Within a pool, requests with the same key prefer the same node, so consecutive turns of a conversation can reuse that node's prompt cache.

## Inspecting state

```typescript
model.getProviderStatus();
// [{ id: 'openai-0', healthy: true, consecutiveFailures: 0, inflight: 0, ... }, ...]

model.getPoolStatus();
// [{ priority: 0, nodes: ['ollama-0', 'ollama-1'], inflight: 0, spills: 0, queueWaits: 0 }, ...]
```

`getProviderStatus()` also reports each node's URL, model, request and failure counts, and latency. Failovers, retries and errors are emitted to the [auditor](/guide/observability) as `failover`, `retry` and `error` events.

## Structured output across a chain

1. The validator's JSON Schema is sent in each protocol's native form: `response_format`, `responseSchema`, or `format`. The Anthropic Messages client sends no schema.
2. If a provider fails, the next one receives the same schema in its own form.
3. Parsing and validation run once in the router, so the same validator applies whichever provider answered.

See [Structured Output](/guide/structured-output) and [Protocols](/guide/protocols).

## Embeddings

Not every protocol has an embeddings endpoint (see the [support table](/guide/protocols#support-by-protocol)). Keep embeddings on their own `AIModel` with providers that support them.
