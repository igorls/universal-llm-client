# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`embedMany(inputs, options)` on every client, `AIModel` and the router** — embeds a batch for a task (`query`, `document`, `similarity`, `classification`, `clustering`, `code`) and returns `{ embeddings, model, dimensions, promptFormat, task, inputTokens }`. Inputs are strings or `{ text, title }`. Options: `task`, `promptFormat`, `dimensions`, `batchSize`, `truncate` and `keepAlive` (Ollama). Fails over across providers like chat.
- **Embedding prompt formats** — a declared format (`LLMClientOptions.embeddingPromptFormat`, or `promptFormat` per call) turns the task into model input using model-card templates. `EMBEDDING_PROMPT_FORMATS` ships `none`, `embeddinggemma`, `qwen3-embedding`, `nomic`, `e5` and `mxbai`; any `{ id, templates }` object works. Nothing is inferred from the model name, and `embed()`/`embedArray()` keep sending plain text, so existing vectors stay comparable.
- **Output dimensions** — `dimensions` (or `LLMClientOptions.embeddingDimensions`) is sent as Ollama `dimensions`, OpenAI-compatible `dimensions` and Gemini `outputDimensionality`; a longer vector that comes back is cut and re-normalized. Helpers `truncateEmbedding`, `normalizeEmbedding`, `formatEmbeddingInput` and `resolveEmbeddingPromptFormat` are exported.

### Changed

- **Batched embedding requests on every protocol** — OpenAI-compatible `embedArray` sends one `/embeddings` request instead of one per text, puts vectors back in input order by `index`, and sends `encoding_format: "float"`. Gemini `embedArray` uses `batchEmbedContents` (100 per request; Vertex keeps one `embedContent` call per text) and takes the task natively as `taskType`, with `title` on documents. Ollama retries an input its server refuses as longer than the context once, cut to about two thirds, and falls back to `/api/embeddings` on servers without `/api/embed`. A response with a different number of vectors than inputs now fails instead of returning a short array.

### Fixed

- **OpenAI-compatible requests no longer leak Ollama serving parameters** — shared worker or route parameters now translate a positive `num_predict` into the endpoint's existing output-token field, and `format` into `response_format` (`json_object` or `json_schema`). A per-call `maxTokens` overrides the legacy bound, native output and format fields retain priority over aliases, and `omitResponseFormat` still wins. Ollama's `num_ctx`, `keep_alive`, and unbounded `num_predict` sentinels are omitted from Chat Completions requests. Native Ollama behavior and the Responses transport's allowlisted body are unchanged.

## [4.7.0] - 2026-11-12

### Fixed

- **Ollama requests to models without thinking no longer fail** — with `thinking` unset, the native `/api/chat` request sent `think: true`, and Ollama rejects that for every model without the "thinking" capability (`HTTP 400: "<model>" does not support thinking`), so those models could not be used at all. Unset now leaves `think` out: Ollama applies the model's own default, which for thinking models is to think (same output as `true`, measured on Ollama 0.40). When thinking is asked for (`true` or a level) and `/api/show` reports no "thinking" capability, `think` is left out instead of failing; the lookup is cached per model and only made when thinking is asked for. When the capability cannot be read, the request goes as asked. `false` is always sent.
- **Anthropic thinking works on current Claude models** — `thinking: true` or a level was always sent as extended thinking (`{ type: 'enabled', budget_tokens }`), which current models reject (`HTTP 400: "thinking.type.enabled" is not supported for this model`). When a request turns thinking on, the client now reads the model card (`GET /v1/models/{id}`, cached per model, also filled by `getModels()`). A model whose card lists adaptive thinking gets `{ type: 'adaptive', display: 'summarized' }`, so `reasoning` keeps its text; a level is sent as `output_config.effort` (`minimal` as `low`, a level the model does not list as the nearest one it does, the lower on a tie), and a bare `true` leaves the model's default effort. Models without adaptive thinking, and servers with no card, get extended thinking as before. `max_tokens` is raised the same way for both shapes, and `temperature` is still omitted while thinking is on.
- **Anthropic `thinking: false` turns thinking off where the model allows it** — `false` sent nothing, so models that think by default kept thinking. It now sends the off switch the model card lists: `{ type: 'disabled' }`, or `{ type: 'between_tools' }` on a model that lists only that. A model whose card lists neither always thinks, and nothing is sent; neither is anything sent when no card is found.
- **A `temperature` the Anthropic model rejects no longer fails the request** — current Claude models answer a custom `temperature` with `HTTP 400: "temperature" is deprecated for this model`, and the model card does not say which models do. On that answer the client sends the request again without `temperature`, warns once, and leaves it out of later requests to that model. Other errors, such as an out-of-range value, are not retried. Streaming does the same before any event arrives.

### Changed

- **Documentation uses protocol framing** — the README and guides now state compatibility per wire protocol (OpenAI Chat Completions, Anthropic Messages, Gemini, Ollama) instead of per provider, carry no provider or model lists, and use the `'model-id'` placeholder in examples. `docs/guide/providers.md` now points to the new `docs/guide/protocols.md`; the features guide is split into streaming, tools and MCP, observability, and embeddings and vision pages, and a failover guide was added. Documentation errors corrected along the way: the stream event is `thinking`, `MCPToolBridge` takes `servers` as a record keyed by name, `multimodalMessage(text, images, mimeType)`, `thinking` is `boolean | ThinkingLevel`, structured output methods take a `SchemaConfig` (`fromZod` for Zod schemas), and Zod is an optional peer dependency.
- **Ollama thinking levels** — native `/api/chat` now follows the official `think` field ([api.md](https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion)): boolean or `low`/`medium`/`high`/`max`. Unified `xhigh` → `max`, `minimal` → `low`. `reasoning_effort` is not sent on the native chat API (that is a vLLM/Qwen template knob). OpenAI-compat requests aimed at an Ollama URL (`:11434` / ollama.com) still send `reasoning_effort: none` when thinking is off; vLLM still omits `none`.
- **A failed model listing now rejects** — when `/v1/models` failed, the Anthropic client's `getModels()` returned three hardcoded Claude ids and the OpenAI-compatible client's returned `[]`. Both now throw the request's error. `AIModel.getModels()` still skips a provider whose listing fails, so the combined list holds only ids an endpoint reported.
- **`getModelInfo()` no longer guesses from model names where config or the endpoint answers** — each value resolves in the order declared, endpoint, name inference, default. Anthropic: the model name is no longer read. The window and capabilities come from the endpoint's model card (`max_input_tokens`, and `capabilities` for image input and thinking; from `GET /v1/models/{id}`, or the cards `getModels()` already fetched), marked `endpoint`. Without a card it reports `['tools', 'vision']` and a 200 000-token window, both marked `assumed`. Names containing `claude-` no longer get `thinking` from the name; it comes from the card. OpenAI-compatible: `inferOpenAICompatCapabilities()` answers only when no `capabilities` were declared, and is now `@deprecated` (still exported; no new names will be added). Ollama: when `/api/show` gives no window, the one `/api/ps` reports is used as is instead of being capped at 8192.
- **Removed the built-in context tables** — the OpenAI-compatible client's entry for `gemma-4-31b` on Cerebras (131 072) and the Responses client's numbers (272 000, or 128 000 for names containing `codex-mini`). These models now report the endpoint's window when it gives one, otherwise 8192 marked `assumed`; declare `contextLength` to report the real window. On Cerebras the table also bounded `max_tokens` when the caller set none; that bound now applies only when the endpoint advertises a window.
- **The Responses client requires a model** — it no longer substitutes `gpt-5.2-codex` when `model` is empty; such a request fails with `LLMProviderError` before anything is sent.
- **Anthropic tool loops keep their thinking** — the signed thinking blocks a response carried before a tool call were dropped from the next request, so the model lost its earlier reasoning between tool calls. The client now keeps them (by tool call id, so a caller that rebuilds history from its own log still gets them) and, on a request that turns thinking on, sends them back where the API put them. Such a request also carries `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` with the `thinking-binding-controls-2026-08-01` beta header: if the caller edited earlier history, the API drops the stale block (not billed) instead of rejecting the request, which accounts created on or after 2026-08-31 would otherwise get on current models. Requests with nothing to send back are unchanged. If an endpoint rejects a request that carries them and accepts it without them, the client warns once and stops sending them.

### Added

- **Decisions: `AIModel.decide(state, questions, options?)`** — asks a decision model typed questions about a state over the System One protocol (`POST /v1/systemone`) and returns probabilities instead of text: a `noul` (yes/no) answers with P(yes), a `choice` and a `score` with their whole distribution. Answer types follow the questions passed. Implemented on the Ollama protocol and on the OpenAI-compatible protocol (for servers that add `/systemone` beside their other routes); the Anthropic and Gemini clients reject with `DecisionUnsupportedError` and a router passes them over. Calls go through the router, so priority tiers, pools, cooldowns and the HTTP tap apply; the result carries the answering endpoint's `url` and `model`, so a caller can tell a fallback model's probabilities from the primary's. A response is validated against the questions asked (`DecisionResponseError`), and a request every answering provider refused for context size rejects with `DecisionContextLimitError`. New guide: `docs/guide/decisions.md`.
- **`blameless` on `FailureDisposition`, and errors that state their own disposition** — `classifyFailure` now reads a `failover` property from the error when it carries one, and a disposition marked `blameless` fails over without counting toward the provider's consecutive-failure threshold. The decision errors use it: a refusal for context size or a protocol without the endpoint no longer marks a healthy provider unhealthy.
- **`fetch` on `HttpRequestOptions` and `DecideOptions`** — a transport for one request instead of the global `fetch`, for a test double or a proxy-aware fetch. `httpRequest` honours it; `decide()` passes it through. The HTTP tap still sees the request.
- **`RouteOptions.signal`** — once the caller's signal has fired, `Router.execute` rethrows the failure instead of trying another provider or counting it against one. `decide()` passes its `signal`.
- **`capabilities` override** on `AIModelConfig`, `ProviderConfig` and `LLMClientOptions` (the provider value wins over the model-level one). `getModelInfo()` reports the list as given for the configured model, ahead of anything the endpoint reports or the name suggests. It is not sent to the server.
- **Every client's `getModelInfo()` reports a declared `contextLength`** — the override was only sent to Ollama as `num_ctx`; the OpenAI-compatible, Anthropic, Google/Vertex and Responses clients now report it too, for the configured model. It is still not sent to those servers, and it does not bound output.
- **`contextLengthSource` and `capabilitiesSource` on `ModelMetadata`** — `'declared' | 'endpoint' | 'inferred' | 'assumed'` (exported as `ModelMetadataSource`), saying where each value came from.
- **`droppedToolCalls` on `LLMChatResponse` (OpenAI-compatible)** — when a tool call is discarded because its arguments do not parse (typically a call the output limit cut off, `finishReason: 'length'`), the response now lists the dropped call names, so a tool loop can tell the model which call was lost.
- **`minLength: 0` opts a required string into accepting `""`** — `coerceAndValidateToolArgs` still treats a blank required string as missing by default (small models send `""` for fields they don't know), but a property that declares `minLength: 0` accepts it, so a tool can take genuinely empty content (an empty file). An absent key is still missing.
- **`tool_call_delta` stream events (OpenAI-compatible)** — while tool-call argument tokens stream in, `chatStream` now yields `{ type: 'tool_call_delta', calls }` with a full snapshot of the raw accumulation (arguments may be empty, partial, or invalid JSON). Use these only for live UI previews. The existing `{ type: 'tool_call' }` event still fires once at finish with normalized, execute-ready calls. Consumers that only handle `tool_call` are unchanged.

## [4.6.0] - 2026-07-22

### Added

- **Pool-aware routing + telemetry (Router)** — providers sharing the same priority now form a **pool** the Router load-balances across (least-inflight selection, `maxConcurrent`, a bounded request queue that spills to the next tier when saturated, and session affinity) instead of always hitting the first node; distinct priorities keep classic ordered-failover semantics. New public surface: `AIModel.getPoolStatus()`, `ProviderStatus.url`, and exported status types.
- **Cold-node liveness preflight (Router)** — configurable probe settings verify a cold provider is actually reachable before dispatch, while the warm dispatch path stays await-free so healthy nodes pay no added latency.
- **`StreamLoopGuard` — client-side runaway protection** — detects degenerate/looping streamed output and aborts, returning `finishReason: 'degeneration'`, so a model that loops for minutes with `max_tokens` omitted no longer hangs the call. Includes repeated-run collapsing and enhanced loop detection; wired into Ollama `chatStream` with abort-signal passthrough.
- **Per-chunk idle-reset stream watchdog** (`http` / OpenAI-compatible) with realistic timeouts — a stalled stream is aborted on inactivity rather than an absolute deadline.
- **First-class `contextLength` option** — mapped to Ollama `num_ctx`; plus `ChatOptions.maxTokens` → Ollama `num_predict`, and a per-call model override via `ChatOptions.model`.
- **Model-metadata caching + accurate context length** — `getModelInfo()` caches per-model metadata and reports the endpoint's real window (vLLM `max_model_len` / llama.cpp `n_ctx_train`), falling back to a conservative 8192 only for budgeting. New `inferOpenAICompatCapabilities()` and Gemma dual-mode helpers (`isGemmaModelId`, `applyGemmaDualModeRequestDefaults`).
- **Cerebras OpenAI-compatible gateway support.**
- **Small-model tool-argument coercion + self-correction** — tolerates and repairs malformed / loosely-typed tool arguments emitted by smaller models.
- **DiffusionGemma native protocol + `<think>` tags** ported into `StandardChatDecoder`.
- **`omitResponseFormat` option** for OpenAI-compatible backends that reject `response_format`.

### Changed

- **Transparent-failover hardening** — connection-failure detection now works across both Bun and Node runtimes, the streaming failover boundary is handled correctly, and dead nodes are skipped fast.

### Fixed

- **Cloud APIs are no longer given an unintended `max_tokens`** — `getModelInfo()`'s conservative 8192 budgeting default had leaked into output-bounding, so every server-managed cloud endpoint received a derived `max_tokens` (~7672). Output-bounding now uses only a *real* advertised window (`resolveKnownContextLength()` never applies the fallback); unknown-window endpoints stay unbounded, per the documented `applyDefaultOutputBound` contract.
- **OpenAI reasoning models on strict hosts** — send `max_completion_tokens` instead of `max_tokens`, omit `temperature`, and force `reasoning_effort: 'none'` when tools are present (strict OpenAI-compatible hosts reject the alternatives).
- **Malformed tool calls** — never surface or re-send tool calls with invalid JSON arguments, and survive malformed tool calls emitted by server-side parsers (OpenAI / Gemma).
- **Gemma channel leakage** — strip leaked channel markers from both thinking and content.
- **Streamed usage** — request `stream_options.include_usage` so token usage is reported on streamed OpenAI-compatible chats.
- **Ollama `keep_alive`** — hoisted out of `options` to the request top level (it was silently ignored while nested).

## [4.5.2] - 2026-06-28

### Fixed

- **`chat_template_kwargs` no longer sent to hosted OpenAI-compatible gateways** — the unified `thinking` flag mapped to vLLM's `chat_template_kwargs.enable_thinking` for *every* OpenAI-compatible endpoint except official `api.openai.com`. Hosted gateways that expose an OpenAI-compatible surface but validate the request body strictly — **Cerebras**, Groq, Fireworks, Together, Mistral, DeepSeek, OpenRouter, xAI — reject the unknown field with `HTTP 400 ("wrong_api_format")`, which broke every call that set `thinking` (including `thinking: false`). The OpenAI-compatible provider now gates this vLLM/SGLang extension behind a `supportsChatTemplateKwargs(url)` strict-host check (`src/thinking.ts`), so it is only sent to endpoints not on the strict-host list (i.e. self-hosted vLLM/Qwen). Self-hosted servers (localhost / custom hosts) are unaffected. Verified live against Cerebras (`gemma-4-31b`).

## [4.5.1] - 2026-06-14

### Added

- **Automatic vLLM tool-calling fallback (OpenAI-compatible provider)** — when a vLLM / OpenAI-compatible server rejects native tool calling (started without `--enable-auto-tool-choice` / `--tool-call-parser`, surfaced as a `"auto" tool choice requires …` 400), the client now transparently retries with a text-level tool protocol: it drops `tools` / `tool_choice`, injects a `<tool_call>name({…})</tool_call>` instruction, and recovers the emitted calls back into `message.tool_calls` (parsing `<tool_call>`, `<function=…>`, and `name(args)` forms). Works for both `chat()` and `chatStream()`, and emits a one-time warning pointing to the flags needed for native parsing. Tool calling now works against vLLM servers not started with tool-parser flags.

### Changed

- **Non-leading system messages normalized for OpenAI-compatible servers** — leading system messages are preserved, but a system message appearing *after* the conversation has started is rewritten to a `user` turn prefixed with `[SYSTEM MESSAGE]` (many OpenAI-compatible servers and chat templates reject mid-conversation system roles). Multimodal content is flattened to text for the prefix.
- **`chat()` / `chatStream()` no longer auto-attach registered tools** — tools are sent only when explicitly passed via `options.tools` (the `chatWithTools` path already does this). Previously every tool added with `registerTool` was attached to plain `chat()` calls. Pass `{ tools }` explicitly (or use `chatWithTools`) if you relied on the old behavior.
- **Minimal published package** — the npm tarball now ships only `dist/` (compiled JS + type declarations) plus `README` / `CHANGELOG` / `LICENSE`. `src/` (tests, demos, test-scripts) is no longer published, and the build no longer emits `.js.map` / `.d.ts.map` (they referenced sources that aren't shipped and triggered "missing source" warnings in consumer bundlers). Package size dropped ~78% (357 kB → 80 kB, 175 → 44 files). Because `src/` is no longer whitelisted, a local demo model cache under `src/` can never bloat the published package again.

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
