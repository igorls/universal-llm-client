import DefaultTheme from 'vitepress/theme-without-fonts'
import type { Theme } from 'vitepress'
import './tokens.css'
import HomePage from './home/HomePage.vue'

export default {
    extends: DefaultTheme,
    enhanceApp({ app }) {
        app.component('HomePage', HomePage)
    },
} satisfies Theme
