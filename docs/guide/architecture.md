# Architecture

The library is layered so that protocol details stay in the clients and everything shared sits above them.

```
AIModel                  public facade
  Router                 failover, health, pools, structured output validation
  BaseLLMClient          shared client logic: tool loop, schema helpers, errors
    OpenAICompatibleClient   OpenAI Chat Completions   (type: openai, llamacpp)
    AnthropicClient          Anthropic Messages        (type: anthropic)
    GoogleClient             Gemini                    (type: google, vertex)
    OllamaClient             Ollama                    (type: ollama)
```

Beside the request path:

- **Stream decoders** turn raw tokens into typed events.
- **Auditor** receives lifecycle events from the router and the clients.
- **MCPToolBridge** registers tools from MCP servers on an `AIModel`.
- **HTTP utilities** wrap `fetch`, server-sent events and newline-delimited JSON.

## Layer responsibilities

### AIModel

The class you construct. It holds no conversation state and delegates to the router:

- Builds one client per entry in `providers`, choosing the client from the entry's `type`.
- Exposes `chat()`, `chatWithTools()`, `chatStream()`, the structured output methods, `embed()`, `deepResearch()`, tool registration, model info and provider status.
- Calls `auditor.flush()` on `dispose()`.

### Router

The router handles what does not belong to one protocol:

- **Failover.** Tries providers in priority order and retries before moving on.
- **Health tracking.** Marks failing providers unhealthy and applies a cooldown.
- **Pools.** Spreads load across providers that share a priority.
- **Structured output validation.** Parses and validates responses in one place, whichever client answered.
- **Audit events.** Emits `failover`, `retry`, `error` and structured output events.

See [Failover](/guide/failover).

### BaseLLMClient

Shared by every client:

- The `chatWithTools()` loop and tool execution
- Extracting the schema from `ChatOptions`
- Error normalisation

### Clients

Each client implements one wire protocol and translates the library's canonical message and tool format to it. There is no client per vendor. A new endpoint is reached by pointing the matching client at its `url`; a new wire protocol would need a new client. See [Protocols](/guide/protocols).

`openai-responses.ts` also contains a client for the OpenAI Responses wire format. It is exported as `ResponsesClient`, but `AIModel` does not construct it and it is not part of the four protocols described in these guides.

## Structured output flow

```
1. model.generateStructured(config, messages)
2. Router takes config.jsonSchema
3. Router calls client.chat(messages, { jsonSchema })
4. The client puts the schema in its protocol's field:
     OpenAI Chat Completions: response_format.json_schema
     Gemini:                  responseMimeType + responseSchema
     Ollama:                  format
     Anthropic Messages:      nothing is sent
5. The client returns the raw response
6. Router parses the JSON and runs config.validate
7. Returns T, or throws StructuredOutputError
```

Validation lives in the router, not in the clients. Clients return raw responses, so behaviour is the same whichever provider answers.

## Source layout

```
src/
├── ai-model.ts            # AIModel facade
├── router.ts              # Failover, pools, validation
├── client.ts              # BaseLLMClient
├── interfaces.ts          # Public types and message helpers
├── structured-output.ts   # SchemaConfig, parsing, streaming parser
├── zod-adapter.ts         # fromZod (universal-llm-client/zod)
├── auditor.ts             # Auditor, NoopAuditor, ConsoleAuditor, BufferedAuditor
├── tools.ts               # ToolBuilder, ToolExecutor, example tools
├── tool-arg-coercion.ts   # Tool argument coercion and validation
├── stream-decoder.ts      # Decoders and the decoder registry
├── stream-guard.ts        # Runaway-output detection
├── thinking.ts            # Thinking option resolution
├── errors.ts              # Typed errors and failure classification
├── mcp.ts                 # MCPToolBridge
├── http.ts                # Request, streaming, SSE, NDJSON
└── providers/
    ├── openai.ts          # OpenAI Chat Completions client
    ├── anthropic.ts       # Anthropic Messages client
    ├── google.ts          # Gemini client (Gemini API and Vertex AI)
    ├── ollama.ts          # Ollama client
    └── openai-responses.ts  # Responses-format client (not used by AIModel)
```
