# Reasoning & Thinking

Modern models can *think* before they answer. `universal-llm-client` exposes this with **one
provider-agnostic flag** and surfaces the chain-of-thought consistently, so you can switch
backends without rewriting reasoning logic.

## The `thinking` flag

Set `thinking` at the model level and/or per call. It accepts a boolean **or** a level:

```typescript
const model = new AIModel({
  model: 'gemini-3.5-flash',
  thinking: 'high', // true | false | 'minimal' | 'low' | 'medium' | 'high'
  providers: [{ type: 'google', apiKey: process.env.GOOGLE_API_KEY }],
});

// Per-call override (highest precedence)
await model.chat(messages, { thinking: 'low' });
await model.chat(messages, { thinking: false }); // e.g. for structured output
```

- `true` — enable at the provider's default effort.
- `false` — disable.
- `'minimal' | 'low' | 'medium' | 'high'` — the `ThinkingLevel` scale.
- *unset* — send nothing; the model/server default applies.

It is only sent to the provider when explicitly set, so endpoints that reject unknown fields are
unaffected by default.

## How it maps per provider

| Provider | Mapping |
|---|---|
| **OpenAI** (official) | `reasoning_effort: <level>` for reasoning models (o-series, GPT-5). |
| **OpenAI-compatible** (vLLM/Qwen) | `chat_template_kwargs.enable_thinking` (on/off). |
| **Google / Gemini** | `thinkingConfig.thinkingLevel` (Gemini 3.x) or `thinkingBudget` (Gemini 2.5/2.0), with `includeThoughts` on. |
| **Anthropic** | extended thinking `budget_tokens` derived from the level (kept `< max_tokens`; `temperature` omitted, per the API). |
| **Ollama** | `think` on/off (no native levels). |

## Getting the reasoning back

The model's chain-of-thought is surfaced on `response.reasoning`, while `message.content` stays
the clean final answer:

```typescript
const res = await model.chat([
  { role: 'user', content: 'A farmer has 17 sheep; all but 9 run away, then he buys 5 more. How many?' },
]);

console.log(res.message.content); // "14"
console.log(res.reasoning);       // "Let me work through this... all but 9 means 9 remain; 9 + 5 = 14."
```

> Reasoning text is provided where the provider exposes it (e.g. Gemini with `includeThoughts`,
> Anthropic extended thinking, and OpenAI-compatible servers that return a `reasoning_content` /
> `reasoning` field). For servers that emit inline `<think>` tags, the `StandardChatDecoder`
> separates them automatically.

## Streaming reasoning

While streaming, reasoning arrives as `thinking` events (separate from `text`), and the final
returned response still carries the assembled `reasoning`:

```typescript
for await (const event of model.chatStream(messages, { thinking: 'high' })) {
  if (event.type === 'thinking') {
    process.stdout.write(`\x1b[2m${event.content}\x1b[0m`); // dim the thoughts
  } else if (event.type === 'text') {
    process.stdout.write(event.content);
  }
}
```

## Generation stats

Every response reports decode throughput on `usage` — server-precise for Ollama (from
`eval_count`/`eval_duration`) and client-measured wall-clock for the others:

```typescript
const res = await model.chat(messages);
console.log(res.usage?.tokensPerSecond); // e.g. 174.8
console.log(res.usage?.durationMs);      // e.g. 824
```

## Tips

- Reasoning models spend their token budget *thinking first*. Give a generous `maxTokens`, or a
  short prompt may exhaust the budget before reaching the answer.
- For **structured output** with a reasoning model, pass `thinking: false` so guided decoding
  emits the object directly.
- See [Deep Research](/guide/deep-research) for Gemini's agentic, long-running research mode.
