<script setup lang="ts">
import { ref } from 'vue'
import { withBase } from 'vitepress'
import { capabilities } from './data'
import UlcIcon from './UlcIcon.vue'

const active = ref(capabilities[0]!.id)
const tabEls = ref<HTMLButtonElement[]>([])

function select(index: number, focus = false) {
    const count = capabilities.length
    const next = (index + count) % count
    active.value = capabilities[next]!.id
    if (focus) tabEls.value[next]?.focus()
}

function onKeydown(event: KeyboardEvent, index: number) {
    switch (event.key) {
        case 'ArrowDown':
        case 'ArrowRight':
            event.preventDefault()
            select(index + 1, true)
            break
        case 'ArrowUp':
        case 'ArrowLeft':
            event.preventDefault()
            select(index - 1, true)
            break
        case 'Home':
            event.preventDefault()
            select(0, true)
            break
        case 'End':
            event.preventDefault()
            select(capabilities.length - 1, true)
            break
    }
}
</script>

<template>
    <div class="caps">
        <div class="cap-tabs" role="tablist" aria-label="Capabilities">
            <button
                v-for="(cap, i) in capabilities"
                :id="`cap-tab-${cap.id}`"
                :key="cap.id"
                ref="tabEls"
                type="button"
                role="tab"
                class="cap-tab"
                :aria-selected="active === cap.id"
                :aria-controls="`cap-panel-${cap.id}`"
                :tabindex="active === cap.id ? 0 : -1"
                @click="select(i)"
                @keydown="onKeydown($event, i)"
            >
                {{ cap.label }}
            </button>
        </div>

        <div
            v-for="cap in capabilities"
            :id="`cap-panel-${cap.id}`"
            :key="cap.id"
            class="cap-panel"
            role="tabpanel"
            :aria-labelledby="`cap-tab-${cap.id}`"
            :hidden="active !== cap.id"
        >
            <div class="cap-text">
                <h3>{{ cap.title }}</h3>
                <p>{{ cap.summary }}</p>
                <ul>
                    <li v-for="point in cap.points" :key="point">{{ point }}</li>
                </ul>
                <a class="cap-link" :href="withBase(cap.link.href)">
                    {{ cap.link.text }}
                    <UlcIcon name="arrow" />
                </a>
            </div>
            <div class="cap-code vp-doc">
                <slot :name="cap.id" />
            </div>
        </div>
    </div>
</template>

<style scoped>
.caps {
    display: grid;
    grid-template-columns: 11rem minmax(0, 1fr);
    column-gap: 2.5rem;
    align-items: start;
}

/* ── Tabs ────────────────────────────────────────────────────── */

.cap-tabs {
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--vp-c-divider);
}

.cap-tab {
    position: relative;
    margin-left: -1px;
    padding: 0.5625rem 1rem;
    border-left: 1px solid transparent;
    text-align: left;
    font-size: 0.9375rem;
    line-height: 1.5rem;
    font-weight: 500;
    color: var(--vp-c-text-2);
    transition: color 0.2s var(--ulc-ease), border-color 0.2s var(--ulc-ease);
}

.cap-tab:hover {
    color: var(--vp-c-text-1);
}

.cap-tab[aria-selected='true'] {
    border-left-color: var(--vp-c-brand-1);
    color: var(--vp-c-text-1);
    font-weight: 650;
}

/* ── Panel ───────────────────────────────────────────────────── */

.cap-panel {
    grid-column: 2;
    display: grid;
    grid-template-columns: minmax(0, 9fr) minmax(0, 14fr);
    column-gap: 2.5rem;
    align-items: start;
    min-width: 0;
}

.cap-panel[hidden] {
    display: none;
}

.cap-text h3 {
    margin: 0 0 0.75rem;
    font-size: 1.375rem;
    line-height: 1.75rem;
    font-weight: 650;
    letter-spacing: -0.015em;
    color: var(--vp-c-text-1);
    text-wrap: balance;
}

.cap-text p {
    margin: 0 0 1.25rem;
    font-size: 1rem;
    line-height: 1.65;
    color: var(--vp-c-text-2);
    text-wrap: pretty;
}

.cap-text ul {
    margin: 0 0 1.5rem;
    padding: 0;
    list-style: none;
    border-top: 1px solid var(--vp-c-divider);
}

.cap-text li {
    padding: 0.625rem 0;
    border-bottom: 1px solid var(--vp-c-divider);
    font-size: 0.9375rem;
    line-height: 1.5;
    color: var(--vp-c-text-1);
    text-wrap: pretty;
}

.cap-link {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--vp-c-text-1);
    text-decoration: underline;
    text-decoration-color: var(--vp-c-border);
    text-decoration-thickness: 1px;
    text-underline-offset: 5px;
    transition: text-decoration-color 0.2s var(--ulc-ease);
}

.cap-link .ulc-icon {
    color: var(--vp-c-text-3);
    transition: transform 0.25s var(--ulc-ease);
}

.cap-link:hover {
    text-decoration-color: currentColor;
}

.cap-link:hover .ulc-icon {
    transform: translateX(3px);
}

.cap-code {
    min-width: 0;
}

.cap-code.vp-doc :deep(div[class*='language-']) {
    margin: 0;
    border: 1px solid var(--vp-c-divider);
    border-radius: var(--ulc-radius);
}

/* ── Narrow ──────────────────────────────────────────────────── */

@media (max-width: 1100px) {
    .cap-panel {
        grid-template-columns: minmax(0, 1fr);
        row-gap: 1.75rem;
    }
}

@media (max-width: 860px) {
    .caps {
        grid-template-columns: minmax(0, 1fr);
        row-gap: 1.75rem;
    }

    /* Every tab stays on screen: a hairline grid, three across on a phone, six on a tablet. */
    .cap-tabs {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(6.75rem, 1fr));
        gap: 1px;
        padding: 1px;
        border-left: 0;
        border-radius: var(--ulc-radius);
        background: var(--vp-c-divider);
        overflow: hidden;
    }

    .cap-tab {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 2.75rem;
        margin: 0;
        padding: 0.625rem 0.5rem;
        border-left: 0;
        background: var(--vp-c-bg);
        text-align: center;
        font-size: 0.875rem;
        line-height: 1.25rem;
    }

    .cap-tab[aria-selected='true'] {
        box-shadow: inset 0 -2px 0 var(--vp-c-brand-1);
    }

    .cap-tab:focus-visible {
        outline-offset: -3px;
    }

    .cap-panel {
        grid-column: 1;
    }
}

@media (max-width: 640px) {
    /* Edge to edge on phones, so the samples' 46 columns fit without scrolling. */
    .cap-code {
        --vp-code-font-size: 0.75rem;
        margin: 0 -1.5rem;
    }

    .cap-code.vp-doc :deep(div[class*='language-']) {
        border-left: 0;
        border-right: 0;
        border-radius: 0;
    }

    .cap-code.vp-doc :deep(code) {
        padding: 0 16px;
    }
}
</style>
