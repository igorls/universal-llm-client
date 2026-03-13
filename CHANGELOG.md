# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
