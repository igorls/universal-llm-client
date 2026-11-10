/**
 * Homepage content. Facts here come from the source, README.md and
 * docs/guide/protocols.md. Change them here and every section follows.
 */

export const repoUrl = 'https://github.com/igorls/universal-llm-client'

export const installCommands = [
    { id: 'npm', command: 'npm install universal-llm-client' },
    { id: 'bun', command: 'bun add universal-llm-client' },
    { id: 'pnpm', command: 'pnpm add universal-llm-client' },
] as const

export const facts = [
    { term: 'Runtime dependencies', detail: 'None' },
    { term: 'Runs on', detail: 'Node 22+, Bun, Deno, browsers' },
    { term: 'License', detail: 'MIT' },
] as const

/* ── Failover demo ───────────────────────────────────────────── */

export type FailureMode = 'ok' | 'http500' | 'http429' | 'stall' | 'unreachable'

/**
 * `stall` is a host that answers the liveness probe and then hangs on the request.
 * `unreachable` is a host that never answers the probe.
 */
export const failureModes: ReadonlyArray<{ id: FailureMode; label: string }> = [
    { id: 'ok', label: 'Healthy' },
    { id: 'http500', label: 'Returns HTTP 500' },
    { id: 'http429', label: 'Returns HTTP 429' },
    { id: 'stall', label: 'Accepts, then stalls' },
    { id: 'unreachable', label: 'Unreachable' },
]

export interface DemoProvider {
    /** Provider id as the router reports it: `${type}-${index}` */
    id: string
    /** Provider type, which is the name the client puts on request and response events */
    type: string
    name: string
    model: string
    /** 1-based line range of this provider in the code sample in docs/index.md */
    lines: readonly [number, number]
    mode: FailureMode
}

export const demoProviders: ReadonlyArray<DemoProvider> = [
    { id: 'google-0', type: 'google', name: 'Google', model: 'model-id', lines: [6, 9], mode: 'http429' },
    { id: 'openai-1', type: 'openai', name: 'OpenRouter', model: 'model-id', lines: [10, 14], mode: 'unreachable' },
    { id: 'ollama-2', type: 'ollama', name: 'Ollama', model: 'local-model', lines: [15, 15], mode: 'ok' },
]

/** Library defaults, from src/router.ts and src/interfaces.ts */
export const routerDefaults = {
    retriesPerProvider: 2,
    timeoutMs: 30_000,
    cooldownMs: 30_000,
    coldProbeTimeoutMs: 2_500,
} as const

/* ── Capabilities ────────────────────────────────────────────── */

export interface Capability {
    id: string
    label: string
    title: string
    summary: string
    points: string[]
    link: { text: string; href: string }
}

export const capabilities: Capability[] = [
    {
        id: 'streaming',
        label: 'Streaming',
        title: 'Streaming as typed events',
        summary:
            'chatStream() is an async generator. Text, reasoning and tool calls arrive as separate event types, so a UI never has to parse tags out of a text stream.',
        points: [
            'Event types: text, thinking and tool_call.',
            'A stalled stream is aborted on inactivity, not on an absolute deadline.',
            'Failover still applies until the first event reaches your code.',
        ],
        link: { text: 'Streaming guide', href: '/guide/streaming' },
    },
    {
        id: 'tools',
        label: 'Tool calling',
        title: 'Tool calling with the loop included',
        summary:
            'Register a tool once and it works on every provider. chatWithTools() runs the call-and-return loop until the model is done and hands back the full execution trace.',
        points: [
            'response.toolExecutions lists every call, its output and its duration.',
            'Loosely typed arguments from small models are coerced and validated against your schema.',
            'Define tools with a plain JSON Schema or the fluent ToolBuilder.',
        ],
        link: { text: 'Tool calling guide', href: '/guide/tools' },
    },
    {
        id: 'structured',
        label: 'Structured output',
        title: 'Structured output from a schema',
        summary:
            'Wrap a Zod schema with fromZod() and get a typed, validated value back. Chat Completions, Gemini and Ollama endpoints receive the schema; Anthropic Messages output is validated client-side.',
        points: [
            'generateStructured() throws on invalid output; tryParseStructured() returns a result object.',
            'generateStructuredStream() yields partial validated objects as the JSON arrives.',
            'A plain JSON Schema with your own validate function works too. Zod is an optional peer dependency.',
        ],
        link: { text: 'Structured output guide', href: '/guide/structured-output' },
    },
    {
        id: 'reasoning',
        label: 'Reasoning',
        title: 'One switch for reasoning',
        summary:
            'Set thinking to true, false or a level, and it is translated to whatever the provider calls it: reasoning_effort, thinkingLevel, budget_tokens or think.',
        points: [
            'Levels: minimal, low, medium, high, xhigh.',
            'The chain of thought comes back on response.reasoning and as thinking stream events.',
            'Override per call, for example to switch thinking off for structured output.',
        ],
        link: { text: 'Reasoning guide', href: '/guide/reasoning' },
    },
    {
        id: 'observability',
        label: 'Observability',
        title: 'Every step is an audit event',
        summary:
            'Give the model an Auditor and it receives each request, response, retry, failover and tool call as a structured event.',
        points: [
            'ConsoleAuditor prints them; BufferedAuditor batches them for your own sink.',
            'Responses report token usage, duration and tokens per second.',
            'getProviderStatus() shows which providers are healthy or cooling down.',
        ],
        link: { text: 'Observability guide', href: '/guide/observability' },
    },
    {
        id: 'mcp',
        label: 'MCP',
        title: 'MCP servers as tools',
        summary:
            'MCPToolBridge connects to MCP servers over stdio or HTTP, discovers their tools and registers them on a model.',
        points: [
            'Requires @modelcontextprotocol/sdk, an optional peer dependency.',
            'In browsers only the HTTP transport is available.',
            'Bridged tools run through the same chatWithTools() loop.',
        ],
        link: { text: 'MCP guide', href: '/guide/tools#mcp' },
    },
]

/* ── Protocol support (docs/guide/protocols.md) ──────────────────
   Compatibility is stated per wire protocol, never per provider or model.
   `types` are the values of a provider's `type` that select the protocol;
   `short` is the column head on narrow screens. */

export type Support = 'yes' | 'no' | string

export const protocolColumns = [
    { name: 'OpenAI Chat Completions', short: 'Chat Completions', types: ['openai', 'llamacpp'] },
    { name: 'Anthropic Messages', short: 'Messages', types: ['anthropic'] },
    { name: 'Gemini', short: 'Gemini', types: ['google', 'vertex'] },
    { name: 'Ollama', short: 'Ollama', types: ['ollama'] },
] as const

export const supportRows: ReadonlyArray<{ feature: string; cells: readonly Support[] }> = [
    { feature: 'Chat', cells: ['yes', 'yes', 'yes', 'yes'] },
    { feature: 'Streaming', cells: ['yes', 'yes', 'yes', 'yes'] },
    { feature: 'Tool calling', cells: ['yes', 'yes', 'yes', 'yes'] },
    // The Anthropic client sends no response schema; the output is validated against the SchemaConfig.
    { feature: 'Structured output', cells: ['yes', 'Validated client-side', 'yes', 'yes'] },
    { feature: 'Vision', cells: ['yes', 'yes', 'yes', 'yes'] },
    { feature: 'Embeddings', cells: ['yes', 'no', 'yes', 'yes'] },
    { feature: 'Native thinking', cells: ['Via decoder', 'yes', 'yes', 'yes'] },
]

/* ── For agent builders (README: For Agent Framework Authors) ── */

export const agentFacts = [
    {
        term: 'Stateless',
        detail: 'No conversation history is stored. Your framework owns memory.',
    },
    {
        term: 'Composable',
        detail: 'Create separate instances for chat, embeddings and vision.',
    },
    {
        term: 'Traceable',
        detail: 'chatWithTools() returns the full tool execution trace.',
    },
    {
        term: 'Context-aware',
        detail: 'getModelInfo() reports the context length of the model being served.',
    },
    {
        term: 'Observable',
        detail: 'The Auditor is a system bus for cost tracking and behavioural scoring.',
    },
] as const
