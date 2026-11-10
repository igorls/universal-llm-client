# Reasoning and Thinking

Some models think before they answer. `universal-llm-client` controls this with one `thinking` option and returns the reasoning the same way on every protocol, so changing the backend does not mean rewriting reasoning code.

## The `thinking` option

Set `thinking` on the model, on a call, or both. It accepts a boolean or a level:

```typescript
import { AIModel } from 'universal-llm-client';

const model = new AIModel({
  model: 'model-id',
  thinking: 'high', // true | false | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  providers: [{ type: 'google', apiKey: process.env.GOOGLE_API_KEY }],
});

// A per-call value takes precedence over the model's
await model.chat(messages, { thinking: 'low' });
await model.chat(messages, { thinking: false }); // for example, for structured output
```

| Value | Meaning |
|---|---|
| `true` | Enable at the protocol's default effort |
| `false` | Disable |
| `'minimal'`, `'low'`, `'medium'`, `'high'`, `'xhigh'` | The `ThinkingLevel` scale. Each protocol maps it to its own control, as the table below shows |
| unset | Send nothing. The server's own default applies |

The option is sent only when you set it, so endpoints that reject unknown fields are unaffected by default. The type is `boolean | ThinkingLevel`.

## How it maps per protocol

| Protocol | Request control |
|---|---|
| OpenAI Chat Completions | `reasoning_effort` with the level, for model ids the client recognises as reasoning models. Otherwise `chat_template_kwargs.enable_thinking` (on or off), which is not sent to hosted gateways known to reject unknown fields. A few hosted gateways have their own rules in the client |
| Gemini | `thinkingConfig`, using `thinkingLevel` or `thinkingBudget` depending on the model id, with `includeThoughts` on |
| Anthropic Messages | Extended thinking, with `budget_tokens` derived from the level. The budget is kept below `max_tokens`, which is raised if needed, and `temperature` is omitted, as the API requires |
| Ollama | `think` on `/api/chat`: `false`, `true`, or `low`, `medium`, `high`, `max`. `minimal` becomes `low` and `xhigh` becomes `max`. Native chat does not send `reasoning_effort`. Requests to an Ollama URL through the OpenAI-compatible path still send `reasoning_effort`, as `none` when thinking is off |

The model-id rules are in `src/thinking.ts` and `src/providers/google.ts`. To override Gemini's choice, pass your own `thinkingConfig` in `parameters`; it is left untouched.

### Ollama and models without thinking

With `thinking` unset, the Ollama client leaves `think` out and the server applies the model's default. When you ask for thinking (`true` or a level), the client checks `/api/show` for the model's `thinking` capability and leaves `think` out if the model lacks it, instead of failing with an HTTP 400. The check is cached per model and made only when thinking is requested. `false` is always sent.

## Getting the reasoning back

The reasoning is on `response.reasoning`, and `message.content` stays the clean answer:

```typescript
const res = await model.chat([
  { role: 'user', content: 'A farmer has 17 sheep; all but 9 run away, then he buys 5 more. How many?' },
]);

console.log(res.message.content); // the final answer
console.log(res.reasoning);       // the chain of thought, when the model exposes it
```

Reasoning is returned where the protocol exposes it: Gemini thought summaries, Anthropic thinking blocks, Ollama's `message.thinking`, and the `reasoning_content` or `reasoning` field some Chat Completions servers add. For servers that put reasoning inline in `<think>` tags, the decoder separates it.

## Streaming reasoning

While streaming, reasoning arrives as `thinking` events, separate from `text`. The returned response still carries the assembled `reasoning`:

```typescript
for await (const event of model.chatStream(messages, { thinking: 'high' })) {
  if (event.type === 'thinking') {
    process.stdout.write(`\x1b[2m${event.content}\x1b[0m`); // dim the thoughts
  } else if (event.type === 'text') {
    process.stdout.write(event.content);
  }
}
```

See [Streaming](/guide/streaming) for the full event list.

## Usage

`usage.reasoningTokens` reports reasoning tokens when the protocol counts them separately (the Gemini client fills it). Other protocols may include them in `outputTokens`. See [Observability](/guide/observability).

## Tips

- A model that thinks first spends its token budget on thinking. Give a generous `maxTokens`, or a short budget can run out before the answer.
- For [structured output](/guide/structured-output) with a reasoning model, pass `thinking: false` so the object is emitted directly.
- For long-running agentic research on the Gemini protocol, see [Deep Research](/guide/deep-research).
