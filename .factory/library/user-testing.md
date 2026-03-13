# User Testing Surface

This is a TypeScript library, not a web application. Testing is done via:

## Validation Surface

### Primary: TypeScript Compiler
- **Type checking**: `bun run typecheck`
- **Type inference**: Zod schema → TypeScript type inference must work correctly
- **Evidence**: Compilation succeeds, no type errors

### Secondary: Unit & Integration Tests
- **Unit tests**: `bun test` (mocked HTTP)
- **Integration tests**: `bun test` (mocked HTTP with real payloads)
- **Evidence**: All tests pass

### Tertiary: Smoke Tests (Real API)
- **Ollama**: `http://localhost:11434` (local)
- **LlamaCpp**: `http://blade14:8080/v1` (remote server)
- **Google Gemini**: API key in `.env`
- **Evidence**: Real API responses match schemas

## Testing Concurrency

This is a library with no running services. Tests are:
- **Fast**: Sub-second execution
- **Isolated**: Mocked HTTP, no shared state
- **Safe for parallelism**: Can run all tests concurrently

**Max concurrent validators**: Unlimited (no resource constraints)

## Testing Surface Classification

| Surface | Resource Cost | Max Concurrent |
|---------|---------------|----------------|
| TypeScript compiler | Negligible | Unlimited |
| Unit tests (mocked) | Negligible | Unlimited |
| Smoke tests (real API) | Network I/O | 5 concurrent |

## Test Commands

```bash
# Type check only
bun run typecheck

# All unit tests
bun test

# Specific test pattern
bun test --grep 'structured output'

# Smoke tests (requires API access)
bun run tests/smoke/smoke-test-structured-google.ts
bun run tests/smoke/smoke-test-structured-ollama.ts
OPENAI_API_URL=http://blade14:8080/v1 bun run tests/smoke/smoke-test-structured-openai.ts
```
