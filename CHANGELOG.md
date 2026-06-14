# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.5.0] - 2026-06-14

### Added

- **Server-side reasoning field support (OpenAI-compatible provider)** — Reasoning models served over the OpenAI-compatible API (vLLM `--reasoning-parser`, DeepSeek-R1, etc.) return their chain-of-thought in a dedicated `reasoning_content` (vLLM) / `reasoning` (some gateways) field instead of inline `<think>` tags. The OpenAI provider now surfaces it:
  - `chat()` populates `LLMChatResponse.reasoning` from `message.reasoning_content` / `message.reasoning`, keeping `message.content` clean
  - `chatStream()` emits `delta.reasoning_content` / `delta.reasoning` chunks as `thinking` stream events and accumulates them into the final `reasoning`
  - Inline `<think>` parsing (via `StandardChatDecoder`) is preserved as a fallback for servers run without a reasoning parser
  - `OpenAIResponse` message type extended with optional `reasoning` / `reasoning_content`
  - Verified end-to-end against vLLM serving `nvidia/Qwen3.6-35B-A3B-NVFP4` (NVFP4) on Blackwell — reasoning, streaming `thinking` events, tool calling (`qwen3_xml`), and structured output all pass
- **Unified `thinking` flag with levels across all providers** — `thinking` (model config) and per-call `ChatOptions.thinking` accept `true`/`false` **or a level `'minimal' | 'low' | 'medium' | 'high'`** (new `ThinkingLevel` type), mapped to each backend's native control so apps switch providers without reasoning-specific code. A shared `resolveThinking` helper (`src/thinking.ts`) normalizes the value; each provider maps it:
  - **OpenAI-compatible** → OpenAI reasoning models (o-series / GPT-5, by name) get `reasoning_effort:<level>`; vLLM / Qwen get `chat_template_kwargs.enable_thinking`. Emitted only when explicitly set.
  - **Google / Gemini** → Gemini 3.x `thinkingConfig.thinkingLevel`; Gemini 2.5/2.0 `thinkingBudget` (level→budget map, `0` off, `-1` dynamic). `includeThoughts` enabled when thinking is on.
  - **Anthropic** → extended thinking `budget_tokens` from the level (kept `< max_tokens`; temperature omitted, per API).
  - **Ollama** → `think` on/off (no native levels).
  - Per-call overrides model config everywhere. Verified live against vLLM (Qwen3.6-NVFP4) and **Gemini 3.5 Flash** (levels produce distinct reasoning-token counts); unit-tested per provider + `resolveThinking`.
- **Gemini reasoning text surfaced** — with thinking on, the Google provider sets `includeThoughts:true` and routes `thought:true` parts into `response.reasoning` (non-streaming) and live `thinking` stream events, matching how Qwen/Anthropic expose chain-of-thought (previously only `reasoningTokens` was reported). Verified live on `gemini-3.5-flash` (654–976 chars of reasoning across levels).
- **Gemini Deep Research API** — new Google-only `AIModel.deepResearch(input, opts)` (creates a `/v1beta/interactions` background interaction and polls to completion → `{ id, status, report, steps }`) and `AIModel.deepResearchStream(input, opts)` (live `thought`/`text`/`status` events). New `DeepResearchOptions`/`DeepResearchResult`/`DeepResearchStep`/`DeepResearchEvent` types. Throws a clear error if no Google provider is configured. Create + poll plumbing verified live.
- **Generation stats — `usage.durationMs` and `usage.tokensPerSecond`** — decode throughput is now reported on `LLMChatResponse.usage`: server-precise for Ollama (from `eval_count` / `eval_duration`, which were previously discarded), and client-measured wall-clock for OpenAI-compatible / vLLM (which return no timing in `usage`). `OllamaResponse` gained `total_duration` / `load_duration` typings.
- **OpenAI-compatible transport flexibility** — `ProviderConfig` gains `headers`, `queryParams`, `authHeader`, `authPrefix`, and `apiBasePath` for Azure OpenAI, custom gateways, and non-`/v1` servers (no custom code needed). Honored by the OpenAI-compatible provider (`headers`/`authHeader`/`authPrefix` also by Ollama, via `buildHeaders`); a `buildUrl` helper applies `queryParams`/`apiBasePath` across all endpoints and preserves any query string already on the base URL. Includes a 2026 provider-API-landscape research doc (`docs/research/`).

### Fixed

- **README** — the tool-execution trace field is `response.toolExecutions` (array of `{ tool_call_id, output, error?, duration? }`), not `toolTrace`; corrected the `chatWithTools` example.

## [4.4.0] - 2026-06-11

### Added

- **Diffusion LM support (DiffusionGemma family)** — First-class client-side protocol for diffusion language models served by OpenAI-compatible endpoints that ship without server-side reasoning or tool-call parsers (e.g. current vLLM diffusion builds, which reject request-level `tools` with auto tool choice):
  - `gemma-diffusion.ts` — model detection (`isGemmaDiffusionModel`), native channel parsing (`<|channel>thought … <channel|>` reasoning, `<|tool_call>call:name{…}<tool_call|>` tool calls), and pseudo-JSON argument conversion (`gemmaArgsToJson`: `<|"|>` quote tokens, bare keys, nested objects/arrays)
  - OpenAI provider native mode (auto-detected from the model name, `gemmaNativeProtocol` option to override): sends `skip_special_tokens: false` and `tools` + `tool_choice: "none"` (declarations still render into the chat template), parses reasoning and tool calls client-side, and yields decoder-classified `thinking`/`text` streaming events
  - Full agentic `chatWithTools` loop works end-to-end against DiffusionGemma; history tool turns use standard structured `tool_calls` + `role: "tool"` messages
- **"Signal from Noise" demo** (`src/demos/diffusion-gemma/`) — vLLM test harness plus a diffusion chat canvas that animates block-parallel denoising paced by real block arrivals, with replay/scrubbing, reasoning-channel separation, a rendered-markdown reading view, and an engine-reload entropy control

### Fixed

- Stray unbalanced `<channel|>` / `<turn|>` markers emitted by diffusion models are stripped from parsed content

## [4.0.0] - 2026-03-13

### ⚠ BREAKING CHANGES

- **Zod 4 required** — `zod@^4.0.0` is now a peer dependency (upgraded from Zod 3). Consumers must install `zod@^4.0.0`.
- **Zero-dependency core** — Removed `zod-to-json-schema` from dependencies. Schema conversion now uses Zod 4's native `z.toJSONSchema()`. The library has no runtime dependencies (only peer deps).

### Added

- **Structured Output** — First-class structured output with Zod schema validation
  - `generateStructured(schema, messages, options)` — returns typed, validated output
  - `tryParseStructured(schema, messages, options)` — non-throwing variant returning `Result<T>`
  - `generateStructuredStream(schema, messages, options)` — streaming with partial validated objects
  - `chat(messages, { output: { schema } })` — structured output via `output` parameter on `chat()`
  - Custom `StructuredOutputError` with `rawOutput` and `cause` for debuggability
- **Provider Structured Output Support** — Native format negotiation per provider
  - OpenAI: `response_format: { type: 'json_schema' }` with configurable `strict` mode
  - Google/Vertex AI: `responseMimeType` + `responseSchema` with automatic unsupported feature stripping
  - Ollama: `format` parameter with JSON Schema objects
- **Streaming JSON Parser** — `StreamingJsonParser` for progressive partial object validation
- **Audit Events** — `structured_request`, `structured_response`, `structured_validation_error` events
- **Schema Utilities** — `zodToJsonSchema()`, `normalizeJsonSchema()`, `stripUnsupportedFeatures()`, `getJsonSchema()`
- **`./structured-output` sub-path export** — Direct import of structured output utilities

### Fixed

- Validation logic deduplicated into `BaseLLMClient` (was copy-pasted across 3 providers)
- Removed double validation (Router + Provider both validated the same response)
- Audit events no longer log `"assistant"` as the model name
- `chatStream()` now throws a clear error if `output` parameter is provided (use `generateStructuredStream()`)
- `zodToJsonSchema()` preserves `definitions`/`$defs` when `$ref` references exist in the schema tree
- OpenAI `strict` mode is now configurable via `output.strict` (defaults to `true`)

### Deprecated

- `ChatOptions.schema`, `.jsonSchema`, `.schemaName`, `.schemaDescription` — use `output` parameter or `generateStructured()` instead

---

## [3.1.0] - 2026-03-12

### Added

- **Ollama Vision/Multimodal** — Ollama provider now converts OpenAI-style multimodal content (text + image parts) into Ollama's native `images[]` format
  - Supports base64 data URLs, raw base64 strings, and gracefully skips HTTP URLs
  - Multiple images and mixed text+image messages handled correctly
- **CHANGELOG.md** — Added changelog following [Keep a Changelog](https://keepachangelog.com/) format
- **Ollama Provider Tests** — 13 new unit tests covering vision, tool call arguments, options mapping, and response normalization

### Fixed

- Architecture section in README referenced `@akaito/universal-llm-client` instead of the correct unscoped package name
- LlamaCpp missing from the README architecture tree despite being a supported provider
- `@module` JSDoc in barrel export referenced wrong scoped name

### Changed

- Added `author`, `homepage`, `bugs` fields to `package.json`
- Updated LICENSE copyright year to 2025-2026
- Improved `.npmignore` to exclude dev-only files from tarball

---

## [3.0.0] - 2026-03-12

### ⚠ BREAKING CHANGES

- Complete rewrite with a new modular architecture
- `AIModel` is now the sole public-facing class (replaces direct provider instantiation)
- Provider configuration moved to a declarative `providers[]` array
- Minimum runtime: Node.js 22+, Bun 1.0+

### Added

- **Transparent Failover** — Priority-ordered provider chain with retries, health tracking, and configurable cooldowns
- **Streaming** — First-class async generator streaming with pluggable decoder strategies (passthrough, standard chat, interleaved reasoning)
- **Tool Calling** — Register tools once, works across all providers. Autonomous multi-turn execution loop via `chatWithTools()`
- **Tool Utilities** — `ToolBuilder` (fluent API), `ToolExecutor` (timeout, validation, safe wrappers, composition)
- **Reasoning/Thinking** — Native `<think>` tag parsing, model thinking mode, and interleaved reasoning support
- **Observability** — Built-in `Auditor` interface with `ConsoleAuditor`, `BufferedAuditor`, and `NoopAuditor` implementations
- **MCP Integration** — `MCPToolBridge` for bridging MCP servers to LLM tools with zero glue code
- **Multimodal/Vision** — `multimodalMessage()`, `imageContent()`, `textContent()` helpers; vision support across Google, OpenAI, and Ollama providers
- **Embeddings** — Single (`embed()`) and batch (`embedArray()`) embedding generation
- **Model Discovery** — `getModels()` and `getModelInfo()` for runtime model introspection
- **Gemini 3.x Support** — `thoughtSignature` handling for multi-turn function calling
- **Provider Support** — Ollama, OpenAI (+ OpenRouter, Groq, LM Studio, vLLM), Google AI Studio, Vertex AI, LlamaCpp

### Changed

- Zero runtime dependencies — core library uses only native `fetch`
- ESM-only distribution (no CJS bundle)
- Full TypeScript strict mode with declaration maps and source maps

## [2.x] - Pre-rewrite

Legacy versions with direct provider APIs. Not documented here — see git history for details.
