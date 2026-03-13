---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "Universal LLM Client"
  text: "One API. Every Provider."
  tagline: Transparent failover, structured output, streaming, tool execution, and observability — across OpenAI, Google Gemini, Ollama, and any OpenAI-compatible service.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: API Reference
      link: /api/reference

features:
  - title: 🔄 Provider Failover
    details: Automatic failover across providers with priority ordering, health tracking, cooldowns, and configurable retries.
  - title: 📐 Structured Output
    details: Type-safe responses with Zod schemas. Streaming partial objects, per-provider format negotiation, and zero-dependency JSON Schema conversion via Zod 4.
  - title: 🌊 Streaming
    details: First-class async generator streaming with pluggable decoder strategies for standard chat, interleaved reasoning, and custom formats.
  - title: 🔧 Tool Calling
    details: Autonomous multi-turn tool execution with a fluent ToolBuilder API, automatic argument parsing, and MCP server integration.
  - title: 📊 Observability
    details: Built-in Auditor interface for logging, cost tracking, and behavioral analysis with structured audit events.
  - title: 🖼️ Multimodal
    details: Image input support across providers — base64 data URLs, HTTP URLs, and raw base64 with automatic format conversion.
  - title: 🧠 Thinking Models
    details: Pluggable stream decoders for reasoning tokens, interleaved thinking, and extended output modes.
---
