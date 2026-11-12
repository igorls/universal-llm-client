# Features

Each capability has its own guide. This page lists them and what each covers.

| Task | Guide | What it covers |
|---|---|---|
| Connect an endpoint | [Protocols](/guide/protocols) | The four wire protocols, the support table, the `type` for each, transport options |
| Survive a provider outage | [Failover](/guide/failover) | Priority order, retries, health, pools, status |
| Stream a response | [Streaming](/guide/streaming) | Event types, decoders, the final response, cancelling |
| Call tools | [Tools and MCP](/guide/tools) | `registerTool`, `chatWithTools`, `ToolBuilder`, `ToolExecutor`, MCP servers |
| Get typed JSON | [Structured Output](/guide/structured-output) | Schemas, validation, streaming partial objects |
| Control reasoning | [Reasoning](/guide/reasoning) | The `thinking` option, how it maps per protocol, reading the reasoning |
| Watch what happens | [Observability](/guide/observability) | Auditors, event types, usage and generation stats |
| Embed text, send images | [Embeddings and Vision](/guide/embeddings-vision) | `embed`, `embedArray`, `multimodalMessage` |
| Classify, route or score without generating text | [Decisions](/guide/decisions) | `decide`, question types, probabilities, fallback models |
| Run a research agent | [Deep Research](/guide/deep-research) | Long-running agentic research on the Gemini protocol |

For the structure of the library, see [Architecture](/guide/architecture). For every method and type, see the [API Reference](/api/reference).
