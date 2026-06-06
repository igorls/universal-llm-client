/**
 * Gemma 4 can emit its thought channel as text control tokens instead of the
 * generic Ollama `message.thinking` field. Keep that provider quirk isolated so
 * callers receive final-answer text and reasoning separately.
 */

export interface GemmaThoughtExtraction {
    readonly content: string;
    readonly reasoning: string;
    readonly found: boolean;
}

const GEMMA_THOUGHT_BLOCK = /<\|channel>\s*thought\s*\r?\n?([\s\S]*?)<channel\|>/gi;
const GEMMA_COMPACT_THOUGHT_BLOCK = /<\|thought\s*\r?\n?([\s\S]*?)\|>/gi;

export const GEMMA_THOUGHT_OPENERS = ['<|channel>thought', '<|thought'] as const;

export function extractGemmaThoughtChannels(input: string): GemmaThoughtExtraction {
    if (!input) return { content: input, reasoning: '', found: false };

    const reasoningParts: string[] = [];
    let found = false;

    const content = input
        .replace(GEMMA_THOUGHT_BLOCK, (_match, thought: string) => {
            found = true;
            const normalized = normalizeGemmaThought(thought);
            if (normalized) reasoningParts.push(normalized);
            return '';
        })
        .replace(GEMMA_COMPACT_THOUGHT_BLOCK, (_match, thought: string) => {
            found = true;
            const normalized = normalizeGemmaThought(thought);
            if (normalized) reasoningParts.push(normalized);
            return '';
        });

    return {
        content,
        reasoning: reasoningParts.join('\n\n'),
        found,
    };
}

export function normalizeGemmaThought(thought: string): string {
    return thought.replace(/^\s+/, '').replace(/\s+$/, '');
}
