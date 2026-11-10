<script setup lang="ts">
import { withBase } from 'vitepress'
import { agentFacts, facts, protocolColumns, repoUrl, supportRows } from './data'
import CapabilityTabs from './CapabilityTabs.vue'
import FailoverDemo from './FailoverDemo.vue'
import InstallCommand from './InstallCommand.vue'
import UlcIcon from './UlcIcon.vue'

const changelogUrl = `${repoUrl}/blob/main/CHANGELOG.md`
</script>

<template>
    <div class="home">
        <!-- ── Offer ───────────────────────────────────────────── -->
        <header class="wrap hero">
            <div class="hero-copy">
                <h1>One client for four LLM protocols, with failover built in.</h1>
                <p>
                    A TypeScript library for developers and agents. It speaks OpenAI Chat Completions, Anthropic
                    Messages, Gemini and Ollama, so any endpoint on one of them works as it is.
                </p>
            </div>
            <div class="hero-act">
                <InstallCommand id-prefix="hero" />
                <div class="hero-links">
                    <a class="btn btn-primary" :href="withBase('/guide/getting-started')">
                        Get started
                        <UlcIcon name="arrow" />
                    </a>
                    <a class="btn" :href="withBase('/api/reference')">API reference</a>
                </div>
                <dl class="hero-facts">
                    <div v-for="fact in facts" :key="fact.term">
                        <dt>{{ fact.term }}</dt>
                        <dd>{{ fact.detail }}</dd>
                    </div>
                </dl>
            </div>
        </header>

        <!-- ── Proof ───────────────────────────────────────────── -->
        <div class="wrap">
            <FailoverDemo>
                <template #code><slot name="failover" /></template>
            </FailoverDemo>
        </div>

        <!-- ── Capabilities ────────────────────────────────────── -->
        <section class="wrap section" aria-labelledby="caps-title">
            <div class="section-head">
                <h2 id="caps-title">One API for everything a model can do</h2>
                <p>
                    Everything goes through one class, <code>AIModel</code>. Switching provider does not change the
                    method you call, its arguments or the shape of what comes back.
                </p>
            </div>
            <CapabilityTabs>
                <template #streaming><slot name="streaming" /></template>
                <template #tools><slot name="tools" /></template>
                <template #structured><slot name="structured" /></template>
                <template #reasoning><slot name="reasoning" /></template>
                <template #observability><slot name="observability" /></template>
                <template #mcp><slot name="mcp" /></template>
            </CapabilityTabs>
        </section>

        <!-- ── Providers ───────────────────────────────────────── -->
        <section class="wrap section" aria-labelledby="providers-title">
            <div class="section-head">
                <h2 id="providers-title">Compatibility is a protocol, not a provider list</h2>
                <p>
                    If an endpoint speaks one of these four protocols, give it a <code>type</code> and a
                    <code>url</code> and it works. A new provider needs no library release, and the model id is
                    whatever your endpoint accepts.
                </p>
            </div>
            <div class="matrix" role="region" aria-label="Protocol support table" tabindex="0">
                <table>
                    <thead>
                        <tr>
                            <th scope="col">Capability</th>
                            <th v-for="col in protocolColumns" :key="col.name" scope="col">
                                <span class="matrix-full">{{ col.name }}</span>
                                <span class="matrix-short">{{ col.short }}</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr class="matrix-types">
                            <th scope="row">Provider <code>type</code></th>
                            <td v-for="col in protocolColumns" :key="col.name">
                                <code v-for="type in col.types" :key="type">{{ type }}</code>
                            </td>
                        </tr>
                        <tr v-for="row in supportRows" :key="row.feature">
                            <th scope="row">{{ row.feature }}</th>
                            <td v-for="(cell, i) in row.cells" :key="i" :class="{ 'is-no': cell === 'no' }">
                                <template v-if="cell === 'yes'">
                                    <UlcIcon name="check" />
                                    <span class="sr-only">Yes</span>
                                </template>
                                <template v-else-if="cell === 'no'">Not supported</template>
                                <template v-else>{{ cell }}</template>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p class="matrix-note">
                Most gateways and self-hosted servers speak Chat Completions. Whether image input works there
                depends on the server and the model it has loaded. On Anthropic Messages no response schema is
                sent, so structured output is validated in your code.
            </p>
            <a class="text-link" :href="withBase('/guide/protocols')">
                Protocol notes, strict JSON mode and prompt caching
                <UlcIcon name="arrow" />
            </a>
        </section>

        <!-- ── Agents ──────────────────────────────────────────── -->
        <section class="wrap section" aria-labelledby="agents-title">
            <div class="section-head">
                <h2 id="agents-title">A transport layer for agents</h2>
                <p>
                    The library does the provider work and stays out of your architecture. It stores no conversation
                    history and makes no decisions about memory, planning or prompts.
                </p>
            </div>
            <div class="agents">
                <dl class="agents-facts">
                    <div v-for="fact in agentFacts" :key="fact.term">
                        <dt>{{ fact.term }}</dt>
                        <dd>{{ fact.detail }}</dd>
                    </div>
                </dl>
                <div class="agents-machine">
                    <h3>If you are an agent reading this</h3>
                    <p>The documentation is published as plain text, so you do not have to parse this site.</p>
                    <ul>
                        <li>
                            <a :href="withBase('/llms.txt')"><code>/llms.txt</code></a>
                            <span>An index of every documentation page, each linked as Markdown.</span>
                        </li>
                        <li>
                            <a :href="withBase('/llms-full.txt')"><code>/llms-full.txt</code></a>
                            <span>The whole documentation in one file.</span>
                        </li>
                    </ul>
                </div>
            </div>
        </section>

        <!-- ── Close ───────────────────────────────────────────── -->
        <section class="wrap section close" aria-labelledby="close-title">
            <h2 id="close-title">Start with one provider. Add the second when you need it.</h2>
            <div class="close-act">
                <InstallCommand id-prefix="close" />
                <nav class="close-links" aria-label="Where to go next">
                    <a :href="withBase('/guide/getting-started')">Getting started <UlcIcon name="arrow" /></a>
                    <a :href="withBase('/guide/protocols')">Protocols <UlcIcon name="arrow" /></a>
                    <a :href="withBase('/api/reference')">API reference <UlcIcon name="arrow" /></a>
                    <a :href="changelogUrl">Changelog <UlcIcon name="arrow" /></a>
                </nav>
            </div>
        </section>
    </div>
</template>

<style scoped>
.home {
    color: var(--vp-c-text-1);
}

.wrap {
    width: 100%;
    max-width: calc(var(--ulc-page) + 4rem);
    margin: 0 auto;
    padding: 0 2rem;
}

.sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
}

code {
    font-family: var(--vp-font-family-mono);
    font-size: 0.875em;
}

/* ── Offer ───────────────────────────────────────────────────── */

.hero {
    display: grid;
    grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
    column-gap: 4rem;
    align-items: end;
    padding-top: 2.5rem;
    padding-bottom: 2rem;
}

.hero h1 {
    margin: 0;
    font-size: clamp(2.375rem, 1.3rem + 3.2vw, 3.75rem);
    line-height: 1.03;
    font-weight: 700;
    font-stretch: 96%;
    letter-spacing: -0.035em;
    text-wrap: balance;
}

.hero-copy p {
    max-width: 41rem;
    margin: 1.25rem 0 0;
    font-size: 1.125rem;
    line-height: 1.6;
    color: var(--vp-c-text-2);
    text-wrap: pretty;
}

.hero-act {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
}

.hero-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-top: 0.5rem;
}

.btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    height: 2.75rem;
    padding: 0 1.125rem;
    border: 1px solid var(--vp-c-border);
    border-radius: 8px;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--vp-c-text-1);
    text-decoration: none;
    transition: background-color 0.2s var(--ulc-ease), border-color 0.2s var(--ulc-ease), color 0.2s var(--ulc-ease);
}

.btn:hover {
    border-color: var(--vp-c-text-3);
}

.btn .ulc-icon {
    transition: transform 0.25s var(--ulc-ease);
}

.btn:hover .ulc-icon {
    transform: translateX(3px);
}

.btn-primary {
    border-color: var(--vp-button-brand-bg);
    background: var(--vp-button-brand-bg);
    color: var(--vp-button-brand-text);
}

.btn-primary:hover {
    border-color: var(--vp-button-brand-hover-bg);
    background: var(--vp-button-brand-hover-bg);
    color: var(--vp-button-brand-hover-text);
}

.hero-facts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem 1.75rem;
    margin: 1.75rem 0 0;
    padding-top: 1.25rem;
    border-top: 1px solid var(--vp-c-divider);
    width: 100%;
    max-width: 30rem;
}

.hero-facts dt {
    font-size: 0.8125rem;
    line-height: 1.25rem;
    color: var(--vp-c-text-2);
}

.hero-facts dd {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.375rem;
    font-weight: 550;
    color: var(--vp-c-text-1);
}

/* ── Sections ────────────────────────────────────────────────── */

.section {
    margin-top: 6.5rem;
}

.section-head {
    max-width: 44rem;
    margin-bottom: 2.75rem;
}

.section h2 {
    margin: 0;
    font-size: clamp(1.75rem, 1.2rem + 1.6vw, 2.5rem);
    line-height: 1.12;
    font-weight: 680;
    font-stretch: 96%;
    letter-spacing: -0.03em;
    text-wrap: balance;
}

.section-head p {
    max-width: 36rem;
    margin: 1rem 0 0;
    font-size: 1.0625rem;
    line-height: 1.6;
    color: var(--vp-c-text-2);
    text-wrap: pretty;
}

.section-head code,
.matrix-note code,
.agents code {
    padding: 0.125rem 0.375rem;
    border-radius: 5px;
    background: var(--vp-c-bg-soft);
    color: var(--vp-c-text-1);
}

.matrix-note {
    max-width: 33rem;
    margin: 1rem 0 0;
    font-size: 0.9375rem;
    line-height: 1.55;
    color: var(--vp-c-text-2);
    text-wrap: pretty;
}

/* Text links are neutral ink on a hairline. Green is kept for what answered and the primary action. */
.text-link {
    display: inline-block;
    margin-top: 1rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--vp-c-text-1);
    text-decoration: underline;
    text-decoration-color: var(--vp-c-border);
    text-decoration-thickness: 1px;
    text-underline-offset: 5px;
    transition: text-decoration-color 0.2s var(--ulc-ease);
}

.text-link:hover {
    text-decoration-color: currentColor;
}

.text-link .ulc-icon {
    display: inline-block;
    margin-left: 0.25rem;
    vertical-align: -0.1875em;
    color: var(--vp-c-text-3);
    transition: transform 0.25s var(--ulc-ease);
}

.text-link:hover .ulc-icon {
    transform: translateX(3px);
}

/* ── Providers ───────────────────────────────────────────────── */

.matrix {
    /* Contains the visually hidden "Yes" labels so they cannot widen the page */
    position: relative;
    border: 1px solid var(--vp-c-border);
    border-radius: 14px;
    overflow-x: auto;
    scrollbar-width: thin;
}

.matrix:focus-visible {
    outline-offset: 3px;
}

.matrix table {
    width: 100%;
    min-width: 40rem;
    border-collapse: collapse;
    font-size: 0.9375rem;
    line-height: 1.375rem;
}

.matrix th,
.matrix td {
    padding: 0.8125rem 1.25rem;
    border-bottom: 1px solid var(--vp-c-divider);
    text-align: left;
    vertical-align: middle;
}

.matrix tbody tr:last-child th,
.matrix tbody tr:last-child td {
    border-bottom: 0;
}

.matrix thead th {
    background: var(--vp-c-bg-alt);
    font-weight: 650;
    vertical-align: bottom;
}

.matrix-short {
    display: none;
}

.matrix-types th,
.matrix-types td {
    color: var(--vp-c-text-2);
}

.matrix-types th {
    font-weight: 400;
}

.matrix-types code {
    font-size: 0.8125rem;
    color: var(--vp-c-text-1);
}

.matrix-types td code + code {
    margin-left: 0.875rem;
}

.matrix tbody th {
    font-weight: 550;
    white-space: nowrap;
}

.matrix td {
    color: var(--vp-c-text-1);
}

.matrix td.is-no {
    color: var(--vp-c-text-2);
}

/* ── Agents ──────────────────────────────────────────────────── */

.agents {
    display: grid;
    grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
    column-gap: 4rem;
    align-items: start;
}

.agents-facts {
    margin: 0;
    border-top: 1px solid var(--vp-c-divider);
}

.agents-facts > div {
    display: grid;
    grid-template-columns: 9.5rem minmax(0, 1fr);
    column-gap: 1.5rem;
    padding: 0.9375rem 0;
    border-bottom: 1px solid var(--vp-c-divider);
}

.agents-facts dt {
    font-weight: 650;
}

.agents-facts dd {
    margin: 0;
    color: var(--vp-c-text-2);
    line-height: 1.55;
    text-wrap: pretty;
}

.agents-machine {
    padding: 1.5rem 1.5rem 1.25rem;
    border: 1px solid var(--vp-c-border);
    border-radius: 14px;
    background: var(--vp-c-bg-alt);
}

.agents-machine h3 {
    margin: 0;
    font-size: 1.0625rem;
    line-height: 1.5rem;
    font-weight: 650;
    letter-spacing: -0.01em;
}

.agents-machine p {
    margin: 0.5rem 0 1rem;
    font-size: 0.9375rem;
    line-height: 1.55;
    color: var(--vp-c-text-2);
}

.agents-machine ul {
    margin: 0;
    padding: 0;
    list-style: none;
}

.agents-machine li {
    display: grid;
    row-gap: 0.125rem;
    padding: 0.75rem 0;
    border-top: 1px solid var(--vp-c-divider);
    font-size: 0.9375rem;
    line-height: 1.5;
}

.agents-machine li span {
    color: var(--vp-c-text-2);
    text-wrap: pretty;
}

.agents-machine a {
    justify-self: start;
    color: var(--vp-c-text-1);
    text-decoration: underline;
    text-decoration-color: var(--vp-c-border);
    text-decoration-thickness: 1px;
    text-underline-offset: 5px;
    transition: text-decoration-color 0.2s var(--ulc-ease);
}

.agents-machine a code {
    padding: 0;
    background: none;
    color: inherit;
    font-weight: 600;
}

.agents-machine a:hover {
    text-decoration-color: currentColor;
}

/* ── Close ───────────────────────────────────────────────────── */

.close::before {
    content: '';
    display: block;
    height: 1px;
    margin-bottom: 4.5rem;
    background: var(--vp-c-divider);
}

.close h2 {
    max-width: 16em;
}

.close-act {
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
    column-gap: 4rem;
    align-items: start;
    margin-top: 2.25rem;
}

.close-links {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: 2rem;
    border-top: 1px solid var(--vp-c-divider);
}

.close-links a {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.875rem 0;
    border-bottom: 1px solid var(--vp-c-divider);
    font-size: 1rem;
    font-weight: 600;
    color: var(--vp-c-text-1);
    text-decoration: none;
    transition: color 0.2s var(--ulc-ease);
}

.close-links a .ulc-icon {
    color: var(--vp-c-text-3);
    transition: transform 0.25s var(--ulc-ease), color 0.2s var(--ulc-ease);
}

.close-links a:hover {
    border-bottom-color: var(--vp-c-text-3);
}

.close-links a:hover .ulc-icon {
    color: var(--vp-c-text-1);
    transform: translateX(3px);
}

/* ── Narrow ──────────────────────────────────────────────────── */

@media (max-width: 960px) {
    .hero {
        grid-template-columns: minmax(0, 1fr);
        row-gap: 2.25rem;
        align-items: start;
        padding-top: 3rem;
        padding-bottom: 2.75rem;
    }

    .agents,
    .close-act {
        grid-template-columns: minmax(0, 1fr);
        row-gap: 2.25rem;
    }

    .section {
        margin-top: 5rem;
    }
}

@media (max-width: 640px) {
    /* Inline only: the shorthand would also zero the hero's own top and bottom padding. */
    .wrap {
        padding-inline: 1.5rem;
    }

    .hero {
        padding-top: 2.25rem;
        padding-bottom: 2.25rem;
    }

    .hero-copy p {
        font-size: 1.0625rem;
    }

    .section {
        margin-top: 4.25rem;
    }

    .section-head {
        margin-bottom: 2rem;
    }

    /* All four protocols on one phone screen: short heads, tight cells, no minimum width. */
    .matrix table {
        min-width: 0;
        font-size: 0.78125rem;
        line-height: 1.25rem;
    }

    .matrix th,
    .matrix td {
        padding: 0.5625rem 0.25rem;
    }

    .matrix th:first-child {
        position: sticky;
        left: 0;
        padding-left: 0.625rem;
        background: var(--vp-c-bg);
        white-space: normal;
    }

    .matrix thead th {
        font-size: 0.6875rem;
        line-height: 1.0625rem;
    }

    .matrix thead th:first-child {
        background: var(--vp-c-bg-alt);
    }

    .matrix td:last-child,
    .matrix th:last-child {
        padding-right: 0.625rem;
    }

    .matrix-full {
        display: none;
    }

    .matrix-short {
        display: inline;
    }

    .matrix-types code {
        display: block;
        font-size: 0.65625rem;
        line-height: 1.0625rem;
    }

    .matrix-types td code + code {
        margin-left: 0;
    }

    .agents-facts > div {
        grid-template-columns: minmax(0, 1fr);
        row-gap: 0.25rem;
    }

    .close::before {
        margin-bottom: 3.5rem;
    }

    .close-links {
        grid-template-columns: minmax(0, 1fr);
    }
}

@media (prefers-reduced-motion: reduce) {
    .btn .ulc-icon,
    .text-link .ulc-icon,
    .close-links a .ulc-icon {
        transition: none;
    }
}
</style>
