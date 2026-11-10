import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitepress'
import llmstxt from 'vitepress-plugin-llms'

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string }

const base = '/universal-llm-client/'

/**
 * Code themes built from the site tokens (theme/tokens.css): neutral ink for
 * identifiers, dimmer ink for keywords and punctuation, the faintest ink for
 * comments, and one quiet blue for literal values. No red family, so code never
 * competes with the failure state in the trace. Every colour is 4.5:1 or better
 * on both code grounds.
 */
function codeTheme(
  name: string,
  type: 'light' | 'dark',
  ink: { text: string; dim: string; faint: string; value: string; ground: string },
) {
  return {
    name,
    type,
    colors: { 'editor.foreground': ink.text, 'editor.background': ink.ground },
    tokenColors: [
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: ink.faint } },
      {
        scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'punctuation', 'meta.brace'],
        settings: { foreground: ink.dim },
      },
      {
        scope: [
          'string',
          'punctuation.definition.string',
          'constant.numeric',
          'constant.language',
          'constant.character.escape',
        ],
        settings: { foreground: ink.value },
      },
    ],
  }
}

const codeThemes = {
  light: codeTheme('ulc-light', 'light', {
    text: '#0c0f0e',
    dim: '#474f4c',
    faint: '#636b68',
    value: '#33506f',
    ground: '#f5f6f6',
  }),
  dark: codeTheme('ulc-dark', 'dark', {
    text: '#eef1ef',
    dim: '#a9b1ad',
    faint: '#838c88',
    value: '#b4c4d8',
    ground: '#101312',
  }),
}
const description =
  'One TypeScript client for four LLM wire protocols: OpenAI Chat Completions, Anthropic Messages, Gemini and Ollama. Provider failover, streaming, tool calling, structured output and reasoning control.'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Universal LLM Client',
  description,
  base, // Needed for GitHub Pages
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['meta', { name: 'theme-color', content: '#0b0d0c' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Universal LLM Client' }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
    // Without JavaScript the capability tabs cannot switch, so show every panel.
    ['noscript', {}, '<style>.cap-panel[hidden]{display:grid!important}.cap-tabs{display:none!important}</style>'],
  ],
  markdown: {
    theme: codeThemes,
  },
  vite: {
    plugins: [llmstxt()],
  },
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: { src: '/logo.svg', alt: '' },

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/reference' },
      {
        text: `v${pkg.version}`,
        link: 'https://github.com/igorls/universal-llm-client/blob/main/CHANGELOG.md',
      },
    ],

    search: { provider: 'local' },
    outline: [2, 3],

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
