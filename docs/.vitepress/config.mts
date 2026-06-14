import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "Universal LLM Client",
  description: "A universal LLM client for JavaScript/TypeScript with a provider-agnostic reasoning API, transparent provider failover, structured output, streaming tool execution, Gemini Deep Research, and native observability.",
  base: "/universal-llm-client/", // Needed for GitHub Pages
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/reference' }
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Reasoning & Thinking', link: '/guide/reasoning' },
          { text: 'Deep Research', link: '/guide/deep-research' },
          { text: 'Structured Output', link: '/guide/structured-output' },
          { text: 'Providers', link: '/guide/providers' },
          { text: 'Features', link: '/guide/features' },
          { text: 'Architecture', link: '/guide/architecture' }
        ]
      },
      {
        text: 'API',
        items: [
          { text: 'Reference', link: '/api/reference' }
        ]
      },
      {
        text: 'Research',
        items: [
          { text: 'Provider API Landscape 2026', link: '/research/provider-api-landscape-2026' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/igorls/universal-llm-client' }
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-2026 Igor Lins e Silva'
    }
  }
})
