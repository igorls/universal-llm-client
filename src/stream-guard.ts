/**
 * Stream Loop Guard — client-side runaway protection for streamed generations.
 *
 * Hard-window backends (vLLM, llama.cpp) generate until the window fills when
 * max_tokens is omitted, and a degenerate model can loop for minutes ("I'm
 * sorry. I'm sorry. …" or an endless reasoning spiral). Server-side sampling
 * guards don't catch semantic loops, so the CLIENT must: feed every streamed
 * delta (content AND reasoning — reasoning loops are the common case for
 * thinking models) into the guard, and when it triggers, abort the underlying
 * request so the server stops generating.
 *
 * Detection: the tail of the accumulated output is one short pattern repeated
 * back-to-back. To be loop-proof WITHOUT killing legitimate output, a trigger
 * requires all of:
 *   - the pattern repeats at least `minRepeats` times consecutively, AND
 *   - the repeated span covers at least `minLoopSpan` chars — a markdown
 *     separator line ("=====", "-----") is a real repetition but only tens of
 *     chars; a genuine loop covers hundreds.
 * An absolute `maxChars` ceiling backstops non-repetitive runaways.
 */

export interface StreamLoopGuardOptions {
    /** Run detection every N push() calls (default 50). */
    readonly checkIntervalPushes?: number;
    /** Minimum consecutive repeats of a pattern (default 8). */
    readonly minRepeats?: number;
    /** Longest repeating char-level pattern to test (default 192). */
    readonly maxPatternLen?: number;
    /** Tail window inspected for repetition, in chars (default 2048). */
    readonly tailWindow?: number;
    /** Minimum chars the repeated span must cover to count as a loop (default 600). */
    readonly minLoopSpan?: number;
    /** Absolute ceiling on total accumulated chars (default 400_000 ≈ 100K tokens). */
    readonly maxChars?: number;
    /** Consecutive identical paragraphs (blank-line separated) that count as a loop (default 4). */
    readonly minParagraphRepeats?: number;
}

export interface LoopDetection {
    readonly reason: 'repetition' | 'paragraph_loop' | 'max_chars';
    /** The repeating pattern (trimmed preview) when repetition was detected. */
    readonly pattern?: string;
    readonly repeats?: number;
    readonly totalChars: number;
}

export class StreamLoopGuard {
    private tail = '';
    private totalChars = 0;
    private pushes = 0;
    private detected: LoopDetection | null = null;

    private readonly checkIntervalPushes: number;
    private readonly minRepeats: number;
    private readonly maxPatternLen: number;
    private readonly tailWindow: number;
    private readonly minLoopSpan: number;
    private readonly maxChars: number;

    private readonly minParagraphRepeats: number;

    constructor(options: StreamLoopGuardOptions = {}) {
        this.checkIntervalPushes = options.checkIntervalPushes ?? 50;
        this.minRepeats = options.minRepeats ?? 8;
        this.maxPatternLen = options.maxPatternLen ?? 192;
        this.tailWindow = options.tailWindow ?? 2048;
        this.minLoopSpan = options.minLoopSpan ?? 600;
        this.maxChars = options.maxChars ?? 400_000;
        this.minParagraphRepeats = options.minParagraphRepeats ?? 4;
    }

    /** The detection result once triggered; null while the stream is healthy. */
    get detection(): LoopDetection | null {
        return this.detected;
    }

    /**
     * Feed a streamed delta. Returns the detection when this push (or an
     * earlier one) established a loop, else null.
     */
    push(text: string): LoopDetection | null {
        if (this.detected) return this.detected;
        if (!text) return null;

        this.totalChars += text.length;
        this.tail = (this.tail + text).slice(-this.tailWindow);
        this.pushes++;

        if (this.totalChars > this.maxChars) {
            this.detected = { reason: 'max_chars', totalChars: this.totalChars };
            return this.detected;
        }

        if (this.pushes % this.checkIntervalPushes !== 0) return null;

        const found = this.detectRepetition() ?? this.detectParagraphLoop();
        if (found) this.detected = found;
        return this.detected;
    }

    /**
     * Sentence/paragraph loops whose repeating unit exceeds the char-level
     * pattern cap (the live incident looped a ~68-char sentence separated by
     * blank lines, which char-level pattern search structurally missed):
     * split the tail into blank-line-separated paragraphs and count
     * consecutive identical ones from the end.
     */
    private detectParagraphLoop(): LoopDetection | null {
        const paragraphs = this.tail
            .split(/\n{2,}/)
            .map((p) => p.trim())
            .filter((p) => p.length >= 8);
        if (paragraphs.length < this.minParagraphRepeats) return null;

        // Longest run of identical consecutive paragraphs anywhere in the tail
        // (the final paragraph is usually an incomplete mid-stream fragment, so
        // an end-anchored check would miss the loop right behind it).
        let bestRun = 1;
        let bestParagraph = '';
        let run = 1;
        for (let i = 1; i < paragraphs.length; i++) {
            run = paragraphs[i] === paragraphs[i - 1] ? run + 1 : 1;
            if (run > bestRun) {
                bestRun = run;
                bestParagraph = paragraphs[i]!;
            }
        }

        if (bestRun >= this.minParagraphRepeats && bestRun * bestParagraph.length >= Math.min(this.minLoopSpan, 240)) {
            return {
                reason: 'paragraph_loop',
                pattern: bestParagraph.slice(0, 40),
                repeats: bestRun,
                totalChars: this.totalChars,
            };
        }
        return null;
    }

    private detectRepetition(): LoopDetection | null {
        const tail = this.tail;
        if (tail.length < this.minLoopSpan) return null;
        return detectCharPatternLoop(tail, {
            minRepeats: this.minRepeats,
            maxPatternLen: this.maxPatternLen,
            minLoopSpan: this.minLoopSpan,
            totalChars: this.totalChars,
        });
    }
}

function detectCharPatternLoop(
    tail: string,
    opts: { minRepeats: number; maxPatternLen: number; minLoopSpan: number; totalChars: number },
): LoopDetection | null {
    for (
        let pLen = 3;
        pLen <= Math.min(opts.maxPatternLen, Math.floor(tail.length / opts.minRepeats));
        pLen++
    ) {
        const pattern = tail.slice(-pLen);
        let repeats = 0;
        let pos = tail.length - pLen;
        while (pos >= 0 && tail.slice(pos, pos + pLen) === pattern) {
            repeats++;
            pos -= pLen;
        }
        if (repeats >= opts.minRepeats && repeats * pLen >= opts.minLoopSpan) {
            return {
                reason: 'repetition',
                pattern: pattern.trim().slice(0, 40),
                repeats,
                totalChars: opts.totalChars,
            };
        }
    }
    return null;
}

// ============================================================================
// Repeat collapsing — context hygiene for loop-tainted output
// ============================================================================

/**
 * Collapse runs of identical consecutive paragraphs/lines to a single copy
 * plus a repeat marker. Applied to model output BEFORE it re-enters the
 * conversation context: a completed-but-looping generation (e.g. a think-tool
 * argument that repeated one sentence 100×) otherwise feeds the next
 * iteration, and models reliably continue loops they see in their own prior
 * output. Collapsing both shrinks the context and breaks the reinforcement.
 */
export function collapseRepeatedRuns(text: string, minRun: number = 3): { text: string; collapsed: number } {
    let collapsed = 0;

    const collapseUnits = (units: string[], joiner: string): string[] => {
        const out: string[] = [];
        let i = 0;
        while (i < units.length) {
            const unit = units[i]!;
            let run = 1;
            while (i + run < units.length && units[i + run]!.trim() === unit.trim() && unit.trim().length >= 8) {
                run++;
            }
            if (run >= minRun) {
                out.push(unit, `[… repeated ${run}× — collapsed]`);
                collapsed += run - 1;
            } else {
                for (let k = 0; k < run; k++) out.push(units[i + k]!);
            }
            i += run;
        }
        void joiner;
        return out;
    };

    // Paragraph-level first (handles sentence loops separated by blank lines),
    // then line-level within the result.
    const paragraphs = collapseUnits(text.split(/\n{2,}/), '\n\n').join('\n\n');
    const lines = collapseUnits(paragraphs.split('\n'), '\n').join('\n');
    return { text: lines, collapsed };
}

/**
 * Collapse repeated runs inside every string value of a JSON tool-argument
 * payload (loops live inside e.g. `{"thought": "..."}` — collapsing the raw
 * JSON text would corrupt escaping). Returns the original string when it
 * isn't valid JSON or nothing was collapsed.
 */
export function collapseRepeatsInToolArguments(argsJson: string): { argsJson: string; collapsed: number } {
    try {
        const parsed = JSON.parse(argsJson) as unknown;
        let collapsed = 0;
        const walk = (value: unknown): unknown => {
            if (typeof value === 'string' && value.length >= 200) {
                const result = collapseRepeatedRuns(value);
                collapsed += result.collapsed;
                return result.text;
            }
            if (Array.isArray(value)) return value.map(walk);
            if (value && typeof value === 'object') {
                const out: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(value)) out[k] = walk(v);
                return out;
            }
            return value;
        };
        const rewritten = walk(parsed);
        return collapsed > 0 ? { argsJson: JSON.stringify(rewritten), collapsed } : { argsJson, collapsed: 0 };
    } catch {
        return { argsJson, collapsed: 0 };
    }
}
