import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "Universal LLM Client",
  description: "A universal LLM client for JavaScript/TypeScript with transparent provider failover, structured output, streaming tool execution, and native observability.",
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
