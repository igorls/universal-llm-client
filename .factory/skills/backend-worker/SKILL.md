---
name: backend-worker
description: Worker for implementing TypeScript library features with TDD
---

# Backend Worker

Worker for implementing TypeScript library features. Follows strict TDD (test-driven development).

## When to Use This Skill

Use for implementing features in the universal-llm-client library:
- Core types and interfaces
- Provider implementations
- API surface methods
- Schema validation logic
- Streaming functionality

## Work Procedure

### 1. Understand the Feature
- Read the feature description in `features.json`
- Read `mission.md` for context
- Read `AGENTS.md` for coding conventions
- Identify which assertions in `validation-contract.md` this feature fulfills

### 2. Write Tests First (RED)
- Create a new test file or add to existing test file in `src/tests/`
- Use `bun:test` framework
- Use `describe` and `test`/`it` blocks
- Mock `globalThis.fetch` for HTTP requests
- Write tests that FAIL initially (no implementation yet)
- Run tests to confirm they fail: `bun test --grep 'pattern'`

### 3. Implement (GREEN)
- Implement the minimum code to make tests pass
- Follow existing patterns in the codebase
- Use TypeScript strict typing
- Keep functions small and focused

### 4. Verify and Refactor
- Run tests to confirm they pass
- Run type check: `bun run typecheck`
- Run all tests: `bun test`
- Refactor if needed while keeping tests green

### 5. Document Public APIs
- Add JSDoc comments to public functions/types
- Ensure exports are correct in `index.ts`

## Example Handoff

```json
{
  "salientSummary": "Implemented OpenAI-compatible structured output with response_format. Tests pass, typecheck clean.",
  "whatWasImplemented": "Added response_format support to OpenAI-compatible provider. Implemented schema conversion to JSON Schema. Added validation logic for API responses. Created unit tests for schema conversion and response parsing.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "bun test src/tests/providers/openai.test.ts --grep 'structured'",
        "exitCode": 0,
        "observation": "All 5 structured output tests pass"
      },
      {
        "command": "bun run typecheck",
        "exitCode": 0,
        "observation": "No type errors"
      }
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {
        "file": "src/tests/providers/openai.test.ts",
        "cases": [
          { "name": "converts Zod schema to JSON Schema", "verifies": "VAL-SCHEMA-002" },
          { "name": "sends response_format in request", "verifies": "VAL-PROVIDER-OPENAI-001" },
          { "name": "validates response against schema", "verifies": "VAL-SCHEMA-005" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- **Dependency missing**: A required dependency is not installed and you cannot add it
- **Type errors**: TypeScript errors you cannot resolve
- **Tests won't pass**: After reasonable effort, tests still fail
- **API uncertainty**: Unclear how to integrate with existing code
- **Provider unavailable**: Smoke test requires API that is not accessible
