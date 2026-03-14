<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

/* ── Reactive state ──────────────────────────────────── */
const activeTab = ref(0)
const copied = ref(false)
const observer = ref<IntersectionObserver | null>(null)

/* ── Inline SVG Icons (Lucide-style, 24x24 viewBox) ── */
const icons = {
    // Providers
    ollama:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
    openai:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    google:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9z"/></svg>',
    cloud:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
    zap:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    shuffle:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
    // Features
    repeat:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    braces:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/></svg>',
    waves:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/></svg>',
    wrench:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    activity:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    plug:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8z"/></svg>',
    // UI
    copy:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    arrowRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
    book:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    chevDown:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
}

/* ── Provider data ───────────────────────────────────── */
const providers = [
    { icon: icons.ollama,  name: 'Ollama',      desc: 'Local models' },
    { icon: icons.openai,  name: 'OpenAI',      desc: 'GPT-5.4' },
    { icon: icons.google,  name: 'Google AI',   desc: 'Gemini' },
    { icon: icons.cloud,   name: 'Vertex AI',   desc: 'Enterprise' },
    { icon: icons.zap,     name: 'LlamaCpp',    desc: 'Native' },
    { icon: icons.shuffle, name: 'OpenRouter',  desc: 'Gateway' },
]

/* ── Feature cards data ──────────────────────────────── */
const features = [
    {
        icon: icons.repeat,
        name: 'Transparent Failover',
        desc: 'Priority-ordered provider chain with retries, health tracking, and cooldowns. Your code never sees the switchover.',
        visual: `Google  →  OpenRouter  →  Ollama
  ✗ 500     ✗ timeout     ✓ 200 ok
  ╰── retry 2x ──╯  ╰── seamless ──╯`,
    },
    {
        icon: icons.braces,
        name: 'Structured Output',
        desc: 'Zod 4 schemas in, typed JSON out. Streaming partial objects, provider-aware format negotiation, and native toJSONSchema.',
        visual: `z.object({       →  { name: "Ada",
  name: z.string()      age: 36,
  age:  z.number()      email: "..." }
})               →  TypeScript inferred ✓`,
    },
    {
        icon: icons.waves,
        name: 'First-Class Streaming',
        desc: 'Async generator streaming with pluggable decoder strategies — standard chat, interleaved reasoning, and custom formats.',
        visual: `for await (event of chatStream()) {
  text:     "The answer is..."
  thinking: "[analyzing data]"
  tool:     get_weather({city})
}`,
    },
    {
        icon: icons.wrench,
        name: 'Autonomous Tool Calling',
        desc: 'Register once, works everywhere. Fluent ToolBuilder, auto argument parsing, and MCP server integration in one API.',
        visual: `LLM ──→ get_weather({city:"Tokyo"})
  ↑               │
  ╰── { temp: 22, ──╯
       sunny: true }`,
    },
    {
        icon: icons.activity,
        name: 'Native Observability',
        desc: 'Built-in Auditor interface — every request, response, retry, failover, and tool call is a structured, flushable event.',
        visual: `▸ REQUEST  [google] gemini-3.1-flash
▸ RETRY    [google] 500 → attempt 2
▸ FAILOVER [openai] openrouter
▸ RESPONSE [openai] 1.2s 84 tokens`,
    },
    {
        icon: icons.plug,
        name: 'MCP Native',
        desc: 'Bridge MCP servers to LLM tools with zero glue code. Stdio and HTTP transports, auto tool discovery, seamless execution.',
        visual: `MCPToolBridge.connect({
  filesystem: { command: 'npx...' }
  weather:    { url: 'https://...' }
})  → registerTools(model) ✓`,
    },
]

/* ── Code tab examples (pre-formatted HTML) ──────────── */
const k = 'syn-kw'
const s = 'syn-str'
const f = 'syn-fn'
const c = 'syn-cm'
const n = 'syn-num'
const t = 'syn-type'
const p = 'syn-prop'

function S(cls: string, text: string) { return `<span class="${cls}">${text}</span>` }

const codeTabs = [
    {
        label: 'Basic Chat',
        filename: 'chat.ts',
        html: [
            `${S(k,'import')} { ${S(t,'AIModel')} } ${S(k,'from')} ${S(s,"'universal-llm-client'")}`,
            ``,
            `${S(k,'const')} model = ${S(k,'new')} ${S(t,'AIModel')}({`,
            `  model: ${S(s,"'gemini-3.1-flash'")},`,
            `  providers: [`,
            `    { type: ${S(s,"'google'")}, apiKey: ${S(p,'process.env.')}GOOGLE_KEY },`,
            `    { type: ${S(s,"'ollama'")} },`,
            `  ],`,
            `})`,
            ``,
            `${S(k,'const')} response = ${S(k,'await')} model.${S(f,'chat')}([`,
            `  { role: ${S(s,"'user'")}, content: ${S(s,"'Hello!'")} }`,
            `])`,
        ].join('\n'),
    },
    {
        label: 'Streaming',
        filename: 'stream.ts',
        html: [
            `${S(k,'for await')} (${S(k,'const')} event ${S(k,'of')} model.${S(f,'chatStream')}(messages)) {`,
            `  ${S(k,'if')} (event.type === ${S(s,"'text'")}) {`,
            `    process.stdout.${S(f,'write')}(event.content)`,
            `  } ${S(k,'else if')} (event.type === ${S(s,"'thinking'")}) {`,
            `    ${S(c,'// Model reasoning tokens')}`,
            `    console.${S(f,'log')}(${S(s,"'[think]'")}, event.content)`,
            `  }`,
            `}`,
        ].join('\n'),
    },
    {
        label: 'Tool Calling',
        filename: 'tools.ts',
        html: [
            `model.${S(f,'registerTool')}(`,
            `  ${S(s,"'get_weather'")},`,
            `  ${S(s,"'Get current weather'")},`,
            `  { type: ${S(s,"'object'")}, properties: { city: { type: ${S(s,"'string'")} } } },`,
            `  ${S(k,'async')} (args) =&gt; ({ temp: ${S(n,'22')}, condition: ${S(s,"'sunny'")} })`,
            `)`,
            ``,
            `${S(c,'// Autonomous loop — model calls tools until done')}`,
            `${S(k,'const')} response = ${S(k,'await')} model.${S(f,'chatWithTools')}(messages)`,
            `console.${S(f,'log')}(response.toolTrace)  ${S(c,'// Full execution trace')}`,
        ].join('\n'),
    },
    {
        label: 'Structured Output',
        filename: 'structured.ts',
        html: [
            `${S(k,'import')} { ${S(t,'z')} } ${S(k,'from')} ${S(s,"'zod'")}`,
            ``,
            `${S(k,'const')} UserSchema = ${S(t,'z')}.${S(f,'object')}({`,
            `  name:      z.${S(f,'string')}(),`,
            `  age:       z.${S(f,'number')}(),`,
            `  interests: z.${S(f,'array')}(z.${S(f,'string')}()),`,
            `})`,
            ``,
            `${S(c,'// Type-safe, validated, throws on failure')}`,
            `${S(k,'const')} user = ${S(k,'await')} model.${S(f,'generateStructured')}(UserSchema, msgs)`,
            `user.name      ${S(c,'// ← TypeScript knows this is string')}`,
        ].join('\n'),
    },
]

/* ── Copy install command ────────────────────────────── */
function copyInstall() {
    navigator.clipboard.writeText('bun add universal-llm-client')
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
}

/* ── Intersection observer for fade-in ───────────────── */
onMounted(() => {
    observer.value = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible')
            }
        })
    }, { threshold: 0.1 })

    document.querySelectorAll('.ulc-fade-in').forEach(el => {
        observer.value!.observe(el)
    })
})

onUnmounted(() => {
    observer.value?.disconnect()
})
</script>

<template>
    <!-- ── Provider Strip ──────────────────────────────── -->
    <section class="ulc-section ulc-providers ulc-fade-in">
        <p class="ulc-section-title">Works With</p>
        <p class="ulc-section-subtitle">
            One interface across local inference, cloud APIs, and gateway services.
            Add a provider, set a priority — failover is automatic.
        </p>
        <div class="ulc-provider-grid">
            <div
                v-for="prov in providers"
                :key="prov.name"
                class="ulc-provider-badge"
            >
                <span class="ulc-provider-icon" v-html="prov.icon"></span>
                <strong>{{ prov.name }}</strong>
                <span class="ulc-provider-desc">{{ prov.desc }}</span>
            </div>
        </div>
    </section>

    <!-- ── Core Features Grid ──────────────────────────── -->
    <section class="ulc-section ulc-features ulc-fade-in">
        <p class="ulc-section-title">Core Features</p>
        <p class="ulc-section-subtitle">
            Everything you need to ship production AI without stitching together 5&nbsp;different libraries.
        </p>
        <div class="ulc-feature-grid">
            <div
                v-for="feat in features"
                :key="feat.name"
                class="ulc-feature-card"
            >
                <div class="ulc-feature-icon-wrap">
                    <span class="ulc-feature-icon" v-html="feat.icon"></span>
                </div>
                <div class="ulc-feature-name">{{ feat.name }}</div>
                <div class="ulc-feature-desc">{{ feat.desc }}</div>
                <div class="ulc-feature-visual">{{ feat.visual }}</div>
            </div>
        </div>
    </section>

    <!-- ── Code Showcase Tabs ──────────────────────────── -->
    <section class="ulc-section ulc-code-showcase ulc-fade-in">
        <p class="ulc-section-title">See It In Action</p>
        <p class="ulc-section-subtitle">
            Real TypeScript. Real patterns. Copy, paste, ship.
        </p>
        <div class="ulc-tabs">
            <button
                v-for="(tab, i) in codeTabs"
                :key="tab.label"
                class="ulc-tab"
                :class="{ active: activeTab === i }"
                @click="activeTab = i"
            >
                {{ tab.label }}
            </button>
        </div>
        <div class="ulc-code-block">
            <div class="ulc-code-header">
                <span class="ulc-code-dot"></span>
                <span class="ulc-code-dot"></span>
                <span class="ulc-code-dot"></span>
                <span class="ulc-code-filename">{{ codeTabs[activeTab].filename }}</span>
            </div>
            <div class="ulc-code-body" v-html="codeTabs[activeTab].html"></div>
        </div>
    </section>

    <!-- ── Architecture ────────────────────────────────── -->
    <section class="ulc-section ulc-architecture ulc-fade-in">
        <p class="ulc-section-title">Architecture</p>
        <p class="ulc-section-subtitle">
            Clean layers, zero dependencies, designed as a transport layer for agent&nbsp;frameworks.
        </p>
        <div class="ulc-arch-diagram">
            <div class="ulc-arch-top">
                <div class="ulc-arch-box primary">AIModel — Public API</div>
            </div>
            <div class="ulc-arch-arrow" v-html="icons.chevDown"></div>

            <div class="ulc-arch-row cols-3">
                <div class="ulc-arch-box secondary">
                    <span class="ulc-arch-label">Router</span>
                    <span class="ulc-arch-sublabel">Failover Engine</span>
                </div>
                <div class="ulc-arch-box secondary">
                    <span class="ulc-arch-label">StreamDecoder</span>
                    <span class="ulc-arch-sublabel">Reasoning Strategies</span>
                </div>
                <div class="ulc-arch-box secondary">
                    <span class="ulc-arch-label">Auditor</span>
                    <span class="ulc-arch-sublabel">Observability</span>
                </div>
            </div>
            <div class="ulc-arch-arrow" v-html="icons.chevDown"></div>

            <div class="ulc-arch-row cols-5">
                <div class="ulc-arch-box tertiary">Ollama</div>
                <div class="ulc-arch-box tertiary">OpenAI</div>
                <div class="ulc-arch-box tertiary">Google</div>
                <div class="ulc-arch-box tertiary">Vertex</div>
                <div class="ulc-arch-box tertiary">LlamaCpp</div>
            </div>
        </div>
    </section>

    <!-- ── CTA Footer ──────────────────────────────────── -->
    <section class="ulc-section ulc-cta ulc-fade-in">
        <div class="ulc-cta-title">Start Building</div>
        <div class="ulc-cta-sub">Zero dependencies. MIT licensed. Production-ready.</div>

        <div class="ulc-install-box">
            <span class="ulc-install-dollar">$</span>
            <code>bun add universal-llm-client</code>
            <button class="ulc-copy-btn" @click="copyInstall">
                <span class="ulc-copy-icon" v-html="copied ? icons.check : icons.copy"></span>
                {{ copied ? 'Copied' : 'Copy' }}
            </button>
        </div>

        <div class="ulc-cta-links">
            <a href="/universal-llm-client/guide/getting-started" class="ulc-cta-link primary">
                Get Started
                <span class="ulc-btn-icon" v-html="icons.arrowRight"></span>
            </a>
            <a href="/universal-llm-client/api/reference" class="ulc-cta-link secondary">
                <span class="ulc-btn-icon" v-html="icons.book"></span>
                API Reference
            </a>
        </div>
    </section>
</template>
