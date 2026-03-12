# Getting Started

## Installation

```bash
bun add universal-llm-client
# or
npm install universal-llm-client
```

**Optional**: For MCP integration:
```bash
bun add @modelcontextprotocol/sdk
```

---

## Quick Start

### Basic Chat

```typescript
import { AIModel } from 'universal-llm-client';

const model = new AIModel({
    model: 'qwen3:4b',
    providers: [{ type: 'ollama' }],
});

const response = await model.chat([
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is the capital of France?' },
]);

console.log(response.message.content);
// "The capital of France is Paris."
```

## Supported Providers

| Provider | Type | Notes |
|---|---|---|
| **Ollama** | `ollama` | Local or cloud models, NDJSON streaming, model pulling, vision/multimodal |
| **OpenAI** | `openai` | GPT-4o, o3, etc. Also works with OpenRouter, Groq, LM Studio, vLLM |
| **Google AI Studio** | `google` | Gemini models, system instructions, multimodal |
| **Vertex AI** | `vertex` | Same as Google AI but with regional endpoints and Bearer tokens |
| **LlamaCpp** | `llamacpp` | Local llama.cpp / llama-server instances |

## Runtime Support

| Runtime | Version | Status |
|---|---|---|
| **Node.js** | 22+ | ✅ Full support |
| **Bun** | 1.0+ | ✅ Full support |
| **Deno** | 2.0+ | ✅ Full support |
| **Browsers** | Modern | ✅ No stdio MCP, HTTP transport only |
