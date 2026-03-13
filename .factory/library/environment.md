# Environment

Environment variables, external dependencies, and setup notes.

## What Belongs Here

- Required environment variables
- External API keys and services
- Dependency setup notes
- Platform-specific notes

## What Does NOT Belong Here

- Service ports/commands (use `.factory/services.yaml`)
- Testing surface info (use `.factory/library/user-testing.md`)

---

## Environment Variables

### Required for Smoke Tests

| Variable | Purpose | Default |
|----------|---------|---------|
| `GOOGLE_API_KEY` | Google AI Studio / Gemini API | Required for Google smoke tests |
| `OLLAMA_URL` | Ollama server URL | `http://localhost:11434` |
| `OPENAI_API_URL` | OpenAI-compatible server URL | `http://blade14:8080/v1` |

### Optional

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI API key (not used in this mission) |
| `OPENROUTER_API_KEY` | OpenRouter API key (not used in this mission) |

---

## External Services

### Ollama (Local)
- **URL**: `http://localhost:11434`
- **Status**: Must be running locally for smoke tests
- **Model**: Any model that supports structured output (e.g., `llama3.2`, `gemma3`)

### LlamaCpp (Remote)
- **URL**: `http://blade14:8080/v1`
- **Status**: Remote server for OpenAI-compatible testing
- **Model**: Configured on server

### Google AI Studio
- **Auth**: API key via `GOOGLE_API_KEY`
- **Status**: Required for Gemini smoke tests

---

## Dependencies

### Runtime Dependencies

| Package | Type | Purpose |
|---------|------|---------|
| `zod` | peer | Schema definition and validation |
| `zod-to-json-schema` | regular | Convert Zod to JSON Schema |

### Development Dependencies

| Package | Purpose |
|---------|---------|
| `bun:test` | Test framework (built-in) |
| `typescript` | Type checking (existing) |

---

## Platform Notes

- **Node.js**: `>=22.0.0` required
- **Bun**: `>=1.0.0` required
- **TypeScript**: `>=5.8.0` (existing)
