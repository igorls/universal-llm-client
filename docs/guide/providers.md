# Providers

This page moved. The library describes compatibility by wire protocol rather than by provider, so the content is organised that way now:

- [Protocols](/guide/protocols): the four wire protocols, the support table, the provider `type` for each, and the transport options (`headers`, `queryParams`, `authHeader`, `authPrefix`, `apiBasePath`).
- [Failover](/guide/failover): priority order, retries, health tracking, pools, and how structured output behaves across a chain.

To connect an endpoint, find the wire protocol it implements and use the matching `type`:

```typescript
const model = new AIModel({
  model: 'model-id',
  providers: [
    // Any endpoint that implements OpenAI Chat Completions
    { type: 'openai', url: 'https://llm.example.com/v1', apiKey: process.env.LLM_API_KEY },
  ],
});
```
