# Universal LLM Client Demos

This directory contains various demonstration files for the Universal LLM Client.

## Directory Structure

### `/basic`

Basic usage examples and simple demonstrations.

### `/tools`

Tool calling demonstrations and examples:

- `demo-tool-calling.ts` - Basic tool calling demo
- `complete-tool-demo.ts` - Comprehensive tool calling examples
- `production-tool-demo.ts` - Production-ready tool calling implementation

### `/mcp`

Model Context Protocol (MCP) integration demos:

- `simple-mcp-demo.ts` - Clean MCP MongoDB demo (recommended)
- `mcp-mongodb-demo.ts` - Detailed MCP MongoDB integration
- `working-mcp-demo.ts` - Working MCP implementation example

## Running Demos

From the root directory (`universal-llm-client/`):

```bash
# Tool calling demos
bun run demos/tools/production-tool-demo.ts

# MCP demos (requires MongoDB MCP server)
bun run demos/mcp/simple-mcp-demo.ts

# Basic usage
bun run demos/basic/[demo-file].ts
```

## Requirements

- Node.js/Bun runtime
- Configured Ollama instance (for Ollama provider)
- MongoDB MCP server (for MCP demos)
- API keys for external providers (OpenAI, Google)
