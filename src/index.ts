/**
 * Universal LLM Client - Main Entry Point
 *
 * A high-performance, state-of-the-art universal client for Large Language Models
 * that supports multiple API providers including Ollama and OpenAI-compatible endpoints.
 *
 * @version 1.0.0
 */

// Core classes
export { AIModel } from './universal-llm-client.js';
export { AIModelFactory } from './factory.js';

// Tool utilities
export { ToolBuilder, ToolExecutor } from './tools.js';

// Types and interfaces
export * from './interfaces.js';
