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
 * Detection runs at three levels, because each earlier level was defeated by a
 * live incident whose repeating unit was one rung larger than it could see:
 *   1. char patterns  — "I'm sorry. " ×N (period ≤ `maxPatternLen`).
 *   2. unit runs      — the same paragraph/line repeated back-to-back (the
 *                       `std.os.args` incident: a 68-char sentence separated by
 *                       blank lines, structurally invisible to level 1).
 *   3. unit CYCLES    — k DIFFERENT paragraphs/lines repeating as a block (the
 *                       threejs-game incident: a 5-paragraph, ~875-char
 *                       "Actually… / Let me try… / Actually I already tried…"
 *                       cycle ×18 — invisible to level 1 because the period far
 *                       exceeds any char pattern, and to level 2 because NO two
 *                       consecutive paragraphs are ever identical).
 *
 * To be loop-proof WITHOUT killing legitimate output, every trigger requires
 * both a repeat count AND a covered-span floor — a markdown separator line
 * ("=====") is a real repetition but only tens of chars; a genuine loop covers
 * hundreds. An absolute `maxChars` ceiling backstops non-repetitive runaways.
 */

export interface StreamLoopGuardOptions {
    /** Run detection every N push() calls (default 50). */
    readonly checkIntervalPushes?: number;
    /** Minimum consecutive repeats of a char-level pattern (default 8). */
    readonly minRepeats?: number;
    /** Longest repeating char-level pattern to test (default 192). */
    readonly maxPatternLen?: number;
    /**
     * Tail window inspected for repetition, in chars (default 16384). Must hold
     * `minCycleRepeats` full cycles of the largest loop worth catching — the
     * live 875-char cycle needed >2.6 KB and the old 2 KB window could not have
     * held it even with a correct detector. Char-level detection always runs on
     * a bounded 2 KB slice of this, so widening costs nothing there.
     */
    readonly tailWindow?: number;
    /** Minimum chars the repeated span must cover to count as a loop (default 600). */
    readonly minLoopSpan?: number;
    /** Absolute ceiling on total accumulated chars (default 400_000 ≈ 100K tokens). */
    readonly maxChars?: number;
    /** Consecutive identical paragraphs/lines that count as a loop (default 4). */
    readonly minParagraphRepeats?: number;
    /** Largest multi-unit cycle period to test, in paragraphs/lines (default 8). */
    readonly maxCyclePeriod?: number;
    /** Repeats required for a multi-unit cycle (period ≥ 2) to count (default 3). */
    readonly minCycleRepeats?: number;
}

export interface LoopDetection {
    readonly reason: 'repetition' | 'paragraph_loop' | 'cycle_loop' | 'max_chars';
    /** The repeating pattern (trimmed preview) when repetition was detected. */
    readonly pattern?: string;
    readonly repeats?: number;
    /** Units in the repeating cycle: 1 for a plain run, k for a k-unit cycle. */
    readonly period?: number;
    readonly totalChars: number;
}

/**
 * Char-level detection only ever finds patterns up to `maxPatternLen`, so it
 * needs `maxPatternLen * minRepeats` chars at most — a bounded slice keeps its
 * O(maxPatternLen × window) scan cheap however wide `tailWindow` grows.
 */
const CHAR_TAIL_WINDOW = 2048;

/** Span floor for a plain run of one identical unit (period 1). */
const UNIT_RUN_SPAN_FLOOR = 240;

/**
 * How many trailing units may be skipped when anchoring a cycle at the end.
 * The final unit is usually an incomplete mid-stream fragment, and a loop
 * sometimes emits a stray line before resuming, so try a few offsets.
 */
const MAX_TRAILING_SKIP = 2;

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
    private readonly maxCyclePeriod: number;
    private readonly minCycleRepeats: number;

    constructor(options: StreamLoopGuardOptions = {}) {
        this.checkIntervalPushes = options.checkIntervalPushes ?? 50;
        this.minRepeats = options.minRepeats ?? 8;
        this.maxPatternLen = options.maxPatternLen ?? 192;
        this.tailWindow = options.tailWindow ?? 16_384;
        this.minLoopSpan = options.minLoopSpan ?? 600;
        this.maxChars = options.maxChars ?? 400_000;
        this.minParagraphRepeats = options.minParagraphRepeats ?? 4;
        this.maxCyclePeriod = options.maxCyclePeriod ?? 8;
        this.minCycleRepeats = options.minCycleRepeats ?? 3;
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

        const found = this.detectRepetition() ?? this.detectUnitLoop();
        if (found) this.detected = found;
        return this.detected;
    }

    /**
     * Runs and cycles of whole paragraphs/lines, whose repeating unit exceeds
     * the char-level pattern cap. Paragraphs first (the common prose loop),
     * then lines (loops separated by a single newline).
     */
    private detectUnitLoop(): LoopDetection | null {
        const opts = {
            maxCyclePeriod: this.maxCyclePeriod,
            minCycleRepeats: this.minCycleRepeats,
            minRunRepeats: this.minParagraphRepeats,
            minLoopSpan: this.minLoopSpan,
        };
        for (const separator of [PARAGRAPH_SEPARATOR, LINE_SEPARATOR]) {
            const units = splitUnits(this.tail, separator);
            const cycle = findTrailingCycle(
                units.map((u) => u.text),
                opts,
            );
            if (cycle) {
                return {
                    reason: cycle.period === 1 ? 'paragraph_loop' : 'cycle_loop',
                    pattern: cycle.block[0]!.slice(0, 40),
                    repeats: cycle.repeats,
                    period: cycle.period,
                    totalChars: this.totalChars,
                };
            }
        }
        return null;
    }

    private detectRepetition(): LoopDetection | null {
        const tail = this.tail.slice(-CHAR_TAIL_WINDOW);
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
                period: 1,
                totalChars: opts.totalChars,
            };
        }
    }
    return null;
}

// ============================================================================
// Unit (paragraph / line) cycle detection
// ============================================================================

const PARAGRAPH_SEPARATOR = /\n{2,}/g;
const LINE_SEPARATOR = /\n+/g;

interface Unit {
    /** Trimmed unit text. */
    readonly text: string;
    /** Offset of the unit's first char in the source string. */
    readonly start: number;
}

/**
 * Split preserving source offsets (`String.split` discards them, and stripping
 * a loop needs to know where in the ORIGINAL text the repetition began).
 * Blank units are dropped; span floors — not a per-unit length floor — are what
 * keep short units like "---" from forming a "loop".
 */
function splitUnits(text: string, separator: RegExp): Unit[] {
    const units: Unit[] = [];
    const re = new RegExp(separator.source, 'g');
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        pushUnit(units, text, cursor, match.index);
        cursor = match.index + match[0].length;
    }
    pushUnit(units, text, cursor, text.length);
    return units;
}

function pushUnit(units: Unit[], text: string, from: number, to: number): void {
    const raw = text.slice(from, to);
    const trimmed = raw.trim();
    if (!trimmed) return;
    units.push({ text: trimmed, start: from + raw.indexOf(trimmed[0]!) });
}

interface CycleMatch {
    /** Units in one cycle (1 = a plain run of one repeated unit). */
    readonly period: number;
    /** How many times the cycle repeats back-to-back. */
    readonly repeats: number;
    /** Index of the first unit of the first repetition. */
    readonly startIndex: number;
    /** Total chars covered by the repeating span. */
    readonly spanChars: number;
    /** The repeating block, one entry per unit of the cycle. */
    readonly block: readonly string[];
}

interface CycleOptions {
    readonly maxCyclePeriod: number;
    readonly minCycleRepeats: number;
    readonly minRunRepeats: number;
    readonly minLoopSpan: number;
}

/**
 * Find the largest end-anchored repeating cycle in `units`.
 *
 * A period-1 result is a plain run (the same unit N× in a row); period ≥ 2 means
 * k different units repeating as a block — the failure mode that a run-only
 * detector structurally cannot see, because no two CONSECUTIVE units match.
 *
 * Thresholds are deliberately asymmetric: a period-1 run is unambiguous
 * degeneration, so 4 repeats over 240 chars is enough, while a multi-unit cycle
 * must clear the full `minLoopSpan` (600 chars) to keep legitimately repetitive
 * structured output from tripping it.
 */
function findTrailingCycle(units: readonly string[], opts: CycleOptions): CycleMatch | null {
    let best: CycleMatch | null = null;

    // A loop's last unit is usually an incomplete mid-stream fragment, and a
    // spiral sometimes emits a stray line before resuming — so anchor at a few
    // offsets from the end rather than only the very last unit.
    for (let skip = 0; skip <= MAX_TRAILING_SKIP; skip++) {
        const end = units.length - skip;
        if (end < 2) break;

        const maxPeriod = Math.min(opts.maxCyclePeriod, Math.floor(end / 2));
        for (let period = 1; period <= maxPeriod; period++) {
            let repeats = 1;
            for (;;) {
                const from = end - (repeats + 1) * period;
                if (from < 0 || !blocksEqual(units, from, end - period, period)) break;
                repeats++;
            }

            const needRepeats = period === 1 ? opts.minRunRepeats : opts.minCycleRepeats;
            if (repeats < needRepeats) continue;

            let blockChars = 0;
            for (let i = end - period; i < end; i++) blockChars += units[i]!.length;
            const spanChars = repeats * blockChars;
            const needSpan = period === 1 ? Math.min(opts.minLoopSpan, UNIT_RUN_SPAN_FLOOR) : opts.minLoopSpan;
            if (spanChars < needSpan) continue;

            // Prefer the widest span; on a tie prefer the smallest period, so
            // "A A A A" reports as a 1-unit run repeated 4× rather than a
            // 2-unit cycle repeated 2×.
            if (!best || spanChars > best.spanChars) {
                best = {
                    period,
                    repeats,
                    startIndex: end - repeats * period,
                    spanChars,
                    block: units.slice(end - period, end),
                };
            }
        }
        if (best) break;
    }

    return best;
}

function blocksEqual(units: readonly string[], a: number, b: number, length: number): boolean {
    for (let i = 0; i < length; i++) {
        if (units[a + i] !== units[b + i]) return false;
    }
    return true;
}

// ============================================================================
// Repeat collapsing — context hygiene for loop-tainted output
// ============================================================================

/**
 * Collapse runs AND cycles of identical paragraphs/lines to a single copy plus
 * a repeat marker. Applied to model output BEFORE it re-enters the
 * conversation context: a completed-but-looping generation (e.g. a think-tool
 * argument that repeated one sentence 100×) otherwise feeds the next
 * iteration, and models reliably continue loops they see in their own prior
 * output. Collapsing both shrinks the context and breaks the reinforcement.
 *
 * Multi-unit cycles are collapsed at the PARAGRAPH level only. Lines cycle
 * legitimately all the time (code, tables, CSV), so line-level collapsing stays
 * restricted to runs of one identical line.
 */
export function collapseRepeatedRuns(text: string, minRun: number = 3): { text: string; collapsed: number } {
    let collapsed = 0;

    const collapseUnits = (units: string[], allowCycles: boolean): string[] => {
        const out: string[] = [];
        let i = 0;
        while (i < units.length) {
            const found = allowCycles
                ? longestCycleAt(units, i, minRun)
                : longestRunAt(units, i, minRun);
            if (found) {
                for (let k = 0; k < found.period; k++) out.push(units[i + k]!);
                out.push(
                    found.period === 1
                        ? `[… repeated ${found.repeats}× — collapsed]`
                        : `[… ${found.period}-part cycle repeated ${found.repeats}× — collapsed]`,
                );
                collapsed += found.period * found.repeats - found.period;
                i += found.period * found.repeats;
            } else {
                out.push(units[i]!);
                i++;
            }
        }
        return out;
    };

    // Paragraph-level first (handles sentence loops and multi-paragraph
    // cycles), then line-level runs within the result.
    const paragraphs = collapseUnits(text.split(/\n{2,}/), true).join('\n\n');
    const lines = collapseUnits(paragraphs.split('\n'), false).join('\n');
    return { text: lines, collapsed };
}

/** Longest run of one identical unit starting at `i`, or null below `minRun`. */
function longestRunAt(units: readonly string[], i: number, minRun: number): { period: 1; repeats: number } | null {
    const unit = units[i]!.trim();
    if (unit.length < 8) return null;
    let repeats = 1;
    while (i + repeats < units.length && units[i + repeats]!.trim() === unit) repeats++;
    return repeats >= minRun ? { period: 1, repeats } : null;
}

/**
 * Longest repeating block starting at `i` — a run (period 1) or a k-unit cycle.
 * Widest coverage wins so a 5-paragraph cycle isn't reported as five
 * unrelated singles.
 */
function longestCycleAt(
    units: readonly string[],
    i: number,
    minRun: number,
): { period: number; repeats: number } | null {
    let best: { period: number; repeats: number; covered: number } | null = null;
    const maxPeriod = Math.min(8, Math.floor((units.length - i) / 2));
    for (let period = 1; period <= maxPeriod; period++) {
        let blockChars = 0;
        for (let k = 0; k < period; k++) blockChars += units[i + k]!.trim().length;
        // Period 1 keeps the historical 8-char floor; a multi-unit cycle must
        // cover enough text that a coincidental repeat is implausible.
        if (period === 1 ? blockChars < 8 : blockChars < 40) continue;

        let repeats = 1;
        while (i + (repeats + 1) * period <= units.length && blockMatches(units, i, i + repeats * period, period)) {
            repeats++;
        }
        if (repeats < (period === 1 ? minRun : Math.max(minRun, 3))) continue;

        const covered = period * repeats;
        if (!best || covered > best.covered) best = { period, repeats, covered };
    }
    return best ? { period: best.period, repeats: best.repeats } : null;
}

function blockMatches(units: readonly string[], a: number, b: number, length: number): boolean {
    for (let k = 0; k < length; k++) {
        if (units[a + k]!.trim() !== units[b + k]?.trim()) return false;
    }
    return true;
}

/**
 * Cut a degenerate repeating tail off a completed generation, keeping the
 * healthy prefix that came before the loop started. Used when a guarded stream
 * is salvaged: the prefix may still contain a usable partial answer, but not
 * one copy of the loop is worth keeping.
 *
 * Returns the input unchanged when no loop is found.
 */
export function stripRepeatedTail(text: string, options: StreamLoopGuardOptions = {}): string {
    const opts: CycleOptions = {
        maxCyclePeriod: options.maxCyclePeriod ?? 8,
        minCycleRepeats: options.minCycleRepeats ?? 3,
        minRunRepeats: options.minParagraphRepeats ?? 4,
        minLoopSpan: options.minLoopSpan ?? 600,
    };

    for (const separator of [PARAGRAPH_SEPARATOR, LINE_SEPARATOR]) {
        const units = splitUnits(text, separator);
        const cycle = findTrailingCycle(
            units.map((u) => u.text),
            opts,
        );
        if (cycle) return text.slice(0, units[cycle.startIndex]!.start).trimEnd();
    }

    // Char-level fallback: a loop with no newlines at all ("I'm sorry. " ×N).
    const minRepeats = options.minRepeats ?? 8;
    const maxPatternLen = options.maxPatternLen ?? 192;
    const tail = text.slice(-CHAR_TAIL_WINDOW);
    for (let pLen = 3; pLen <= Math.min(maxPatternLen, Math.floor(tail.length / minRepeats)); pLen++) {
        const pattern = tail.slice(-pLen);
        let repeats = 0;
        let pos = text.length - pLen;
        while (pos >= 0 && text.slice(pos, pos + pLen) === pattern) {
            repeats++;
            pos -= pLen;
        }
        if (repeats >= minRepeats && repeats * pLen >= opts.minLoopSpan) {
            return text.slice(0, pos + pLen).trimEnd();
        }
    }

    return text;
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
