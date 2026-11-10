<script setup lang="ts">
/** One icon family: 16px grid, 1.5px round stroke, drawn here. */
defineProps<{ name: 'copy' | 'check' | 'cross' | 'arrow' | 'retry' | 'chevron' }>()
</script>

<template>
    <svg
        class="ulc-icon"
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
    >
        <template v-if="name === 'copy'">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 5.5v-1a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1" />
        </template>
        <path v-else-if="name === 'check'" d="M3 8.5 6.5 12 13 4.5" />
        <path v-else-if="name === 'cross'" d="m4 4 8 8m0-8-8 8" />
        <path v-else-if="name === 'arrow'" d="M3 8h10M9 4l4 4-4 4" />
        <template v-else-if="name === 'retry'">
            <path d="M13 8a5 5 0 1 1-1.6-3.7" />
            <path d="M13 2.5v3h-3" />
        </template>
        <path v-else-if="name === 'chevron'" d="m4 6 4 4 4-4" />
    </svg>
</template>

<style scoped>
.ulc-icon {
    flex: none;
    display: block;
}
</style>
