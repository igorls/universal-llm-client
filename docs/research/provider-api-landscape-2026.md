# Provider API Landscape Research (2026)

> **Status update**: The key follow-up recommendations from this research (especially transport flexibility + prompt caching) have been implemented in the same change set as the documentation. See the "Follow-ups Implemented" section at the bottom.

**Goal**: Understand the API shapes, wire formats, and feature surfaces of major AI/LLM inference providers so that `universal-llm-client` can be *truly universal* without creating one dedicated adapter per provider.

**Core Philosophy (confirmed by research)**:
- Do **not** follow the "LiteLLM model" of N thin adapters.
- Instead: **one primary canonical transport** (OpenAI Chat Completions wire format) + **a very small number of high-value native clients** only for protocols that are sufficiently different *and* expose unique capabilities worth preserving.
- The current architecture (OpenAICompatibleClient as workhorse + dedicated GoogleClient + AnthropicClient + OllamaClient) is already well-aligned with reality.

**Date of research**: 2026-06-13  
**Sources**: Official provider docs, API references, comparison articles, SDK compatibility guides, and industry analyses (see end for key links).

---

## Executive Summary

Four wire formats cover the vast majority of commercial and self-hosted LLM usage:

1. **OpenAI Chat Completions** (`/v1/chat/completions`) — The de-facto universal language. Messages + tools + response_format. Streaming deltas.
2. **OpenAI Responses API** (`/v1/responses`) — Newer agentic/stateful evolution (built-in tools, `previous_response_id`, `store`). Still early; Chat Completions remains primary and "indefinitely supported".
3. **Anthropic Messages** (`/v1/messages`) — Content *blocks* (text/tool_use/tool_result/thinking/image), top-level `system`, strong prompt caching + extended thinking.
4. **Google Gemini** (Generative Language / Vertex) — `contents` + `parts`, `systemInstruction`, `functionDeclarations`, `responseSchema`.

**Practical implication for universal-llm-client**:
- Invest heavily in making the **OpenAI-compatible path extremely robust and tolerant** (this covers OpenAI, xAI/Grok, Mistral, DeepSeek, Cohere Compatibility, Perplexity Sonar/Agent compat, Groq, Together, Fireworks, OpenRouter, vLLM, TGI, llama.cpp, LM Studio, many Chinese hosted platforms, etc.).
- Keep/maintain **thin, high-fidelity native clients only for**:
  - Anthropic (unique thinking signatures, prompt caching, computer-use tool types, strict alternation + block model).
  - Google / Vertex (native thinking, grounding, service tiers like flex/priority, regional Vertex auth, schema stripping).
  - Ollama (local ergonomics: NDJSON, ensureReady/pull, model info, native `think` flag).
- Everything else: **Documented as `{ type: 'openai', url: '...', apiKey: '...' }`**.
- Add light ergonomic improvements for common "almost compat" cases (Azure, custom auth headers, Responses alias endpoints).

This approach scales to "truly universal" coverage while keeping the library small, testable, and maintainable.

---

## Provider Families & Compatibility

### 1. OpenAI-Style (Chat Completions) — Primary Target

**Full or near-full compatibility examples** (use `type: 'openai'` + `url`):

| Provider / Service          | Base URL (typical)                  | Notes / Gotchas                                      | Structured Output | Tool Calling | Vision | Recommended |
|-----------------------------|-------------------------------------|------------------------------------------------------|-------------------|--------------|--------|-------------|
| OpenAI (official)           | `https://api.openai.com`            | Native. Strict json_schema, parallel tools.         | Excellent (`json_schema` + strict) | Excellent   | Yes    | Primary     |
| xAI (Grok)                  | `https://api.x.ai/v1`               | Explicitly OpenAI SDK compatible. Also claims some Anthropic compat. | Good             | Good        | Yes    | `openai`    |
| Mistral AI                  | `https://api.mistral.ai/v1`         | Excellent compat layer. Own SDK exists but not required. | Good             | Good        | Yes (some models) | `openai` |
| DeepSeek                    | `https://api.deepseek.com` or `/v1` | 100% OpenAI + even has `/anthropic` compat endpoint. Very low cost. | Good             | Good        | Varies | `openai`    |
| Cohere (Compatibility API)  | Cohere compat endpoint              | Official "use via OpenAI SDK" path. Supports chat, tools, structured, embeddings. | Supported        | Supported   | —      | `openai`    |
| Perplexity (Sonar)          | Perplexity endpoint (compat)        | Sonar = Chat Completions compat. Agent API = Responses compat. Grounded by design. | —                | Limited (search integrated) | — | `openai` (Sonar) |
| Groq                        | Groq OpenAI-compatible              | Ultra-fast inference. Full OpenAI surface.          | Good             | Good        | Yes    | `openai`    |
| Together AI                 | Together OpenAI-compatible          | Many open models + fine-tunes.                      | Good             | Good        | Yes    | `openai`    |
| Fireworks AI                | Fireworks OpenAI-compatible         | Strong on fine-tuning + inference.                  | Good             | Good        | Yes    | `openai`    |
| OpenRouter                  | `https://openrouter.ai/api/v1`      | Router/aggregator. Provider routing via headers sometimes. | Varies by route  | Varies      | Varies | `openai`    |
| vLLM (self-hosted)          | `http://.../v1`                     | Excellent OpenAI server. Some builds need gemma-native protocol handling (already supported). | Via outlines etc.| Good        | Depends on model | `openai` |
| llama.cpp server            | `http://localhost:8080/v1` (or direct) | Treated as openai/llamacpp. Good tool streaming.   | Limited grammar  | Good        | Yes (some) | `openai` or `llamacpp` |
| LM Studio, Ollama (some), others | Local `/v1`                      | Drop-in.                                                | Varies           | Varies      | Varies | `openai`    |

**Key observation**: The list above represents the overwhelming majority of *developer-accessible* inference capacity in 2026 (especially when including aggregators and self-hosted).

### 2. OpenAI Responses API (Emerging Agentic Format)

- Newer surface: `input` arrays (more flexible than messages), built-in tools (`web_search`, `file_search`, `code_interpreter`, `computer_use_preview`, MCP), `previous_response_id`, `store: true` for stateful, better reasoning surfacing.
- OpenAI says Chat Completions will be supported "indefinitely".
- Some providers expose alias endpoints (`/v1/responses`) or full compat (Perplexity Agent API, some mentions for xAI/Azure).
- **Recommendation**: Continue prioritizing Chat Completions for the universal client. Add optional future support or passthrough for Responses-style calls if users need built-in tools from a specific provider. Do not create a separate client.

### 3. Anthropic Messages (Dedicated Client — Worth It)

**Why native client exists and should remain**:
- Content is *always* an array of typed blocks (`text`, `image`, `tool_use`, `tool_result`, `thinking`).
- Tool results go inside user messages as `tool_result` blocks (not top-level `tool` role messages).
- Strict user/assistant alternation with merging logic required.
- Top-level `system` (or system blocks).
- Distinct streaming: `content_block_start` / `delta` (text_delta, input_json_delta, thinking_delta, signature_delta) / `stop`.
- Unique high-value features:
  - Extended thinking + `signature` (must be echoed for multi-turn in some cases).
  - Prompt caching (`cache_control` on blocks or system).
  - Stronger "computer use" / agent tool types in newer Claude versions.
  - Native structured output enforcement maturing (`output_config` / schema in recent Claude 4.x).
- Auth: `x-api-key` + `anthropic-version` header (not Bearer).
- The existing `AnthropicClient` correctly handles block conversion, tool_use ↔ tool_calls, thinking surfacing, and alternating-message cleanup. Good.

**Status**: Code is present (`src/providers/anthropic.ts`) but **under-documented**. Not listed in main README supported providers table or providers.md matrix.

### 4. Google Gemini / Vertex (Dedicated Client — Worth It)

**Why native**:
- `contents` / `parts` model (text, inlineData for vision/audio, functionCall/functionResponse).
- `systemInstruction` separate (Gemma special-cases by prepending).
- Tool definitions as `functionDeclarations` (different shape).
- Structured output via `responseMimeType: 'application/json'` + `responseSchema` (requires stripping unsupported JSON Schema keywords — already implemented with `stripUnsupportedFeatures`).
- Native "thinking" / `thinkingConfig` + `thoughtsTokenCount` in usage (different from content reasoning).
- Vertex AI: Bearer token + regional endpoint construction + project/location in path.
- Service tiers: `service_tier: FLEX | PRIORITY` (cost/latency tradeoffs) — surfaced via response header.
- Grounding / search integration in some configs.
- The `GoogleClient` already handles Vertex vs AI Studio URLs, flex retry logic, thought signatures for Gemini 3.x function calling, Gemma system prompt folding, and schema stripping.

### 5. Amazon Bedrock

- **Old way**: `InvokeModel` — model-specific payloads (hell for multi-model code).
- **Modern way**: **Converse API** (recommended) — unified conversational interface + `toolConfig`.
  - Messages with content blocks (text, toolUse, toolResult — similar spirit to Anthropic).
  - `system` as array of text blocks.
  - `inferenceConfig`, `toolConfig`.
  - Supports streaming (`converseStream`).
  - Structured output often achieved by defining a tool whose schema *is* the desired output (or model-specific features).
- Not wire-compatible with OpenAI Chat Completions.
- Many models on Bedrock are Anthropic Claude or Meta Llama (so you get their strengths under the Converse envelope).

**Recommendation**: Do **not** add a native Bedrock client in the core library at this time. 
- Users who want Bedrock + failover can front it with an OpenAI-compatible gateway (many exist) or use the library's `openai` type against a Bedrock-compatible proxy.
- Direct Converse is valuable for pure-AWS enterprise stacks but is better served by AWS SDKs + thin wrappers or tools like LiteLLM when multi-provider is needed.
- If strong demand appears, a very thin `bedrock` provider using the Converse shape (translating our canonical tools/messages) could be added later — but it would be similar effort to the Anthropic one.

### 6. Azure OpenAI Service

- Wire format: Extremely close to OpenAI Chat Completions (and now Responses).
- Major differences are **transport/auth/URL**:
  - URL pattern: `https://{your-resource}.openai.azure.com/openai/deployments/{deployment-name}/chat/completions?api-version=2024-10-21` (or later).
  - `model` in body is often ignored or must match deployment; the path segment is the deployment ID.
  - Auth: `api-key: <key>` header (or Azure AD `Authorization: Bearer <token>`).
  - Some Azure-specific extensions (Azure AI Search integration via `dataSources`, etc.).
- Responses API is also being rolled out on Azure.

**Current support**: Users can sometimes hack by providing a fully-formed `url` (including query) and overriding headers, but `buildHeaders` in `http.ts` hardcodes `Authorization: Bearer`.
The OpenAICompatibleClient constructor forces `/v1` suffix.

**Recommendations for better Azure ergonomics** (low cost, high value):
- Extend `ProviderConfig` / `LLMClientOptions` with optional `headers?: Record<string,string>`, `authStyle?: 'bearer' | 'api-key' | 'custom'`, or a `queryParams` mechanism.
- Or add a dedicated `azure` type (thin wrapper around OpenAICompatibleClient that adjusts URL construction + header strategy). This is still "not one adapter per provider" — it's one for a major cloud surface.
- Document the exact pattern today.

### 7. Self-Hosted & Local Servers

- **Ollama**: Dedicated client (good). NDJSON streaming, `/api/chat`, `think` flag, base64 images, `/api/show` for metadata, pull support.
- **llama.cpp / llama-server**: OpenAI compat (or its own). Library treats as `llamacpp` → OpenAICompatibleClient.
- **vLLM**: Excellent OpenAI server. Special "gemma diffusion native channel protocol" support already exists for certain builds.
- **TGI (Text Generation Inference)**, **LM Studio**, **Oobabooga**, etc.: Generally OpenAI compat when enabled.
- **Local structured output**: Often relies on grammar/JSON mode in the engine rather than API-level `response_format.json_schema`. The library still sends the schema where supported and does client-side validation via Router.

---

## Key API Dimension Comparison

### Messages / Roles / Multimodal

- **OpenAI compat**: `system` | `user` | `assistant` | `tool`. Content: string or `[{type:'text'|'image_url', ...}]`.
- **Anthropic**: Only `user` | `assistant` in the messages array. `system` is top-level. Content always array of blocks. Tool results as `tool_result` *inside* a user message.
- **Google**: `user` | `model` | `function`. `systemInstruction` separate. Parts array (text, inlineData, functionCall, functionResponse). Thought signatures on parts for Gemini 3+.
- **Bedrock Converse**: Similar block style to Anthropic for supported models.

**Library approach**: Internal canonical is OpenAI-ish (with `tool` role + `tool_calls` + `tool_call_id`). Each native client does the translation (Anthropic and Google do significant work here; already implemented).

### Tool / Function Calling

All major ones support it in 2026.

- OpenAI: `tools: [{type:'function', function:{name, description, parameters}}]`, `tool_choice`, streamed `tool_calls` deltas with `index`.
- Anthropic: `tools` with `input_schema`, responses emit `tool_use` blocks, results as `tool_result` blocks. Streaming uses `input_json_delta`.
- Google: `tools: [{functionDeclarations: [...] }]`, `toolConfig`, parts contain `functionCall` / `functionResponse`. Thought signatures important for some models.
- Converse (Bedrock): `toolConfig` with `toolSpec`, `toolUse` / `toolResult` content blocks.

**Library**: `LLMToolDefinition`, `LLMToolCall` (with optional `thoughtSignature`). Normalization of IDs and empty `{}` args is done in clients. `chatWithTools` autonomous loop is provider-agnostic (in Base + Router).

Good convergence here.

### Structured Output / JSON Enforcement

- OpenAI: `response_format: {type: 'json_schema', json_schema: {name, schema, strict?}}`. Constrained decoding.
- Google: `responseMimeType + responseSchema` (schema subset; library strips `pattern`, length/min/max numeric, `additionalProperties`, etc. — client-side validation still runs).
- Ollama: `format: 'json'` or `format: {schema object}` (grammar-backed on good models).
- Anthropic: Maturing native schema support (output_config / strict on tools in newer versions). Previously relied more on prompting + client validation.
- Many OpenAI-compat servers: Partial or none (rely on prompting or engine-level constrained decoding like Outlines/vLLM). Library always does final Zod/validator pass in Router.

**Library strength**: Centralized validation + best-effort provider constraint. This is the correct split.

### Streaming

- OpenAI compat: SSE, `data: {...}` with `delta.content`, `delta.tool_calls[]` (indexed accumulation needed), final `usage` sometimes on last chunk or separate.
- Ollama: NDJSON (each line a full `OllamaResponse` chunk). Has `thinking` and `content` fields.
- Google: SSE with `data: {candidates[0].content.parts[], usageMetadata}`. Library accumulates tools across parts.
- Anthropic: Rich typed SSE events (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`, `thinking_delta`, `signature_delta`).

**Library**: `parseSSE` + `parseNDJSON` + per-client accumulation + pluggable `StreamDecoder` (passthrough / standard-chat / interleaved-reasoning). Gemma diffusion special handling already present. Good.

### Auth & Endpoint Construction

Varies enough that a single `buildHeaders` + simple URL suffix doesn't cover all:

- Bearer token (most OpenAI-compat, Vertex).
- `x-api-key` + version header (Anthropic).
- `api-key` header + `?api-version=` query + deployment-in-path (Azure).
- Key in query string (old Google AI Studio style — library handles via URL).

Current code handles the extremes via per-client header builders and URL logic. Room to make the compat path more configurable.

### Reasoning / Thinking / "Invisible" Tokens

- Google: `thinkingConfig`, separate `thoughtsTokenCount`, thinking text may or may not be in visible parts depending on model/config.
- Anthropic: `thinking` content blocks + `signature`.
- Ollama: `message.thinking` field (when `think: true`).
- Some OpenAI-compat / newer models: special tokens, `<think>` tags, or extra fields.
- Library: `DecodedEvent {type: 'thinking'}`, `response.reasoning`, `usage.reasoningTokens`. Decoders (interleaved-reasoning) help surface `<think>` etc.

This area is still evolving; the abstraction is already ahead of most single-provider clients.

---

## Recommendations & Action Plan for universal-llm-client

### High Priority (Documentation + Polish)

1. **Document Anthropic properly**:
   - Add to README "Supported Providers" table.
   - Expand `docs/guide/providers.md` with full Anthropic section (structured output notes, prompt caching via `enablePromptCaching`, thinking support, example config).
   - Update support matrix.

2. **"Everything else via OpenAI compat"** section in providers.md + README:
   - Big table or list with exact `{ type: 'openai', url: '...', apiKey }` snippets for xAI, Mistral, DeepSeek, Cohere compat, Groq, Together, Fireworks, OpenRouter, Perplexity Sonar, vLLM, etc.
   - Note any known deltas (e.g., "strict mode may not be supported — set `output: { strict: false }`").

3. **Update support matrix** to include Anthropic (chat/streaming/tools/vision/structured/prompt-caching/thinking).

### Medium Priority (Ergonomics / Edge Cases)

4. **Make OpenAI-compatible path more flexible**:
   - Add to `ProviderConfig`: `headers?: Record<string, string>`, `authHeader?: string` (e.g. override "Authorization"), `authScheme?: 'Bearer' | 'Api-Key' | ''`, `appendPath?: string` or full control over suffix.
   - Or a `customizeRequest` hook (advanced).
   - This lets power users hit exotic compat endpoints or Azure without forking.

5. **Azure-specific convenience** (optional `type: 'azure'` or documented pattern):
   - Thin handling for deployment-in-URL + `api-key` header + `api-version` query param.
   - Low implementation cost (mostly URL/header logic on top of existing OpenAI client).

6. **Prompt caching**:
   - Make `enablePromptCaching?: boolean` (already in ChatOptions) actually work across providers that support it.
   - Anthropic: emit `cache_control` blocks when enabled.
   - Google: support `cachedContent` references.
   - OpenAI-compat: passthrough or document provider-specific `parameters`.

7. **Responses API**:
   - Experiment / document how to target a `/v1/responses` endpoint using the existing `openai` type (if the body is close enough) or add minimal `responseApi: true` flag that changes the endpoint and some field names.
   - Prioritize only if users request built-in tool use from OpenAI/Anthropic/etc.

8. **Better model metadata / capabilities discovery**:
   - Enhance `getModelInfo()` overrides (many providers return rich `/models` or `/api/show` data).
   - Surface context length, vision support, tool support, thinking support where available.

### Low Priority / Future

- Bedrock Converse native client (only if direct AWS usage without gateways becomes a frequent request).
- Full first-class Responses API client (monitor adoption).
- Per-provider rate-limit / usage header parsing into auditor events.

---

## Current Code Strengths (Validated by Research)

- Canonical message/tool format is the right pivot point.
- Router + centralized structured validation is excellent design (failover works even when schema formats differ).
- Per-provider translation is isolated and maintainable.
- Streaming + decoder strategy + tool execution loop are provider-agnostic.
- Gemma diffusion edge case handling shows willingness to support real-world server quirks inside the compat path.

---

## Risks / Watch Items

- Rapid evolution of "thinking" and agentic surfaces (computer use, remote MCP, built-in tools) may require occasional canonical format extensions (e.g., more tool `type`s beyond `function`).
- Some providers are aggressive with safety/refusals that can look like tool-call or JSON failures — good error surfacing and auditor events help.
- Strict JSON schema support is still inconsistent on many compat servers — the library's client-side validation + `strict: false` option is the right mitigation.

---

## Key Sources & Further Reading

- xAI docs: https://docs.x.ai/ (explicit OpenAI compat, base https://api.x.ai/v1)
- Mistral migration: Chat Completions structure matches OpenAI.
- Cohere Compatibility API docs.
- DeepSeek API docs (OpenAI + Anthropic compat endpoints).
- Perplexity docs (Sonar Chat Completions compat + Agent Responses compat).
- AWS Bedrock Converse API reference + tool use guide.
- Azure OpenAI REST reference (deployments path + api-version + api-key).
- Industry comparisons (Fireworks "Best LLM API Providers 2026", MorphLLM pricing matrix, etc.).
- "LLM-Rosetta" arXiv paper (hub-and-spoke between the four main formats).
- Structured output deep-dives (differences in enforcement across OpenAI/Anthropic/Google/Bedrock).

---

## Follow-ups Implemented

The following items from the "Recommendations & Action Plan" have been baked into this change (same PR as the research + docs):

- **Transport flexibility (highest priority)**:
  - `ProviderConfig` now supports `headers`, `queryParams`, `authHeader`, `authPrefix`, and `apiBasePath`.
  - `buildHeaders()` respects `authHeader`/`authPrefix` (enables clean `api-key: xxx` style without Bearer).
  - `OpenAICompatibleClient` no longer blindly appends `/v1`. `apiBasePath: ''` disables it. A new internal `buildUrl()` helper applies `queryParams` to *every* endpoint (`/chat/completions`, `/embeddings`, `/models`, streaming).
  - Full Azure pattern example now works without hacks:
    ```ts
    { type: 'openai', url: 'https://...azure.../deployments/DEP', apiBasePath: '', queryParams: { 'api-version': '...' }, headers: { 'api-key': '...' } }
    ```

- **Prompt caching**:
  - `enablePromptCaching` in `ChatOptions` is now **actually implemented** for Anthropic.
  - When true, the system prompt is sent as a content block with `cache_control: { type: 'ephemeral' }` (the standard high-ROI pattern for Claude).
  - Updated types, logic in `AnthropicClient`, JSDoc, and user docs.
  - Other providers get the flag passed through where possible (via `parameters` / headers) or documented as provider-specific.

- Documentation & discoverability:
  - Anthropic is now first-class in the support matrix, README, and has its own section in providers.md.
  - Large "use the openai type for almost everything" table with copy-paste examples (xAI, Mistral, DeepSeek, Cohere, Groq, etc.).
  - Research doc itself updated with implementation status.

Items intentionally left for later (lower urgency):
- Dedicated `type: 'azure'` sugar (the flexible transport options above make it unnecessary for most people).
- Full Responses API first-class support (current openai compat path + `apiBasePath` already lets you target `/responses` endpoints; built-in tool usage can be added on demand).
- Richer model capability discovery beyond what `getModelInfo` already does per-provider.

## Conclusion

The ecosystem has **converged** far more than it has fragmented. OpenAI Chat Completions (plus its Responses sibling) is the gravitational center. Anthropic and Google maintain distinct but stable high-value protocols. Local servers mostly speak the common tongue.

`universal-llm-client`'s "few native + strong, now even more flexible, compat" design is the correct one for being *truly universal* without an explosion of adapters.

This research + the concrete follow-up implementations (especially transport) significantly advances the goal.

---

*Research + implementation complete.*
