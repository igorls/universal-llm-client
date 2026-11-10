<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { demoProviders, failureModes, routerDefaults, type DemoProvider, type FailureMode } from './data'
import UlcIcon from './UlcIcon.vue'

/** The audit event types the library records for a chat call. */
type EventName = 'REQUEST' | 'ERROR' | 'RETRY' | 'FAILOVER' | 'RESPONSE'
type Tone = 'plain' | 'quiet' | 'fail' | 'move' | 'ok'

interface TraceRow {
    event: EventName
    /** As the event reports it: the client's type for REQUEST and RESPONSE, the router's id for the rest */
    provider: string
    detail: string
    tone: Tone
    /** Simulated clock, ms since the call started */
    at: number
    /** Real ms to wait before this row appears during playback */
    hold: number
}

interface Run {
    rows: TraceRow[]
    answered: DemoProvider | null
    elapsed: number
}

/** Simulated latency of a healthy answer, per provider position */
const LATENCY = [640, 910, 1280]
const ATTEMPTS = routerDefaults.retriesPerProvider + 1
const COOLDOWN = `cooldown ${routerDefaults.cooldownMs / 1000} s`

/**
 * Mirrors the router (src/router.ts, src/errors.ts):
 * - A provider with no success in the last minute is probed first (getModels raced
 *   against 2.5 s). Only a probe timeout is recorded: the provider is cooled down and
 *   skipped without a request and without a failover event.
 * - 5xx is retried on the same provider, then fails over without a cooldown.
 * - 429 and timeouts are not retried: they fail over at once and cool the provider down.
 * - REQUEST and RESPONSE come from the provider client, which reports its type;
 *   ERROR, RETRY and FAILOVER come from the router, which reports the provider id.
 */
function simulate(providers: readonly DemoProvider[]): Run {
    const rows: TraceRow[] = []
    let at = 0
    let answered: DemoProvider | null = null

    providers.forEach((p, i) => {
        if (answered) return

        if (p.mode === 'unreachable') {
            at += routerDefaults.coldProbeTimeoutMs
            rows.push({
                event: 'ERROR',
                provider: p.id,
                detail: `probe timeout ${routerDefaults.coldProbeTimeoutMs / 1000} s, ${COOLDOWN}`,
                tone: 'fail',
                at,
                hold: 760,
            })
            return
        }

        for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
            rows.push({ event: 'REQUEST', provider: p.type, detail: p.model, tone: 'plain', at, hold: 280 })

            if (p.mode === 'ok') {
                at += LATENCY[i] ?? 900
                rows.push({
                    event: 'RESPONSE',
                    provider: p.type,
                    detail: `${LATENCY[i] ?? 900} ms, 38 tokens`,
                    tone: 'ok',
                    at,
                    hold: 560,
                })
                answered = p
                return
            }

            if (p.mode === 'http500') {
                at += 180
                rows.push({
                    event: 'ERROR',
                    provider: p.id,
                    detail: `HTTP 500, attempt ${attempt} of ${ATTEMPTS}`,
                    tone: 'fail',
                    at,
                    hold: 340,
                })
                if (attempt === ATTEMPTS) break
                rows.push({
                    event: 'RETRY',
                    provider: p.id,
                    detail: `attempt ${attempt + 1} of ${ATTEMPTS}`,
                    tone: 'quiet',
                    at,
                    hold: 220,
                })
                continue
            }

            if (p.mode === 'http429') {
                at += 120
                rows.push({ event: 'ERROR', provider: p.id, detail: `HTTP 429, ${COOLDOWN}`, tone: 'fail', at, hold: 380 })
            } else {
                at += routerDefaults.timeoutMs
                rows.push({
                    event: 'ERROR',
                    provider: p.id,
                    detail: `timeout at ${routerDefaults.timeoutMs / 1000} s, ${COOLDOWN}`,
                    tone: 'fail',
                    at,
                    hold: 900,
                })
            }
            break
        }

        const next = providers[i + 1]
        if (next) {
            rows.push({ event: 'FAILOVER', provider: p.id, detail: `to ${next.id}`, tone: 'move', at, hold: 260 })
        }
    })

    return { rows, answered, elapsed: at }
}

const providers = reactive<DemoProvider[]>(demoProviders.map((p) => ({ ...p })))
const run = ref<Run>(simulate(providers))
/** How many rows of the current run are on screen */
const shown = ref(run.value.rows.length)
/** Rows of the previous run, kept on screen until the new run replaces them */
const stale = ref<TraceRow[]>([])
/** 0 is the server-rendered run, which must not animate in */
const runId = ref(0)
const traceEl = ref<HTMLElement | null>(null)

let timer: ReturnType<typeof setTimeout> | undefined
let reducedMotion = false

const playing = computed(() => shown.value < run.value.rows.length)

const displayRows = computed(() => {
    const fresh = run.value.rows.slice(0, shown.value).map((row, i) => ({ row, stale: false, key: `${runId.value}-${i}` }))
    if (!playing.value) return fresh
    const rest = stale.value
        .slice(shown.value)
        .map((row, i) => ({ row, stale: true, key: `${runId.value}-stale-${shown.value + i}` }))
    return [...fresh, ...rest]
})

const answeredId = computed(() => (playing.value ? 'pending' : (run.value.answered?.id ?? 'none')))

const status = computed(() => {
    if (playing.value) return 'Running the call.'
    const { answered, elapsed } = run.value
    if (!answered) return 'All three providers failed, so model.chat() rejects with the last provider error.'
    const failed = providers.findIndex((p) => p.id === answered.id)
    const after = failed === 0 ? 'on the first attempt' : `after ${failed} failed ${failed === 1 ? 'provider' : 'providers'}`
    return `Answered by ${answered.name} ${after}, ${formatClock(elapsed)} into the call. Your code awaited once.`
})

/** The answering provider's lines in the code sample, from data.ts rather than hardcoded selectors. */
const highlightCss =
    demoProviders
        .map(({ id, lines: [from, to] }) => `.ulc-demo[data-answered=${id}] .demo-code .line:nth-child(n+${from}):nth-child(-n+${to})`)
        .join(',') +
    '{display:inline-block;width:calc(100% + 2*var(--ulc-code-pad));margin:0 calc(-1*var(--ulc-code-pad));padding:0 var(--ulc-code-pad);background:var(--ulc-live-bg)}'

/** A render function, so the rule is in the server-rendered page as well. */
const HighlightStyle = () => h('style', { innerHTML: highlightCss })

function formatClock(ms: number) {
    return `${(ms / 1000).toFixed(2)} s`
}

function revealLatest() {
    const el = traceEl.value
    const row = el?.children[shown.value - 1] as HTMLElement | undefined
    if (!el || !row) return
    const bottom = row.offsetTop + row.offsetHeight
    if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
}

function step() {
    if (!playing.value) {
        stale.value = []
        return
    }
    timer = setTimeout(() => {
        shown.value++
        nextTick(revealLatest)
        step()
    }, run.value.rows[shown.value]!.hold)
}

function play() {
    clearTimeout(timer)
    const previous = displayRows.value.map((d) => d.row)
    run.value = simulate(providers)
    runId.value++
    if (reducedMotion) {
        stale.value = []
        shown.value = run.value.rows.length
        return
    }
    stale.value = previous
    shown.value = 0
    nextTick(() => {
        if (traceEl.value) traceEl.value.scrollTop = 0
    })
    step()
}

function setMode(provider: DemoProvider, mode: FailureMode) {
    provider.mode = mode
    play()
}

// The page loads with the finished trace and stays still. A run plays only when the
// visitor asks for one, by changing a provider or pressing Run again.
onMounted(() => {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
})

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
    <section class="demo ulc-demo" :data-answered="answeredId" aria-labelledby="demo-title">
        <HighlightStyle />

        <header class="demo-head">
            <h2 id="demo-title">One call, three providers</h2>
            <p>Simulated in your browser with the library's routing rules. Nothing is sent.</p>
        </header>

        <div class="demo-body">
            <div class="demo-code vp-doc">
                <slot name="code" />
            </div>

            <div class="demo-side">
                <fieldset class="demo-providers">
                    <legend>Decide how each provider behaves</legend>
                    <div v-for="p in providers" :key="p.id" class="demo-provider">
                        <label :for="`demo-mode-${p.id}`">
                            {{ p.name }}
                            <span>{{ p.id }}</span>
                        </label>
                        <div class="demo-select">
                            <!-- `selected` on the option, not `value` on the select: the server-rendered
                                 page must show the same choice the trace was computed from. -->
                            <select
                                :id="`demo-mode-${p.id}`"
                                @change="setMode(p, ($event.target as HTMLSelectElement).value as FailureMode)"
                            >
                                <option v-for="m in failureModes" :key="m.id" :value="m.id" :selected="m.id === p.mode">
                                    {{ m.label }}
                                </option>
                            </select>
                            <UlcIcon name="chevron" />
                        </div>
                    </div>
                </fieldset>

                <div class="demo-status">
                    <p role="status" aria-live="polite">{{ status }}</p>
                    <button type="button" class="demo-run" @click="play">
                        <UlcIcon name="retry" />
                        Run again
                    </button>
                </div>

                <ol ref="traceEl" class="trace" aria-label="Audit events for this call" tabindex="0">
                    <li
                        v-for="item in displayRows"
                        :key="item.key"
                        class="trace-row"
                        :class="[`is-${item.row.tone}`, { 'is-stale': item.stale, 'is-fresh': !item.stale && runId > 0 }]"
                        :aria-hidden="item.stale ? 'true' : undefined"
                    >
                        <span class="trace-at">+{{ formatClock(item.row.at) }}</span>
                        <span class="trace-event">
                            <span class="trace-mark">
                                <UlcIcon v-if="item.row.event === 'ERROR'" name="cross" />
                                <UlcIcon v-else-if="item.row.event === 'RESPONSE'" name="check" />
                                <UlcIcon v-else-if="item.row.event === 'FAILOVER'" name="arrow" />
                                <UlcIcon v-else-if="item.row.event === 'RETRY'" name="retry" />
                            </span>
                            {{ item.row.event }}
                        </span>
                        <span class="trace-provider">{{ item.row.provider }}</span>
                        <span class="trace-detail">{{ item.row.detail }}</span>
                    </li>
                </ol>
            </div>
        </div>
    </section>
</template>

<style scoped>
.demo {
    border: 1px solid var(--vp-c-border);
    border-radius: 14px;
    background: var(--vp-c-bg-alt);
    overflow: hidden;
}

.demo-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 1.5rem;
    padding: 0.875rem 1.25rem;
    border-bottom: 1px solid var(--vp-c-divider);
}

.demo-head h2 {
    margin: 0;
    font-size: 1rem;
    line-height: 1.5rem;
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--vp-c-text-1);
}

.demo-head p {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.5rem;
    color: var(--vp-c-text-2);
}

.demo-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

/* ── Code ────────────────────────────────────────────────────── */

.demo-code {
    --ulc-code-pad: 24px;
    min-width: 0;
    border-right: 1px solid var(--vp-c-divider);
    background: var(--vp-c-bg);
}

.demo-code.vp-doc :deep(div[class*='language-']) {
    margin: 0;
    border-radius: 0;
    background: transparent;
}

.demo-code.vp-doc :deep(pre) {
    padding: 1.25rem 0;
}

.demo-code.vp-doc :deep(code) {
    padding: 0 var(--ulc-code-pad);
}

.demo-code.vp-doc :deep(.line) {
    transition: background-color 0.5s var(--ulc-ease);
}

/* ── Controls ────────────────────────────────────────────────── */

.demo-side {
    min-width: 0;
    display: flex;
    flex-direction: column;
}

.demo-providers {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 0;
    padding: 1rem 1.25rem 1.125rem;
    border: 0;
    border-bottom: 1px solid var(--vp-c-divider);
}

.demo-providers legend {
    float: left;
    width: 100%;
    grid-column: 1 / -1;
    padding: 0;
    margin-bottom: 0.125rem;
    font-size: 0.8125rem;
    line-height: 1.25rem;
    color: var(--vp-c-text-2);
}

.demo-provider {
    min-width: 0;
}

.demo-provider label {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 0.5rem;
    margin-bottom: 0.375rem;
    font-size: 0.875rem;
    line-height: 1.25rem;
    font-weight: 600;
    color: var(--vp-c-text-1);
}

.demo-provider label span {
    font-family: var(--vp-font-family-mono);
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--vp-c-text-2);
}

.demo-select {
    position: relative;
    color: var(--vp-c-text-2);
}

.demo-select select {
    width: 100%;
    height: 2.5rem;
    padding: 0 2rem 0 0.75rem;
    border: 1px solid var(--vp-c-border);
    border-radius: 8px;
    background: var(--vp-c-bg);
    color: var(--vp-c-text-1);
    font-size: 0.875rem;
    text-overflow: ellipsis;
    appearance: none;
    cursor: pointer;
    transition: border-color 0.2s var(--ulc-ease);
}

.demo-select select:hover {
    border-color: var(--vp-c-text-3);
}

.demo-select .ulc-icon {
    position: absolute;
    right: 0.625rem;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
}

/* ── Outcome ─────────────────────────────────────────────────── */

.demo-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-height: 4.25rem;
    padding: 0.75rem 1.25rem;
    border-bottom: 1px solid var(--vp-c-divider);
}

.demo-status p {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.375rem;
    color: var(--vp-c-text-1);
    text-wrap: pretty;
}

.demo-run {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    height: 2.5rem;
    padding: 0 0.875rem;
    border: 1px solid var(--vp-c-border);
    border-radius: 8px;
    background: var(--vp-c-bg);
    font-size: 0.875rem;
    font-weight: 550;
    color: var(--vp-c-text-1);
    transition: border-color 0.2s var(--ulc-ease);
}

.demo-run:hover {
    border-color: var(--vp-c-text-3);
}

/* ── Trace ───────────────────────────────────────────────────── */

/* The height is reserved: a run replaces rows in place and longer traces scroll inside. */
.trace {
    position: relative;
    flex: 1 1 0px;
    min-height: 13.5rem;
    margin: 0;
    padding: 0.5rem 0;
    list-style: none;
    overflow-y: auto;
    scrollbar-width: thin;
    font-family: var(--vp-font-family-mono);
    font-size: 0.8125rem;
    line-height: 1.5rem;
    font-variant-numeric: tabular-nums;
}

.trace:focus-visible {
    outline-offset: -2px;
}

.trace-row {
    display: grid;
    grid-template-columns: 4.25rem 5.75rem 4.5rem minmax(0, 1fr);
    column-gap: 0.75rem;
    align-items: start;
    padding: 0 1.25rem;
    color: var(--vp-c-text-1);
}

.trace-row.is-fresh {
    animation: trace-in 0.45s var(--ulc-ease) both;
}

.trace-at {
    color: var(--vp-c-text-3);
    text-align: right;
}

.trace-event {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    height: 1.5rem;
    font-weight: 600;
}

.trace-mark {
    flex: none;
    width: 1rem;
    height: 1rem;
}

.trace-provider,
.trace-detail {
    min-width: 0;
    color: var(--vp-c-text-2);
}

.trace-row.is-quiet .trace-event {
    color: var(--vp-c-text-2);
}

.trace-row.is-fail .trace-event {
    color: var(--ulc-fail);
}

.trace-row.is-move .trace-event {
    color: var(--ulc-retry);
}

.trace-row.is-ok {
    background: var(--ulc-live-bg);
}

.trace-row.is-ok .trace-event {
    color: var(--ulc-ok);
}

.trace-row.is-ok .trace-detail,
.trace-row.is-ok .trace-provider {
    color: var(--vp-c-text-1);
}

/* The faint ink drops below 4.5:1 on the tinted row. */
.trace-row.is-ok .trace-at {
    color: var(--vp-c-text-2);
}

/* Rows left over from the previous run wait to be replaced. They lose their colour and
   weight, not their legibility. */
.trace-row.is-stale {
    background: none;
}

.trace-row.is-stale .trace-event {
    font-weight: 400;
}

.trace-row.is-stale .trace-at {
    color: var(--vp-c-text-3);
}

.trace-row.is-stale .trace-event,
.trace-row.is-stale .trace-provider,
.trace-row.is-stale .trace-detail {
    color: var(--vp-c-text-2);
}

@keyframes trace-in {
    from {
        opacity: 0;
        transform: translateY(0.25rem);
    }
}

/* ── Narrow ──────────────────────────────────────────────────── */

@media (max-width: 960px) {
    .demo-body {
        grid-template-columns: minmax(0, 1fr);
    }

    .demo-code {
        border-right: 0;
        border-bottom: 1px solid var(--vp-c-divider);
    }

    .trace {
        flex: none;
        height: 13.5rem;
    }
}

@media (max-width: 640px) {
    /* Edge to edge on phones, so the sample's 46 columns fit without scrolling. */
    .demo {
        margin: 0 -1.5rem;
        border-left: 0;
        border-right: 0;
        border-radius: 0;
    }

    .demo-code {
        --ulc-code-pad: 16px;
        --vp-code-font-size: 0.75rem;
    }

    .demo-head,
    .demo-providers,
    .demo-status {
        padding-left: 1rem;
        padding-right: 1rem;
    }

    .demo-providers {
        grid-template-columns: minmax(0, 1fr);
    }

    .demo-provider {
        display: grid;
        grid-template-columns: 7.5rem minmax(0, 1fr);
        align-items: center;
        column-gap: 0.75rem;
    }

    .demo-provider label {
        margin-bottom: 0;
        flex-direction: column;
        align-items: flex-start;
    }

    .demo-status {
        flex-direction: column;
        align-items: stretch;
        gap: 0.75rem;
    }

    .demo-status p {
        min-height: 4.125rem;
    }

    .demo-run {
        justify-content: center;
    }

    .trace {
        height: 20rem;
        font-size: 0.75rem;
    }

    .trace-row {
        grid-template-columns: 4rem 5.5rem minmax(0, 1fr);
        padding: 0.125rem 1rem;
    }

    .trace-detail {
        grid-column: 2 / -1;
        line-height: 1.25rem;
        padding-bottom: 0.125rem;
    }
}

@media (prefers-reduced-motion: reduce) {
    .trace-row.is-fresh {
        animation: none;
    }
}
</style>
