<script setup lang="ts">
import { computed, ref } from 'vue'
import { installCommands } from './data'
import UlcIcon from './UlcIcon.vue'

const props = defineProps<{ idPrefix: string }>()

type ManagerId = (typeof installCommands)[number]['id']

const manager = ref<ManagerId>('npm')
const status = ref<'idle' | 'copied' | 'failed'>('idle')
let resetTimer: ReturnType<typeof setTimeout> | undefined

const command = computed(() => installCommands.find((m) => m.id === manager.value)!.command)

async function copy() {
    try {
        await navigator.clipboard.writeText(command.value)
        status.value = 'copied'
    } catch {
        status.value = 'failed'
    }
    clearTimeout(resetTimer)
    resetTimer = setTimeout(() => {
        status.value = 'idle'
    }, 2400)
}
</script>

<template>
    <div class="install">
        <div class="install-managers" role="radiogroup" aria-label="Package manager">
            <label v-for="m in installCommands" :key="m.id" class="install-manager">
                <input v-model="manager" type="radio" :name="`${props.idPrefix}-manager`" :value="m.id" />
                <span>{{ m.id }}</span>
            </label>
        </div>
        <div class="install-row">
            <code class="install-command">{{ command }}</code>
            <button type="button" class="install-copy" @click="copy">
                <UlcIcon :name="status === 'copied' ? 'check' : 'copy'" />
                <span>{{ status === 'copied' ? 'Copied' : 'Copy' }}</span>
            </button>
        </div>
        <p class="install-status" role="status" aria-live="polite">
            <template v-if="status === 'copied'">Install command copied.</template>
            <template v-else-if="status === 'failed'">Copying was blocked. Select the command and copy it by hand.</template>
        </p>
    </div>
</template>

<style scoped>
.install {
    width: 100%;
    max-width: 30rem;
}

.install-managers {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
}

.install-manager {
    position: relative;
    cursor: pointer;
}

.install-manager input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
}

.install-manager span {
    display: block;
    padding: 0.3125rem 0.75rem;
    border-radius: 6px;
    font-family: var(--vp-font-family-mono);
    font-size: 0.8125rem;
    line-height: 1.25rem;
    color: var(--vp-c-text-2);
    transition: color 0.2s var(--ulc-ease), background-color 0.2s var(--ulc-ease);
}

.install-manager:hover span {
    color: var(--vp-c-text-1);
}

.install-manager input:checked + span {
    color: var(--vp-c-text-1);
    background: var(--vp-c-bg-soft);
    box-shadow: inset 0 0 0 1px var(--vp-c-border);
}

.install-manager input:focus-visible + span {
    outline: 2px solid var(--vp-c-brand-1);
    outline-offset: 2px;
}

.install-row {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--vp-c-border);
    border-radius: var(--ulc-radius);
    background: var(--vp-c-bg-alt);
    overflow: hidden;
}

.install-command {
    flex: 1;
    min-width: 0;
    padding: 0.8125rem 1rem;
    font-family: var(--vp-font-family-mono);
    font-size: 0.875rem;
    line-height: 1.5rem;
    color: var(--vp-c-text-1);
    white-space: nowrap;
    overflow-x: auto;
    scrollbar-width: thin;
}

.install-copy {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4375rem;
    width: 6.25rem;
    border-left: 1px solid var(--vp-c-border);
    font-size: 0.875rem;
    font-weight: 550;
    color: var(--vp-c-text-1);
    transition: background-color 0.2s var(--ulc-ease), color 0.2s var(--ulc-ease);
}

.install-copy:hover {
    background: var(--vp-c-bg-soft);
}

.install-copy:focus-visible {
    outline-offset: -2px;
}

@media (pointer: coarse) {
    .install-manager span {
        padding: 0.625rem 0.875rem;
    }
}

@media (max-width: 480px) {
    .install-command {
        padding: 0.8125rem 0.5rem 0.8125rem 0.75rem;
        font-size: 0.75rem;
        scrollbar-width: none;
    }

    .install-copy {
        width: 3rem;
    }

    .install-copy span {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
    }
}

.install-status {
    min-height: 1.25rem;
    margin: 0.375rem 0 0;
    font-size: 0.8125rem;
    line-height: 1.25rem;
    color: var(--vp-c-text-2);
}
</style>
