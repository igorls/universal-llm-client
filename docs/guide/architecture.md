# Architecture

```
universal-llm-client
├── AIModel          ← Public API (the only class you import)
├── Router           ← Internal failover engine
├── BaseLLMClient    ← Abstract client with tool execution
├── Providers
│   ├── OllamaClient
│   ├── OpenAICompatibleClient  (OpenAI, OpenRouter, Groq, LM Studio, vLLM, LlamaCpp)
│   └── GoogleClient            (AI Studio + Vertex AI)
├── StreamDecoder    ← Pluggable reasoning strategies
├── Auditor          ← Observability interface
├── MCPToolBridge    ← MCP server integration
└── HTTP Utilities   ← Universal fetch-based transport
```

## Design Principles

1. **Single import** — `AIModel` is the only class users need
2. **Provider agnostic** — Same code works with any backend
3. **Transparent failover** — Health tracking and cooldowns happen behind the scenes
4. **Zero dependencies** — Core library depends only on native `fetch`
5. **Agent-ready** — Stateless, composable instances designed as foundation for agent frameworks
6. **Observable** — Every request, response, tool call, retry, and failover is auditable

---

## For Agent Framework Authors

`AIModel` is designed as the transport layer for agentic systems:

- **Stateless** — No conversation history stored. Your framework manages memory
- **Composable** — Create separate instances for chat, embeddings, vision
- **Tool tracing** — `chatWithTools()` returns full execution trace
- **Context budget** — `getModelInfo()` exposes `contextLength`
- **Auditor as system bus** — Inject custom sinks for cost tracking, behavioral scoring
- **StreamDecoder as UI bridge** — Select decoder strategy per-call
