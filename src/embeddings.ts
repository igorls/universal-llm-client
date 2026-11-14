/**
 * Universal LLM Client — Embedding requests
 *
 * Types and helpers shared by every client's `embedMany()`: the task an input
 * is embedded for, the prompt format that turns a task into model input, and
 * Matryoshka truncation of returned vectors.
 *
 * Prompt formats are declared, never guessed from a model name: the caller
 * picks one (per client in `LLMClientOptions.embeddingPromptFormat`, or per
 * call), because the formatting is part of the vector space. Vectors embedded
 * with and without a format are not comparable.
 */

/**
 * What an input is embedded for. Retrieval models embed a search query and the
 * documents it searches differently, so the two sides must say which they are.
 */
export type EmbeddingTask = 'query' | 'document' | 'similarity' | 'classification' | 'clustering' | 'code';

/** One input to embed. `title` is used by formats that take a document title. */
export interface EmbeddingInput {
    readonly text: string;
    readonly title?: string;
}

/**
 * How a task becomes model input. A template holds `{text}` and, optionally,
 * `{title}`. A task without a template is sent as the plain text.
 */
export interface EmbeddingPromptFormat {
    /** Stable identifier, reported in {@link EmbeddingResult.promptFormat}. */
    readonly id: string;
    readonly templates: Readonly<Partial<Record<EmbeddingTask, string>>>;
    /** Substituted for `{title}` when an input has no title. Default: empty string. */
    readonly missingTitle?: string;
}

/**
 * Prompt formats published on the model cards of common embedding families.
 * Choose one explicitly; the library does not match it to a model name.
 */
export const EMBEDDING_PROMPT_FORMATS = {
    /** Plain text for every task. */
    none: { id: 'none', templates: {} },
    /** EmbeddingGemma (both generations). */
    embeddinggemma: {
        id: 'embeddinggemma',
        templates: {
            query: 'task: search result | query: {text}',
            document: 'title: {title} | text: {text}',
            similarity: 'task: sentence similarity | query: {text}',
            classification: 'task: classification | query: {text}',
            clustering: 'task: clustering | query: {text}',
            code: 'task: code retrieval | query: {text}',
        },
        missingTitle: 'none',
    },
    /** Qwen3-Embedding: an instruction on the query side, documents as plain text. */
    'qwen3-embedding': {
        id: 'qwen3-embedding',
        templates: {
            query: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:{text}',
        },
    },
    /** nomic-embed-text (v1.5 and v2). */
    nomic: {
        id: 'nomic',
        templates: {
            query: 'search_query: {text}',
            document: 'search_document: {text}',
            classification: 'classification: {text}',
            clustering: 'clustering: {text}',
        },
    },
    /** E5 family. */
    e5: {
        id: 'e5',
        templates: {
            query: 'query: {text}',
            document: 'passage: {text}',
            similarity: 'query: {text}',
        },
    },
    /** mxbai-embed-large: an instruction on the query side only. */
    mxbai: {
        id: 'mxbai',
        templates: {
            query: 'Represent this sentence for searching relevant passages: {text}',
        },
    },
} as const satisfies Record<string, EmbeddingPromptFormat>;

export type EmbeddingPromptFormatName = keyof typeof EMBEDDING_PROMPT_FORMATS;

/** Options for `embedMany()`. */
export interface EmbedOptions {
    /** What the inputs are embedded for. Without a task, inputs are sent as plain text. */
    task?: EmbeddingTask;
    /**
     * Prompt format for this call, by name or as a format. Overrides the
     * client's `embeddingPromptFormat`. Ignored by protocols that take the task
     * natively (Gemini sends it as `taskType`).
     */
    promptFormat?: EmbeddingPromptFormat | EmbeddingPromptFormatName;
    /**
     * Output size. Sent to servers that accept it (OpenAI-compatible
     * `dimensions`, Ollama `dimensions`, Gemini `outputDimensionality`). A
     * longer vector that comes back anyway is cut to this size and
     * re-normalized, which is only meaningful for Matryoshka-trained models.
     */
    dimensions?: number;
    /** Inputs per HTTP request. Default: the protocol's own limit. */
    batchSize?: number;
    /** Let the server truncate inputs longer than the model's window (Ollama). Default: true. */
    truncate?: boolean;
    /** Ollama `keep_alive` for the embedding model. */
    keepAlive?: string | number;
    signal?: AbortSignal;
}

/** What `embedMany()` returns. */
export interface EmbeddingResult {
    /** One vector per input, in input order. */
    embeddings: number[][];
    /** Model the server reported, or the configured one. */
    model: string;
    /** Length of the returned vectors. */
    dimensions: number;
    /** Id of the prompt format applied; `'none'` when inputs went as plain text. */
    promptFormat: string;
    task?: EmbeddingTask;
    /** Input tokens, when the server reports them. */
    inputTokens?: number;
}

/** What a protocol sends back for one batch; `embedMany()` assembles the result. */
export interface EmbeddingBatchResponse {
    embeddings: number[][];
    model?: string;
    inputTokens?: number;
}

/** What a protocol receives for one batch. Texts are already formatted. */
export interface EmbeddingBatchRequest {
    texts: string[];
    /** Original titles, for protocols that take them natively. */
    titles: (string | undefined)[];
    task?: EmbeddingTask;
    dimensions?: number;
    truncate: boolean;
    keepAlive?: string | number;
    signal?: AbortSignal;
}

/** Normalize `string | EmbeddingInput` arrays to inputs. */
export function toEmbeddingInputs(inputs: readonly (string | EmbeddingInput)[]): EmbeddingInput[] {
    return inputs.map(input => (typeof input === 'string' ? { text: input } : input));
}

/** Resolve a format given by name or value. Unknown names throw. */
export function resolveEmbeddingPromptFormat(
    format: EmbeddingPromptFormat | string | undefined,
): EmbeddingPromptFormat {
    if (format === undefined) return EMBEDDING_PROMPT_FORMATS.none;
    if (typeof format !== 'string') return format;
    const preset = (EMBEDDING_PROMPT_FORMATS as Record<string, EmbeddingPromptFormat>)[format];
    if (!preset) {
        throw new Error(
            `Unknown embedding prompt format '${format}'. Known: ${Object.keys(EMBEDDING_PROMPT_FORMATS).join(', ')}`,
        );
    }
    return preset;
}

/**
 * Apply a format to one input. Placeholders are replaced in one pass, so a
 * `{text}` inside a title (or the reverse) is left as written.
 */
export function formatEmbeddingInput(
    input: EmbeddingInput,
    task: EmbeddingTask | undefined,
    format: EmbeddingPromptFormat,
): string {
    const template = task ? format.templates[task] : undefined;
    if (!template) return input.text;
    const title = input.title?.trim() || format.missingTitle || '';
    return template.replace(/\{(text|title)\}/g, (_match, key: string) => (key === 'text' ? input.text : title));
}

/** Whether `format` changes the input for `task`. */
export function promptFormatApplies(format: EmbeddingPromptFormat, task: EmbeddingTask | undefined): boolean {
    return task !== undefined && format.templates[task] !== undefined;
}

/** Scale a vector to unit length. A zero vector is returned unchanged. */
export function normalizeEmbedding(vector: readonly number[]): number[] {
    let sum = 0;
    for (const value of vector) sum += value * value;
    const norm = Math.sqrt(sum);
    if (!Number.isFinite(norm) || norm === 0) return [...vector];
    return vector.map(value => value / norm);
}

/**
 * Cut a vector to its first `dimensions` values and re-normalize (Matryoshka
 * truncation). A vector already at or below that size is returned unchanged.
 */
export function truncateEmbedding(vector: readonly number[], dimensions: number): number[] {
    if (!Number.isInteger(dimensions) || dimensions <= 0 || vector.length <= dimensions) return [...vector];
    return normalizeEmbedding(vector.slice(0, dimensions));
}
