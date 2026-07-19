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

// Wire variants observed live: `<|channel>thought`, `<|channel|>thought`,
// `<|channel|>' think'` (quoted, spaced, `think` instead of `thought`).
// The opener matching is deliberately lenient — the marker prefix
// `<|channel` is distinctive enough that false positives are implausible.
const GEMMA_THOUGHT_BLOCK = /<\|channel\|?>\s*'?\s*(?:thought|think)\s*'?\s*\r?\n?([\s\S]*?)<channel\|>/gi;
const GEMMA_COMPACT_THOUGHT_BLOCK = /<\|thought\s*\r?\n?([\s\S]*?)\|>/gi;

/**
 * A bare channel marker with no matching close — leaks verbatim into the
 * user-visible thinking/content when a server-side reasoning parser has
 * already routed the text but left the literal marker in place (observed:
 * `<|channel|>' think'` at the head of the thinking display).
 */
const GEMMA_BARE_MARKER = /<\|?channel\|?>?\s*'?\s*(?:thought|think|analysis|final|response|answer)?\s*'?\s*(?:\r?\n|$)/gi;

export const GEMMA_THOUGHT_OPENERS = ['<|channel>thought', '<|channel|>thought', '<|thought'] as const;

/**
 * Strip stray channel markers that survived block extraction (unmatched
 * openers/closers, quoted variants). Applied to final reasoning/content —
 * never mid-stream on partial chunks.
 */
export function stripGemmaChannelMarkers(text: string): string {
    if (!text || !text.includes('channel')) return text;
    return text.replace(GEMMA_BARE_MARKER, '').replace(/^<channel\|>\s*/gm, '');
}

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
