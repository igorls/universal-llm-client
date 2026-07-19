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
    /** Longest repeating pattern to test, in chars (default 64). */
    readonly maxPatternLen?: number;
    /** Tail window inspected for repetition, in chars (default 1024). */
    readonly tailWindow?: number;
    /** Minimum chars the repeated span must cover to count as a loop (default 600). */
    readonly minLoopSpan?: number;
    /** Absolute ceiling on total accumulated chars (default 400_000 ≈ 100K tokens). */
    readonly maxChars?: number;
}

export interface LoopDetection {
    readonly reason: 'repetition' | 'max_chars';
    /** The repeating pattern (trimmed preview) when reason is 'repetition'. */
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

    constructor(options: StreamLoopGuardOptions = {}) {
        this.checkIntervalPushes = options.checkIntervalPushes ?? 50;
        this.minRepeats = options.minRepeats ?? 8;
        this.maxPatternLen = options.maxPatternLen ?? 64;
        this.tailWindow = options.tailWindow ?? 1024;
        this.minLoopSpan = options.minLoopSpan ?? 600;
        this.maxChars = options.maxChars ?? 400_000;
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

        const found = this.detectRepetition();
        if (found) this.detected = found;
        return this.detected;
    }

    private detectRepetition(): LoopDetection | null {
        const tail = this.tail;
        if (tail.length < this.minLoopSpan) return null;

        for (
            let pLen = 3;
            pLen <= Math.min(this.maxPatternLen, Math.floor(tail.length / this.minRepeats));
            pLen++
        ) {
            const pattern = tail.slice(-pLen);
            let repeats = 0;
            let pos = tail.length - pLen;
            while (pos >= 0 && tail.slice(pos, pos + pLen) === pattern) {
                repeats++;
                pos -= pLen;
            }
            if (repeats >= this.minRepeats && repeats * pLen >= this.minLoopSpan) {
                return {
                    reason: 'repetition',
                    pattern: pattern.trim().slice(0, 40),
                    repeats,
                    totalChars: this.totalChars,
                };
            }
        }
        return null;
    }
}
