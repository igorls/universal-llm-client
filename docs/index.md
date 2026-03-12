---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "Universal LLM Client"
  text: "One Model, Multiple Backends"
  tagline: "Transparent provider failover, streaming tool execution, pluggable reasoning strategies, and native observability."
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: API Reference
      link: /api/reference
    - theme: alt
      text: View on GitHub
      link: https://github.com/igorls/universal-llm-client

features:
  - title: 🔄 Transparent Failover
    details: Priority-ordered provider chain with retries, health tracking, and cooldowns.
  - title: 🛠️ Tool Calling
    details: Register tools once, works across all providers. Autonomous multi-turn execution loop.
  - title: 🌊 Streaming
    details: First-class async generator streaming with pluggable decoder strategies.
  - title: 🧠 Reasoning
    details: Native `<think>` tag parsing, interleaved reasoning, and model thinking support.
  - title: 🔍 Observability
    details: Built-in auditor interface for logging, cost tracking, and behavioral analysis.
  - title: 🤖 MCP Native
    details: Bridge MCP servers to LLM tools with zero glue code.
---
