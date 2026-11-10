# Streaming

`chatStream()` is an async generator. It yields typed events as the response arrives, on every protocol:

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

## Events

`chatStream` yields `DecodedEvent` values (`src/stream-decoder.ts`):

| `type` | Payload | Meaning |
|---|---|---|
| `text` | `content` | A piece of the answer |
| `thinking` | `content` | A piece of the model's reasoning |
| `progress` | `content` | Text inside a `<progress>` tag, from decoders that parse it |
| `tool_call` | `calls` | Complete tool calls, ready to execute |
| `tool_call_delta` | `calls` | A snapshot of tool calls while their arguments are still streaming |

Execute tools only on `tool_call`. A `tool_call_delta` event carries the raw accumulation so far: its arguments can be empty, partial or invalid JSON. Each one is a full snapshot, so replace what you show rather than appending. Use them only for live display. Streams on the OpenAI Chat Completions protocol emit them; the other protocols emit only `tool_call`.

Tool results are not stream events. To run tools in a loop, use [`chatWithTools`](/guide/tools).

## The final response

The generator's return value is the assembled `LLMChatResponse` (content, `reasoning`, `usage`, tool calls). A `for await` loop discards it. To read it, drive the generator by hand:

```typescript
const stream = model.chatStream(messages);
let result = await stream.next();
while (!result.done) {
  handle(result.value);
  result = await stream.next();
}
const response = result.value; // LLMChatResponse | void
```

## Decoders

The `decoder` option selects how raw tokens become events:

```typescript
// Parses <think> and <progress> tags out of the text stream
model.chatStream(messages, { decoder: 'interleaved-reasoning' });

// No parsing; every token is a text event
model.chatStream(messages, { decoder: 'passthrough' });

// Text, native reasoning and tool calls
model.chatStream(messages, { decoder: 'standard-chat' });
```

`decoder` accepts a built-in name, a name registered with `registerDecoder()`, or a `StreamDecoder` instance. Without it, the client decodes the stream with its own defaults.

| Decoder | Behaviour |
|---|---|
| `passthrough` | No parsing. All tokens are `text` events |
| `standard-chat` | Text, the protocol's native reasoning, and tool calls |
| `interleaved-reasoning` | Also parses `<think>` and `<progress>` tags in the text |

## Using a decoder directly

`createDecoder` builds a decoder you feed yourself, for example from a stream you read outside the client:

```typescript
import { createDecoder } from 'universal-llm-client';

const decoder = createDecoder('interleaved-reasoning', (event) => {
  switch (event.type) {
    case 'text': console.log(event.content); break;
    case 'thinking': console.log('[think]', event.content); break;
    case 'progress': console.log('[progress]', event.content); break;
    case 'tool_call': console.log('[tool]', event.calls); break;
    case 'tool_call_delta': console.log('[tool preview]', event.calls); break;
  }
});

decoder.push('<think>Let me analyze this</think>The answer is 42');
decoder.flush();

decoder.getCleanContent(); // "The answer is 42"
decoder.getReasoning();    // "Let me analyze this"
```

`createDecoder(type, callback, options?)` throws if `type` is not registered. `options.knownToolNames` is a `Set<string>` that lets the standard decoder recover tool calls written as text.

## Cancelling

Pass an `AbortSignal` as `signal` in the options. It is forwarded to the HTTP layer.

```typescript
const controller = new AbortController();
const stream = model.chatStream(messages, { signal: controller.signal });
```

## Failover and streaming

A stream can fail over to the next provider only before its first event. After that, an error is raised to the caller. See [Failover](/guide/failover).

## Structured output

`chatStream()` throws if you pass `output`. Use `generateStructuredStream()` instead; see [Structured Output](/guide/structured-output).
