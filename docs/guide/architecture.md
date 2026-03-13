# Architecture

Universal LLM Client uses a layered architecture that separates concerns cleanly:

```
┌─────────────────────────────────────────┐
│              AIModel                    │  ← Public API (stateless facade)
├─────────────────────────────────────────┤
│              Router                     │  ← Failover, health, validation
│  ┌──────────┬──────────┬──────────────┐ │
│  │ Structured│  Tool   │   Stream     │ │  ← Orchestration features
│  │  Output   │Executor │  Decoders    │ │
│  └──────────┴──────────┴──────────────┘ │
├─────────────────────────────────────────┤
│           BaseLLMClient                 │  ← Common provider logic
├──────────┬──────────┬───────────────────┤
│ OpenAI   │  Google  │     Ollama       │  ← Provider implementations
│Compatible│  Client  │     Client       │
└──────────┴──────────┴───────────────────┘
```

## Layer Responsibilities

### AIModel (Public Facade)

The only class users import. A stateless facade that delegates to the Router:

- Creates and configures providers from the config
- Exposes `chat()`, `chatStream()`, `generateStructured()`, `tryParseStructured()`, `generateStructuredStream()`
- Manages tool registration and embeddings
- Provides provider status and lifecycle methods

### Router (Orchestration)

The Router handles cross-cutting concerns that don't belong in individual providers:

- **Provider failover** — tries providers in priority order, retries on failure
- **Health tracking** — marks unhealthy providers, applies cooldowns
- **Structured output validation** — parses and validates responses with Zod (centralized, not per-provider)
- **Tool execution** — multi-turn autonomous tool calling
- **Auditor integration** — emits audit events for all operations

### Structured Output Flow

```
1. AIModel.generateStructured(schema, messages)
2. Router converts Zod schema → JSON Schema (via z.toJSONSchema())
3. Router delegates to Provider.chat(messages, { jsonSchema })
4. Provider formats schema for its API:
   - OpenAI: response_format.json_schema
   - Google: responseMimeType + responseSchema
   - Ollama: format
5. Provider returns raw response
6. Router parses JSON + validates against Zod schema
7. Returns typed T or throws StructuredOutputError
```

::: info Key Design Decision
Validation is **centralized in the Router**, not in individual providers. Providers return raw responses — the Router handles all parsing and validation. This ensures consistent behavior regardless of which provider responds.
:::

### BaseLLMClient (Provider Base)

Common logic shared by all providers:

- HTTP request/response handling
- Schema extraction from ChatOptions
- Stream processing
- Error normalization

### Providers

Each provider implements the LLM-specific API protocol:

| Provider | API Format | Structured Output Format |
|----------|-----------|-------------------------|
| OpenAI Compatible | OpenAI Chat Completions | `response_format: { type: 'json_schema' }` |
| Google Client | Gemini API / Vertex AI | `responseMimeType` + `responseSchema` |
| Ollama Client | Ollama REST API | `format` parameter |

## Module Structure

```
src/
├── ai-model.ts         # Public API facade
├── router.ts           # Failover, orchestration, validation
├── client.ts           # BaseLLMClient (shared provider logic)
├── structured-output.ts # Types, schema conversion, parsing, streaming
├── interfaces.ts       # All TypeScript interfaces and types
├── auditor.ts          # Observability (NoopAuditor, ConsoleAuditor, etc.)
├── tools.ts            # ToolBuilder, ToolExecutor, built-in tools
├── stream-decoder.ts   # Pluggable stream decoding strategies
├── mcp.ts              # MCP server bridge
├── http.ts             # HTTP utilities (request, streaming, SSE)
└── providers/
    ├── openai.ts       # OpenAI-compatible provider
    ├── google.ts       # Google/Vertex AI provider
    └── ollama.ts       # Ollama provider
```
