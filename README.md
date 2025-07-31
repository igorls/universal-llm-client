# Universal LLM Client

A high-performance, state-of-the-art universal client for Large Language Models that supports multiple API providers including Ollama, OpenAI-compatible endpoints, and Google Generative AI.

## ✨ Features

- 🚀 **Built with undici** for maximum performance and modern Node.js features
- 🔄 **Connection pooling** and keep-alive for optimal resource usage
- 🔁 **Automatic retry logic** with exponential backoff
- 🌊 **Streaming support** for real-time responses (all providers)
- 🔗 **Embeddings support** for vector operations
- 🛡️ **Comprehensive error handling** and timeout management
- 🔧 **Server health checking** and model capability detection
- 📦 **Auto-download of models** (Ollama)
- 🔑 **API key authentication** support (OpenAI-compatible & Google)
- 🏷️ **Model type validation** (chat vs embedding)
- 🧠 **Google Generative AI** integration with custom streaming parser
- 🎯 **Automatic model type inference** from model names
- 🎭 **Smart system prompt handling** - Gemini uses systemInstruction, Gemma embeds in user messages
- 🔍 **Model family detection** - Automatically applies correct prompt formatting per Google's docs

## 🔧 Supported API Types

- **Ollama** (http://localhost:11434) - Local models with auto-download
- **OpenAI API** (https://api.openai.com/v1) - Official OpenAI models
- **LM Studio** (http://localhost:1234/v1) - Local OpenAI-compatible server
- **Google Generative AI** (https://generativelanguage.googleapis.com) - Gemini models
- **Any OpenAI-compatible API** - Custom endpoints

## 📦 Installation

```bash
# Install the package from npm
npm install @aura-companion/universal-llm-client

# Or install dependencies for development
npm install undici
```

## 🚀 Quick Start

### Basic Usage

```typescript
import { AIModel, AIModelFactory } from '@aura-companion/universal-llm-client';

// Method 1: Direct instantiation
const model = new AIModel({
  model: 'gemma3:4b-it-qat',
  url: 'http://localhost:11434',
  apiType: 'ollama',
  modelType: 'chat'
});

await model.ensureReady();
const response = await model.chat([
  {role: 'user', content: 'Hello!'}
]);

// Method 2: Factory methods (recommended)
const ollamaChatModel = AIModelFactory.createOllamaChatModel('gemma3:4b-it-qat');
const ollamaEmbeddingModel = AIModelFactory.createOllamaEmbeddingModel('snowflake-arctic-embed2:latest');
const googleChatModel = AIModelFactory.createGoogleChatModel('gemini-1.5-flash', 'YOUR_API_KEY');
```

### Complete Setup

```typescript
import { AIModelFactory } from '@aura-companion/universal-llm-client';

// Create both chat and embedding models for multiple providers
const setup = AIModelFactory.createCompleteSetup({
  ollama: {
    chatModel: 'gemma3:4b-it-qat',
    embeddingModel: 'snowflake-arctic-embed2:latest',
    url: 'http://localhost:11434'
  },
  openai: {
    chatModel: 'google/gemma-3-4b',
    embeddingModel: 'text-embedding-snowflake-arctic-embed-l-v2.0',
    url: 'http://localhost:1234/v1'
  },
  google: {
    chatModel: 'gemini-1.5-flash',
    apiKey: 'YOUR_GOOGLE_API_KEY'
  }
});

// Use the models
const chatResponse = await setup.ollama.chat.chat([
  {role: 'user', content: 'What is TypeScript?'}
]);

const embedding = await setup.ollama.embedding.embed('Text to embed');

const googleResponse = await setup.google.chat.chat([
  {role: 'user', content: 'Explain quantum computing'}
]);
```

### Google Models System Prompt Support

The Universal LLM Client now provides intelligent system prompt handling for Google's model families:

#### Gemini Models (e.g., `gemini-1.5-flash`, `gemini-2.5-flash-lite`)
- Uses Google's official `systemInstruction` parameter
- System messages are extracted and sent separately from conversation content
- Follows official Gemini API documentation

#### Gemma Models (e.g., `gemma-3-4b-it`, `gemma-3-27b-it`)
- Embeds system instructions directly in the first user message
- Follows Gemma's documented prompt structure requirements
- Automatic detection and proper formatting

```typescript
// Works correctly for both model families
const geminiModel = AIModelFactory.createGoogleChatModel('gemini-1.5-flash', 'YOUR_API_KEY');
const gemmaModel = AIModelFactory.createGoogleChatModel('gemma-3-27b-it', 'YOUR_API_KEY');

// Both handle system prompts optimally according to their specifications
const messages = [
  { role: 'system', content: 'You are a helpful cooking assistant.' },
  { role: 'user', content: 'How do I make scrambled eggs?' }
];

const geminiResponse = await geminiModel.chat(messages); // Uses systemInstruction
const gemmaResponse = await gemmaModel.chat(messages);   // Embeds in user message
```

### Streaming Responses

```typescript
// Works with all providers (Ollama, OpenAI-compatible, Google)
const streamingGenerator = chatModel.chatStream([
  {role: 'user', content: 'Tell me a story'}
]);

for await (const chunk of streamingGenerator) {
  process.stdout.write(chunk);
}

// Google streaming example
const googleModel = AIModelFactory.createGoogleChatModel('gemini-1.5-flash', 'YOUR_API_KEY');
const googleStream = googleModel.chatStream([
  {role: 'user', content: 'Write a poem about AI'}
]);

for await (const chunk of googleStream) {
  process.stdout.write(chunk);
}
```

## � Package Structure

The Universal LLM Client is professionally packaged with the following exports:

```typescript
// Main exports
import { AIModel, AIModelFactory } from '@aura-companion/universal-llm-client';

// Subpath exports for advanced usage
import { AIModelFactory } from '@aura-companion/universal-llm-client/factory';
import { LLMChatMessage, AIModelOptions } from '@aura-companion/universal-llm-client/interfaces';  
import { ToolBuilder } from '@aura-companion/universal-llm-client/tools';
```

### Build System

The package uses a professional TypeScript build system:

- **TypeScript Compilation**: Strict mode with NodeNext module resolution
- **Declaration Files**: Full TypeScript definitions included
- **Source Maps**: Complete debugging support
- **ESM Modules**: Modern ES module format
- **Cross-Platform**: Works on Windows, macOS, and Linux

```bash
# Development commands
npm run build          # Clean build with TypeScript compilation
npm run dev           # Watch mode for development
npm run clean         # Remove build artifacts
npm run typecheck     # Type checking without compilation
npm run lint          # Strict type checking
```

## �📝 API Reference

### AIModel Class

#### Constructor Options

```typescript
interface AIModelOptions {
  model: string;                    // Model name
  modelType?: 'chat' | 'embedding'; // Auto-detected if not specified
  url: string;                      // API endpoint URL
  apiType: 'ollama' | 'openai' | 'google'; // API provider type
  defaultParameters?: Record<string, any>; // Default request parameters
  timeout?: number;                 // Request timeout (default: 30000ms)
  retries?: number;                // Retry attempts (default: 3)
  apiKey?: string;                 // API key for OpenAI-compatible APIs & Google
  debug?: boolean;                 // Enable debug logging (default: false)
}
```

#### Methods

- `ensureReady()` - Ensures model is available, downloads if necessary
- `chat(messages, parameters?)` - Send chat completion request
- `embed(text)` - Generate embeddings for text
- `chatStream(messages, parameters?)` - Stream chat responses
- `getServerInfo()` - Get server health and information
- `supportsEmbeddings()` - Check if model supports embeddings
- `dispose()` - Clean up resources

### AIModelFactory Class

Static factory methods for easy model creation:

- `createOllamaChatModel(model, url?, options?)`
- `createOpenAIChatModel(model, url?, options?)`
- `createGoogleChatModel(model, apiKey, options?)`
- `createOllamaEmbeddingModel(model?, url?, options?)`
- `createOpenAIEmbeddingModel(model?, url?, options?)`
- `createCompleteSetup(options?)` - Creates complete setup with multiple providers

## 🧪 Testing & Examples

### Project Structure

The project is now organized with examples and demos in dedicated folders:

- `/demos` - Comprehensive demonstrations and examples
  - `/basic` - Basic usage examples
  - `/tools` - Tool calling demonstrations
  - `/mcp` - Model Context Protocol (MCP) integration demos
- `/tests` - Test files
- `/debug` - Debug utilities and troubleshooting files

### Running Examples

```bash
# Install the package
npm install @aura-companion/universal-llm-client

# Development scripts (for contributors)
npm run build          # Build the TypeScript project
npm run dev           # Watch mode for development
npm test              # Run the test suite
npm run test:coverage # Run tests with coverage
npm run lint          # Type check with strict mode

# Basic examples (if running from source)
node demos/basic/[example-file].js

# Tool calling demos (if running from source)  
node demos/tools/production-tool-demo.js

# MCP integration demos (requires MongoDB MCP server)
node demos/mcp/simple-mcp-demo.js

# Run tests (if running from source)
node tests/test-tool-calling.js
```

### Core Features Testing

```bash
# Install and use the package
npm install @aura-companion/universal-llm-client

# Development testing (for contributors)
npm test                    # Run the full test suite
npm run test:coverage      # Run tests with coverage report
npm run test:watch         # Watch mode for testing

# If running from source:
node index.js

# Test Google system prompt improvements
node tests/test-google-system-prompt-comprehensive.js

# Test specific Google streaming with system prompts
node tests/test-google-streaming-enhanced.js

# Demo the system prompt improvement
node tests/test-system-prompt-improvement-demo.js

# Test system message positioning behavior
node tests/test-system-message-positions.js

# Test advanced tool calling
node tests/test-advanced-tools.js
```

## 🆕 Recent Updates

### Version 3.0 Features (Latest - Professional NPM Package)

- **Professional NPM Package**: Now available as `@aura-companion/universal-llm-client` on npm
- **TypeScript Build System**: Professional build pipeline with strict mode and NodeNext module resolution
- **ESM Module Support**: Pure ES modules with proper exports and subpath exports
- **Comprehensive Test Suite**: 18 tests with Node.js native test runner and MockAgent integration
- **Debug Mode Support**: Conditional logging system for development and troubleshooting
- **Build Pipeline**: Automated TypeScript compilation with declaration files and source maps
- **NPM Ready**: Professional package structure ready for npm publication

### Version 2.1 Features

- **Enhanced Google System Prompt Support**: Intelligent handling for both Gemini and Gemma model families
- **Automatic Model Family Detection**: Code automatically detects and applies correct prompt formatting
- **Gemini Optimization**: Uses Google's official `systemInstruction` parameter for optimal performance
- **Gemma Compliance**: Embeds system instructions in user messages following Google's documentation
- **Comprehensive Testing**: Added extensive test suite for Google models system prompt scenarios
- **Position-Independent System Messages**: System messages are processed from any position in conversation array
- **Global System Context**: All system messages are combined and apply to entire conversation regardless of placement

### Version 2.0 Features

- **Google Generative AI Support**: Full integration with Google's Gemini models
- **Enhanced Streaming**: Custom JSON parser for Google's streaming format
- **Modular Architecture**: Clean separation into multiple files for better maintainability
- **Automatic Model Type Detection**: Smart inference of chat vs embedding models
- **Improved Error Handling**: Provider-specific error handling and retry logic
- **Performance Optimizations**: Enhanced connection pooling and timeout management

### System Prompt Best Practices

#### For Google Models

```typescript
// ✅ Good: The client automatically handles model-specific formatting
const messages = [
  { role: 'system', content: 'You are a helpful assistant that provides concise answers.' },
  { role: 'user', content: 'What is TypeScript?' }
];

// Gemini models: Uses systemInstruction parameter automatically
const geminiResponse = await geminiModel.chat(messages);

// Gemma models: Embeds system prompt in user message automatically  
const gemmaResponse = await gemmaModel.chat(messages);
```

#### Multiple System Messages

```typescript
// Multiple system messages are automatically combined
const messages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'system', content: 'Always provide step-by-step explanations.' },
  { role: 'user', content: 'How do I bake a cake?' }
];

// Both system messages will be combined appropriately for each model family
const response = await model.chat(messages);
```

#### System Message Position Behavior

**Important**: The Universal LLM Client processes ALL system messages regardless of their position in the conversation array.

```typescript
// ✅ All of these work - system messages are processed from ANY position
const messages = [
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi there!' },
  { role: 'system', content: 'Be more formal from now on.' },  // Middle position
  { role: 'user', content: 'What is JavaScript?' },
  { role: 'system', content: 'Use technical terminology.' }    // End position
];

// ALL system messages are combined and applied to the entire conversation context
const response = await model.chat(messages);
```

**Key Behaviors:**

- **Position Independent**: System messages work from beginning, middle, or end
- **Cumulative Effect**: Multiple system messages are combined using `\n\n`
- **Global Context**: All system messages apply to the entire conversation
- **Gemma Models**: ALL system messages are embedded in the FIRST user message
- **Gemini Models**: ALL system messages are combined into the `systemInstruction` parameter

**Recommendations:**

- 🏆 **Best Practice**: Place system messages at the beginning for clarity
- ⚠️ **Mid-conversation**: System messages in the middle are treated as global instructions, not contextual changes
- 🔄 **Multiple Systems**: Use multiple system messages to build complex instructions
- 📝 **Documentation**: Make it clear to users that system messages are global, not temporal

### Debug Mode

The Universal LLM Client includes a comprehensive debug mode for development and troubleshooting:

```typescript
import { AIModel } from '@aura-companion/universal-llm-client';

// Enable debug mode during initialization
const model = new AIModel({
  model: 'gpt-3.5-turbo',
  apiType: 'openai',
  apiKey: 'your-api-key',
  url: 'http://localhost:1234',
  debug: true  // Enable debug logging
});

// Debug messages will show:
// 🔍 [AIModel Debug] Created new undici agent for HTTP requests
// 🔍 [AIModel Debug] Using external agent for HTTP requests
// 🔍 [AIModel Debug] Making request to: http://localhost:1234/v1/chat/completions
```

Debug mode provides detailed logging for:

- HTTP agent creation and lifecycle
- Request/response details
- Model inference and validation
- Error handling and retries

## 🔧 Configuration

### Google API Setup

To use Google Generative AI models, you need an API key:

1. Visit [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Create a new API key
3. Use it in your code:

```typescript
const googleModel = AIModelFactory.createGoogleChatModel('gemini-1.5-flash', 'YOUR_API_KEY');
```

### Recommended Models

#### Chat Models

- **Ollama**: `gemma3:4b-it-qat`, `llama3.2:3b`, `qwen2.5:7b`
- **LM Studio**: `google/gemma-3-4b`, `microsoft/DialoGPT-medium`
- **Google Gemini**: `gemini-1.5-flash`, `gemini-1.5-pro`, `gemini-2.5-flash-lite`
- **Google Gemma**: `gemma-3-4b-it`, `gemma-3-27b-it`, `gemma-3-9b-it`

#### Embedding Models

- **Ollama**: `snowflake-arctic-embed2:latest`, `nomic-embed-text`
- **LM Studio**: `text-embedding-snowflake-arctic-embed-l-v2.0`
- **Google**: *(Embedding support coming soon)*

### Performance Tuning

The client uses undici with optimized settings:

- Connection pooling (256 connections)
- HTTP pipelining (10 requests)
- Keep-alive timeout (30s)
- Automatic retry with exponential backoff

## � Troubleshooting

### Google Models

#### "Developer instruction is not enabled" Error

This error occurs when trying to use system prompts with Gemma models in the old way. The Universal LLM Client now automatically handles this by embedding system instructions in user messages for Gemma models.

```typescript
// ❌ Old approach (would fail for Gemma models)
// Manual systemInstruction parameter

// ✅ New approach (works for all Google models)
const messages = [
  { role: 'system', content: 'Your system instruction here' },
  { role: 'user', content: 'Your question here' }
];
const response = await model.chat(messages); // Automatically handled correctly
```

#### Model Family Detection

The client automatically detects model families based on model names:

- Models containing "gemma" → Gemma family (embedded system prompts)
- Other Google models → Gemini family (systemInstruction parameter)

#### System Message Positioning

**Q: Do system messages need to be at the beginning of the conversation?**

A: No, but it's recommended. The Universal LLM Client processes ALL system messages regardless of position:

```typescript
// All these system messages will be processed
const messages = [
  { role: 'system', content: 'You are helpful.' },        // Beginning ✅
  { role: 'user', content: 'Hello' },
  { role: 'system', content: 'Be concise.' },             // Middle ✅  
  { role: 'assistant', content: 'Hi!' },
  { role: 'system', content: 'Use emojis.' }              // End ✅
];
```

**Important**: All system messages are combined and treated as **global conversation context**, not as temporal instructions that apply only from their position forward.

**Q: Why is my mid-conversation system message affecting the entire response?**

A: This is the intended behavior. System messages are treated as global instructions that apply to the entire conversation context, regardless of where they appear in the message array.

## �🛡️ Error Handling

The client includes comprehensive error handling:

- Model type validation
- Network retry logic
- Timeout management
- Graceful fallbacks

## 📄 License

MIT License - see LICENSE file for details.
