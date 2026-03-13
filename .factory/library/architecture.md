# Architecture

Architectural decisions and patterns discovered during implementation.

## What Belongs Here

- Key architectural patterns
- Design decisions and rationale
- Provider adapter architecture
- Error handling patterns
- Streaming patterns

---

## Key Architecture Patterns

### 1. Provider Adapter Pattern

Each LLM provider implements `BaseLLMClient`:

```typescript
abstract class BaseLLMClient {
  abstract chat(messages, options?): Promise<LLMChatResponse>;
  abstract chatStream(messages, options?): AsyncGenerator<DecodedEvent>;
  abstract embed(text): Promise<number[]>;
  abstract getModels(): Promise<string[]>;
}
```

**Implementations**:
- `OpenAI-compatible` — OpenAI, OpenRouter, Groq, LM Studio, vLLM, LlamaCpp
- `Ollama` — Ollama native API
- `Google` — Google AI Studio and Vertex AI

### 2. Router with Failover

`AIModel` delegates to `Router` which manages provider priority:

- First provider = highest priority
- On failure, try next provider
- Return first successful response
- Track health for smarter routing

### 3. Structured Output Extension

New structured output support integrates into existing flow:

```
User provides Schema → Convert to provider format → Send to LLM → Validate response → Return typed object
```

**Integration points**:
- `generateStructured(schema, messages, options)` — New method on `AIModel`
- `chat(messages, { output: { schema } })` — Extend `ChatOptions`
- Provider adapters — Add `response_format` / `format` / `responseSchema`

### 4. Error Handling Pattern

```typescript
class StructuredOutputError extends Error {
  rawOutput: string;     // Raw LLM response text
  cause: ZodError;       // Original validation error
}
```

Two modes:
- **Throwing**: `generateStructured()` throws `StructuredOutputError`
- **Result object**: `tryParseStructured()` returns `{ ok: true, value } | { ok: false, error, rawOutput }`

### 5. Streaming Pattern

```typescript
async *generateStructuredStream(schema, messages, options):
  AsyncGenerator<Partial<T>, T, void>
```

- Yield partial validated objects as JSON generates
- Return final complete validated object
- Handle validation errors mid-stream gracefully

---

## Provider-Specific Notes

### OpenAI-Compatible (`src/providers/openai.ts`)

- Uses `response_format.type: 'json_schema'` with strict mode
- OpenAI supports strict schema validation
- Groq/others may only support `json_object` mode

### Ollama (`src/providers/ollama.ts`)

- Uses `format` parameter (JSON Schema object)
- Images extracted to raw base64 in `images` array
- Arguments in tool calls are objects, not strings

### Google (`src/providers/google.ts`)

- Uses `generationConfig.responseMimeType: 'application/json'`
- Uses `generationConfig.responseSchema` for schema
- Some JSON Schema features not supported (strip in conversion)

---

## File Organization

```
src/
├── ai-model.ts          # Public API class
├── router.ts            # Provider failover logic
├── client.ts            # BaseLLMClient abstract class
├── interfaces.ts        # All TypeScript types
├── structured-output.ts # NEW: Schema utilities, validation
├── providers/
│   ├── openai.ts        # OpenAI-compatible implementation
│   ├── ollama.ts        # Ollama implementation
│   └── google.ts        # Google/Gemini implementation
├── stream-decoder.ts    # Streaming decoders
├── tools.ts             # Tool builder utilities
├── auditor.ts           # Observability interface
├── http.ts              # HTTP utilities
└── index.ts             # Public exports
```
