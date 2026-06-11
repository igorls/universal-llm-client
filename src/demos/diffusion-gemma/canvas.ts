/**
 * DiffusionGemma — "Signal from Noise" chat experience.
 *
 * DiffusionGemma drafts whole 256-token blocks at once and denoises them
 * iteratively. The vLLM OpenAI-compatible stream collapses that process into
 * one big SSE burst per finished block (~1KB every ~1s, measured), so true
 * per-step state is not observable. This UI is an honest dramatization built
 * on the real signals we DO have:
 *
 *   - chunk boundaries  = real 256-token block boundaries
 *   - chunk timing      = real per-block compute duration
 *   - chunk text        = real final text
 *
 * Each reply renders instantly as flickering noise glyphs in its final layout
 * (monospace ⇒ zero layout shift), then resolves in waves while the NEXT
 * block is genuinely being computed server-side. A deterministic, seekable
 * lock schedule makes every materialization replayable and scrubbable.
 *
 * NOTE for editors: this file is a TS template literal. Backslash escapes in
 * the inner <script> WOULD be eaten by the outer literal (the old version's
 * /\S+/ silently became /S+/). The inner script therefore uses NO backslashes:
 * newlines via String.fromCharCode(10), tokenizing via charCode scanning.
 */

export const CANVAS_HTML = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DiffusionGemma ⁄ Signal from Noise</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<link rel="icon" href="data:,">
<style>
:root {
    --ink: #06090b;
    --ink-2: #0a0f13;
    --panel: #0c1216;
    --line: #1a2730;
    --line-soft: #142028;
    --bone: #f2eee1;
    --bone-dim: #c6c1b2;
    --dim: #7790a1;
    --sans: 'IBM Plex Sans', -apple-system, sans-serif;
    --faint: #364854;
    --noise: #415866;
    --signal: #c8f24e;
    --signal-soft: rgba(200, 242, 78, 0.14);
    --amber: #e8b34b;
    --red: #ff6258;
    --mono: 'IBM Plex Mono', ui-monospace, monospace;
    --serif: 'Instrument Serif', Georgia, serif;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

/* Everything is rem-based: scale the root with the viewport so the UI
   stays readable on large displays and in screen recordings. */
html { font-size: clamp(15px, 9px + 0.55vw, 22px); }

html, body { height: 100%; }

body {
    font-family: var(--mono);
    background: var(--ink);
    color: var(--bone);
    overflow: hidden;
}

/* ── Atmosphere: deep-field gradient, scanlines, vignette, grain ── */
body::before {
    content: '';
    position: fixed; inset: 0;
    background:
        radial-gradient(ellipse 70% 55% at 18% -5%, rgba(200,242,78,0.045), transparent 60%),
        radial-gradient(ellipse 55% 45% at 95% 100%, rgba(105,160,190,0.05), transparent 65%),
        radial-gradient(ellipse 120% 100% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%);
    pointer-events: none; z-index: 0;
}

.scan {
    position: fixed; inset: 0; z-index: 1; pointer-events: none;
    background: repeating-linear-gradient(0deg,
        rgba(255,255,255,0.022) 0px, rgba(255,255,255,0.022) 1px,
        transparent 1px, transparent 3px);
    mix-blend-mode: overlay;
}

#grain {
    position: fixed; inset: 0; width: 100vw; height: 100vh;
    z-index: 1; pointer-events: none;
    image-rendering: pixelated;
    mix-blend-mode: screen;
    opacity: 0;
    transition: opacity 0.6s ease;
}
#grain.on { opacity: 0.055; }

/* ── Frame ── */
.frame {
    position: relative; z-index: 2;
    height: 100vh;
    display: flex; flex-direction: column;
}

header {
    flex: 0 0 auto;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.85rem 1.4rem;
    border-bottom: 1px solid var(--line-soft);
    background: rgba(6,9,11,0.7);
    backdrop-filter: blur(6px);
}

.brand { display: flex; align-items: baseline; gap: 0.9rem; }

.lamp {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--faint);
    align-self: center;
    transition: all 0.4s;
}
.lamp.live { background: var(--signal); box-shadow: 0 0 10px rgba(200,242,78,0.7); }
.lamp.dead { background: var(--red); box-shadow: 0 0 8px rgba(255,98,88,0.6); }
.lamp.warm { background: var(--amber); box-shadow: 0 0 10px rgba(232,179,75,0.7); animation: breathe 1.2s ease-in-out infinite; }

.brand h1 {
    font-size: 0.95rem; font-weight: 700;
    letter-spacing: 0.22em;
    color: var(--bone);
}
.brand h1 em { color: var(--signal); font-style: normal; }

.tagline {
    font-family: var(--serif); font-style: italic;
    font-size: 1.02rem; color: var(--dim);
    letter-spacing: 0.01em;
}

.head-right { display: flex; align-items: center; gap: 0.75rem; }

.model-chip {
    font-size: 0.62rem; color: var(--dim);
    letter-spacing: 0.06em;
    padding: 0.3rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: 3px;
    max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.harness-link {
    font-size: 0.62rem; color: var(--dim); text-decoration: none;
    letter-spacing: 0.1em;
    padding: 0.3rem 0.65rem;
    border: 1px solid var(--line); border-radius: 3px;
    transition: all 0.2s;
}
.harness-link:hover { color: var(--signal); border-color: var(--signal); }

/* ── Stage: feed + rail ── */
.stage { flex: 1 1 auto; display: flex; min-height: 0; }

.feed-wrap {
    flex: 1 1 auto; min-width: 0;
    display: flex; flex-direction: column;
}

#feed {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 2rem 2rem 1rem;
    scroll-behavior: auto;
}
#feed::-webkit-scrollbar { width: 4px; }
#feed::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }

.feed-inner { max-width: 54rem; margin: 0 auto; }

/* ── Empty state ── */
.empty {
    padding: 14vh 1rem 0;
    text-align: center;
}
.empty .big {
    font-family: var(--serif); font-style: italic;
    font-size: clamp(2.2rem, 5vw, 3.4rem);
    color: var(--bone);
    line-height: 1.1;
}
.empty .big .lit { color: var(--signal); }
.empty .sub {
    margin: 1.1rem auto 0; max-width: 470px;
    font-size: 0.72rem; line-height: 1.8; color: var(--dim);
    letter-spacing: 0.03em;
}
.empty .chips { margin-top: 2rem; display: flex; gap: 0.6rem; justify-content: center; flex-wrap: wrap; }
.chip {
    font-family: var(--mono); font-size: 0.78rem; color: var(--bone-dim);
    background: transparent;
    border: 1px solid var(--line); border-radius: 3px;
    padding: 0.5rem 0.85rem; cursor: pointer;
    letter-spacing: 0.04em;
    transition: all 0.2s;
}
.chip:hover { border-color: var(--signal); color: var(--signal); background: var(--signal-soft); }

/* ── Messages ── */
.msg { margin-bottom: 2.1rem; animation: rise 0.35s ease-out; }
@keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

.msg .who {
    display: flex; align-items: center; gap: 0.6rem;
    font-size: 0.72rem; letter-spacing: 0.2em; color: var(--faint);
    margin-bottom: 0.6rem;
}
.msg.user .who { color: var(--dim); justify-content: flex-end; }
.msg.ai .who .name { color: var(--signal); }

.who .phase { color: var(--dim); letter-spacing: 0.08em; }
.who .phase.working { color: var(--amber); animation: breathe 1.4s ease-in-out infinite; }
@keyframes breathe { 50% { opacity: 0.45; } }

.who .thought-chip {
    color: var(--amber);
    border: 1px solid rgba(232,179,75,0.35); border-radius: 3px;
    padding: 0.1rem 0.4rem;
    letter-spacing: 0.1em;
    font-size: 0.56rem;
}

.msg.user .body {
    margin-left: auto;
    max-width: 78%;
    width: fit-content;
    font-size: 0.95rem; line-height: 1.7;
    color: var(--bone-dim);
    background: var(--ink-2);
    border: 1px solid var(--line-soft);
    border-right: 2px solid var(--faint);
    border-radius: 6px 2px 2px 6px;
    padding: 0.7rem 0.95rem;
    white-space: pre-wrap; word-break: break-word;
}

.msg.ai .body {
    border-left: 1px solid var(--line-soft);
    padding-left: 1.2rem;
}

.answer-body {
    font-size: 1.05rem; line-height: 1.95;
    white-space: pre-wrap; word-break: break-word;
}

/* ── Rendered markdown view: fades in when the reply settles. The mono
     token surface is the animation; this is the reading layer. ── */
.md-body {
    display: none;
    font-family: var(--sans);
    font-size: 1.08rem; line-height: 1.75;
    color: var(--bone);
    word-break: break-word;
    animation: mdin 0.6s ease;
}
.md-body.show { display: block; }
@keyframes mdin { from { opacity: 0; filter: blur(3px); } to { opacity: 1; filter: none; } }

.md-body p { margin: 0 0 0.85em; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4 {
    font-family: var(--serif); font-weight: 400;
    color: var(--bone);
    margin: 1.1em 0 0.45em; line-height: 1.25;
}
.md-body h1 { font-size: 1.7rem; }
.md-body h2 { font-size: 1.45rem; }
.md-body h3 { font-size: 1.22rem; font-style: italic; }
.md-body h4 { font-size: 1.08rem; font-style: italic; color: var(--bone-dim); }
.md-body ul, .md-body ol { margin: 0 0 0.85em; padding-left: 1.5em; }
.md-body li { margin-bottom: 0.3em; }
.md-body strong { font-weight: 600; color: #fff; }
.md-body em { font-style: italic; }
.md-body a { color: var(--signal); text-decoration: none; border-bottom: 1px solid rgba(200,242,78,0.35); }
.md-body blockquote {
    border-left: 2px solid rgba(232,179,75,0.5);
    padding: 0.1em 0 0.1em 0.9em; margin: 0 0 0.85em;
    color: var(--bone-dim);
}
.md-body code {
    font-family: var(--mono); font-size: 0.88em;
    background: rgba(200,242,78,0.08);
    border: 1px solid rgba(200,242,78,0.12);
    border-radius: 3px; padding: 0.08em 0.35em;
    color: #dff3a8;
}
.md-body pre {
    background: var(--ink-2);
    border: 1px solid var(--line);
    border-left: 2px solid rgba(200,242,78,0.4);
    border-radius: 6px;
    padding: 0.85em 1em; margin: 0 0 0.9em;
    overflow-x: auto;
}
.md-body pre code {
    background: none; border: none; padding: 0;
    color: var(--bone); font-size: 0.85rem; line-height: 1.6;
    white-space: pre;
}
.md-body hr { border: none; border-top: 1px solid var(--line); margin: 1.2em 0; }

.cap-warn { color: var(--amber); }

/* ── Reasoning channel: visually subordinate, collapsible ── */
.think-wrap {
    display: none;
    margin-bottom: 0.9rem;
    border-left: 2px solid rgba(232,179,75,0.45);
    background: rgba(232,179,75,0.04);
    border-radius: 0 6px 6px 0;
    padding: 0.55rem 0.8rem 0.65rem;
}
.think-wrap.used { display: block; }

.think-head {
    display: flex; align-items: center; gap: 0.6rem;
    font-size: 0.66rem; letter-spacing: 0.18em;
    color: var(--amber);
    cursor: pointer; user-select: none;
}
.think-head .chev { transition: transform 0.25s; font-size: 0.6rem; }
.think-wrap.collapsed .chev { transform: rotate(-90deg); }
.think-head .tmeta { color: rgba(232,179,75,0.55); letter-spacing: 0.06em; }

.think-body {
    margin-top: 0.5rem;
    font-size: 0.85rem; line-height: 1.75;
    white-space: pre-wrap; word-break: break-word;
    opacity: 0.8;
}
.think-wrap.collapsed .think-body { display: none; }

.think-body .tk.lock { color: #c9bb96; }
.think-body .tk.lock.just {
    color: var(--amber);
    text-shadow: 0 0 14px rgba(232,179,75,0.5);
}

/* token spans: the diffusion surface */
.tk { transition: color 0.55s ease, text-shadow 0.55s ease, opacity 0.4s ease; }
.tk.noise { color: var(--noise); opacity: 0.55; }
.tk.lock { color: var(--bone); opacity: 1; }
.tk.lock.just {
    color: var(--signal);
    text-shadow: 0 0 16px rgba(200,242,78,0.55), 0 0 3px rgba(200,242,78,0.4);
    transition: none;
}

/* block wrapper: hover reveals structure */
.blk { border-bottom: 1px solid transparent; transition: background 0.25s; }
.blk:hover { background: rgba(200,242,78,0.035); }

/* footer under a finished reply */
.msg .foot {
    display: flex; align-items: center; gap: 0.9rem; flex-wrap: wrap;
    margin-top: 0.8rem; padding-left: 1.2rem;
    font-size: 0.7rem; color: var(--faint); letter-spacing: 0.08em;
    opacity: 0; transition: opacity 0.5s;
}
.msg .foot.show { opacity: 1; }
.foot .stat b { color: var(--dim); font-weight: 500; }

.foot .replay-ctl { display: flex; align-items: center; gap: 0.45rem; }
.foot button {
    font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.1em;
    color: var(--dim); background: transparent;
    border: 1px solid var(--line); border-radius: 3px;
    padding: 0.22rem 0.5rem; cursor: pointer;
    transition: all 0.2s;
}
.foot button:hover { color: var(--signal); border-color: var(--signal); }
.foot input[type=range] {
    -webkit-appearance: none; appearance: none;
    width: 130px; height: 2px;
    background: var(--line); border-radius: 2px;
    outline: none; cursor: pointer;
}
.foot input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 9px; height: 9px; border-radius: 50%;
    background: var(--signal);
    box-shadow: 0 0 6px rgba(200,242,78,0.6);
}

.msg.error .body { color: var(--red); border-left-color: var(--red); }

/* ── Composer ── */
.composer {
    flex: 0 0 auto;
    border-top: 1px solid var(--line-soft);
    background: rgba(8,12,15,0.85);
    backdrop-filter: blur(8px);
    padding: 0.9rem 2rem 1.1rem;
}
.composer-inner { max-width: 54rem; margin: 0 auto; display: flex; gap: 0.6rem; align-items: flex-end; }

.composer textarea {
    flex: 1;
    background: var(--ink-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    color: var(--bone);
    font-family: var(--mono); font-size: 0.95rem; line-height: 1.5;
    padding: 0.65rem 0.8rem;
    resize: none; outline: none;
    min-height: 44px; max-height: 140px;
    transition: border-color 0.2s, box-shadow 0.2s;
}
.composer textarea:focus {
    border-color: var(--signal);
    box-shadow: 0 0 0 1px rgba(200,242,78,0.25), 0 0 22px rgba(200,242,78,0.07);
}
.composer textarea::placeholder { color: var(--faint); }

.tx-btn {
    font-family: var(--mono); font-size: 0.68rem; font-weight: 600;
    letter-spacing: 0.18em;
    color: var(--ink);
    background: var(--signal);
    border: 1px solid var(--signal);
    border-radius: 4px;
    padding: 0.78rem 1.1rem;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
}
.tx-btn:hover:not(:disabled) { box-shadow: 0 0 24px rgba(200,242,78,0.35); transform: translateY(-1px); }
.tx-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.tx-btn.halt { background: transparent; color: var(--red); border-color: var(--red); }
.tx-btn.halt:hover { box-shadow: 0 0 18px rgba(255,98,88,0.3); }

.mt-sel {
    font-family: var(--mono); font-size: 0.62rem;
    color: var(--dim); background: var(--ink-2);
    border: 1px solid var(--line); border-radius: 4px;
    padding: 0.78rem 0.4rem; outline: none; cursor: pointer;
}

/* ── Telemetry rail ── */
.rail {
    flex: 0 0 18rem;
    border-left: 1px solid var(--line-soft);
    background: rgba(9,13,16,0.6);
    padding: 1.1rem 1rem;
    overflow-y: auto;
    display: flex; flex-direction: column; gap: 1.2rem;
}
.rail::-webkit-scrollbar { width: 3px; }
.rail::-webkit-scrollbar-thumb { background: var(--line); }

.rail h2 {
    font-size: 0.58rem; font-weight: 600;
    letter-spacing: 0.3em; color: var(--faint);
}

.dials { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
.dial {
    border: 1px solid var(--line-soft); border-radius: 4px;
    padding: 0.55rem 0.6rem;
    background: var(--ink-2);
}
.dial .v {
    font-size: 1.45rem; font-weight: 700;
    color: var(--signal);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
}
.dial .k { font-size: 0.52rem; letter-spacing: 0.16em; color: var(--faint); margin-top: 0.2rem; }
.dial.wide { grid-column: span 2; }

.blocks { display: flex; flex-direction: column; gap: 0.45rem; }
.brow {
    display: flex; align-items: center; gap: 0.5rem;
    font-size: 0.58rem; color: var(--dim);
    font-variant-numeric: tabular-nums;
    animation: rise 0.3s ease-out;
}
.brow .bid { color: var(--signal); font-weight: 600; min-width: 26px; letter-spacing: 0.05em; }
.brow .bbar { flex: 1; height: 3px; background: var(--line-soft); border-radius: 2px; overflow: hidden; }
.brow .bbar i {
    display: block; height: 100%; border-radius: 2px;
    background: linear-gradient(90deg, rgba(200,242,78,0.4), var(--signal));
}
.brow .bt { min-width: 42px; text-align: right; color: var(--faint); }
.brow.computing .bid { color: var(--amber); }
.brow.computing .bbar i {
    width: 40%;
    background: linear-gradient(90deg, transparent, rgba(232,179,75,0.8), transparent);
    animation: sweep 1.1s linear infinite;
}
@keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(350%); } }

.race { display: flex; flex-direction: column; gap: 0.5rem; }
.rrow { font-size: 0.56rem; letter-spacing: 0.08em; color: var(--dim); }
.rrow .rbar { margin-top: 0.25rem; height: 4px; background: var(--line-soft); border-radius: 2px; overflow: hidden; }
.rrow .rbar i { display: block; height: 100%; border-radius: 2px; width: 0%; transition: width 0.8s ease; }
.rrow.diff .rbar i { background: var(--signal); box-shadow: 0 0 8px rgba(200,242,78,0.5); }
.rrow.ar .rbar i { background: var(--faint); }
.race .verdict {
    font-family: var(--serif); font-style: italic;
    font-size: 0.95rem; color: var(--signal);
    margin-top: 0.1rem;
}

.rail .note {
    font-size: 0.56rem; line-height: 1.7; color: var(--faint);
    border-top: 1px solid var(--line-soft);
    padding-top: 0.8rem;
    letter-spacing: 0.03em;
}
.rail .note em { color: var(--dim); font-style: normal; }

@media (max-width: 940px) { .rail { display: none; } }
@media (max-width: 640px) {
    #feed { padding: 1.2rem 1rem 0.5rem; }
    .composer { padding: 0.7rem 1rem 0.9rem; }
    .tagline { display: none; }
}
</style>
</head>
<body>
<canvas id="grain" width="420" height="260"></canvas>
<div class="scan"></div>

<div class="frame">
    <header>
        <div class="brand">
            <div class="lamp" id="lamp"></div>
            <h1>DIFFUSION<em>⁄</em>GEMMA</h1>
            <div class="tagline">language, condensed from static</div>
        </div>
        <div class="head-right">
            <div class="model-chip" id="model-chip">linking…</div>
            <a class="harness-link" href="/">HARNESS ↗</a>
        </div>
    </header>

    <div class="stage">
        <div class="feed-wrap">
            <div id="feed">
                <div class="feed-inner" id="feed-inner">
                    <div class="empty" id="empty">
                        <div class="big">The static <span class="lit">speaks</span>.</div>
                        <div class="sub">
                            Every reply is drafted as a whole — 256 tokens at a time —
                            then denoised into language over a handful of passes.
                            While one block resolves on your screen, the next is already
                            being computed. Ask something and watch.
                        </div>
                        <div class="chips">
                            <button class="chip" data-p="Write a short poem about the stars at night.">✶ a poem about stars</button>
                            <button class="chip" data-p="Explain how diffusion language models differ from autoregressive ones, in three short paragraphs.">⌬ explain yourself</button>
                            <button class="chip" data-p="Write a TypeScript function that debounces another function. Include types and a short usage example.">␥ debounce in TypeScript</button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="composer">
                <div class="composer-inner">
                    <textarea id="input" rows="1" placeholder="transmit a prompt…"></textarea>
                    <select class="mt-sel" id="max-tok" title="max tokens">
                        <option value="1024">1k</option>
                        <option value="2048">2k</option>
                        <option value="4096" selected>4k</option>
                        <option value="8192">8k</option>
                        <option value="16384">16k</option>
                    </select>
                    <button class="tx-btn" id="tx">TRANSMIT ▸</button>
                </div>
            </div>
        </div>

        <aside class="rail">
            <div>
                <h2>TELEMETRY</h2>
                <div class="dials" style="margin-top:0.7rem">
                    <div class="dial"><div class="v" id="d-tokps">—</div><div class="k">≈ TOK/SEC</div></div>
                    <div class="dial"><div class="v" id="d-blocks">0</div><div class="k">BLOCKS</div></div>
                    <div class="dial wide"><div class="v" id="d-time">0.00s</div><div class="k">WALL TIME</div></div>
                </div>
            </div>
            <div>
                <h2>BLOCK LEDGER</h2>
                <div class="blocks" id="blocks" style="margin-top:0.7rem"></div>
            </div>
            <div>
                <h2>SAMPLER</h2>
                <div style="margin-top:0.7rem; display:flex; gap:0.45rem; align-items:center">
                    <select class="mt-sel" id="entropy-sel" style="flex:1; padding:0.45rem 0.4rem">
                        <option value="0.05">entropy 0.05 · precise</option>
                        <option value="0.1" selected>entropy 0.10 · default</option>
                        <option value="0.2">entropy 0.20 · faster</option>
                        <option value="0.4">entropy 0.40 · reckless</option>
                    </select>
                    <button class="foot-like" id="entropy-apply" style="font-family:var(--mono);font-size:0.62rem;letter-spacing:0.1em;color:var(--dim);background:transparent;border:1px solid var(--line);border-radius:3px;padding:0.45rem 0.6rem;cursor:pointer">APPLY</button>
                </div>
                <div id="engine-status" style="margin-top:0.5rem;font-size:0.6rem;letter-spacing:0.08em;color:var(--faint);line-height:1.6">
                    tokens accepted per denoise pass — higher is faster, looser.
                    applying reloads the engine (~2–4 min).
                </div>
            </div>
            <div>
                <h2>VS AUTOREGRESSIVE</h2>
                <div class="race" style="margin-top:0.7rem" id="race">
                    <div class="rrow diff">THIS REPLY <span id="r-diff-t" style="float:right"></span><div class="rbar"><i id="r-diff"></i></div></div>
                    <div class="rrow ar">TYPICAL 55 TOK/S STREAM <span id="r-ar-t" style="float:right"></span><div class="rbar"><i id="r-ar"></i></div></div>
                    <div class="verdict" id="verdict"></div>
                </div>
            </div>
            <div class="note">
                Each ledger row is one <em>real</em> 256-token diffusion block —
                its duration is the true server compute time. The glyph
                resolution order is staged; the text, blocks and timing are not.
            </div>
        </aside>
    </div>
</div>

<script>
// ─────────────────────────────────────────────────────────────
// constants & helpers  (NO backslash escapes in this script —
// see the note at the top of canvas.ts)
// ─────────────────────────────────────────────────────────────
var NL = String.fromCharCode(10);
var GLYPHS = '·:;+*#%@&=?!~^░▒▓';
var feed = document.getElementById('feed');
var feedInner = document.getElementById('feed-inner');
var inputEl = document.getElementById('input');
var txBtn = document.getElementById('tx');
var grain = document.getElementById('grain');
var gctx = grain.getContext('2d');

var convo = [];   // window.history is unshadowable — do not name this 'history'
var messages = [];        // engine objects
var live = null;          // currently generating message
var aborter = null;

function mulberry(seed) {
    return function () {
        seed |= 0; seed = (seed + 1831565813) | 0;
        var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function isWs(c) { return c.charCodeAt(0) <= 32; }

// split text into tokens { txt, ws } — word + its trailing whitespace
function tokenize(text) {
    var out = [], i = 0, n = text.length;
    var lead = '';
    while (i < n && isWs(text[i])) { lead += text[i]; i++; }
    if (lead) out.push({ txt: '', ws: lead });
    while (i < n) {
        var w = '';
        while (i < n && !isWs(text[i])) { w += text[i]; i++; }
        var s = '';
        while (i < n && isWs(text[i])) { s += text[i]; i++; }
        out.push({ txt: w, ws: s });
    }
    return out;
}

function noiseFor(token, rng) {
    var s = '';
    for (var i = 0; i < token.txt.length; i++) {
        s += GLYPHS[(rng() * GLYPHS.length) | 0];
    }
    return s + token.ws;
}

function fmtS(ms) { return (ms / 1000).toFixed(2) + 's'; }
function estTok(chars) { return Math.max(1, Math.round(chars / 4)); }

// ─────────────────────────────────────────────────────────────
// health check
// ─────────────────────────────────────────────────────────────
fetch('/api/health').then(function (r) { return r.json(); }).then(function (d) {
    var lamp = document.getElementById('lamp');
    var chip = document.getElementById('model-chip');
    if (d.status === 'ok') {
        lamp.className = 'lamp live';
        chip.textContent = (d.models && d.models[0]) ? d.models[0] : 'model online';
    } else {
        lamp.className = 'lamp dead';
        chip.textContent = 'vLLM offline';
    }
}).catch(function () {
    document.getElementById('lamp').className = 'lamp dead';
    document.getElementById('model-chip').textContent = 'vLLM unreachable';
});

// ─────────────────────────────────────────────────────────────
// message construction
// ─────────────────────────────────────────────────────────────
function clearEmpty() {
    var e = document.getElementById('empty');
    if (e) e.remove();
}

function addUserMsg(text) {
    clearEmpty();
    var div = document.createElement('div');
    div.className = 'msg user';
    var who = document.createElement('div');
    who.className = 'who';
    who.textContent = 'YOU ▸';
    var body = document.createElement('div');
    body.className = 'body';
    body.textContent = text;
    div.appendChild(who); div.appendChild(body);
    feedInner.appendChild(div);
    scrollFeed(true);
}

function newAiMsg() {
    clearEmpty();
    var div = document.createElement('div');
    div.className = 'msg ai';
    div.innerHTML =
        '<div class="who"><span class="name">GEMMA</span>' +
        '<span class="phase working">▚ listening for first block…</span></div>' +
        '<div class="body">' +
        '  <div class="think-wrap collapsed">' +
        '    <div class="think-head"><span class="chev">▼</span> ⌬ REASONING CHANNEL <span class="tmeta"></span></div>' +
        '    <div class="think-body"></div>' +
        '  </div>' +
        '  <div class="answer-body"></div>' +
        '  <div class="md-body"></div>' +
        '</div>' +
        '<div class="foot"></div>';
    feedInner.appendChild(div);
    var thinkWrap = div.querySelector('.think-wrap');
    thinkWrap.querySelector('.think-head').addEventListener('click', function () {
        thinkWrap.classList.toggle('collapsed');
    });
    var m = {
        el: div,
        bodyEl: div.querySelector('.answer-body'),
        mdEl: div.querySelector('.md-body'),
        mdShown: false,
        capped: false,
        thinkWrapEl: thinkWrap,
        thinkBodyEl: div.querySelector('.think-body'),
        thinkMetaEl: div.querySelector('.tmeta'),
        phaseEl: div.querySelector('.phase'),
        footEl: div.querySelector('.foot'),
        whoEl: div.querySelector('.who'),
        mode: 'detect',     // channel splitter state: detect | think | answer
        carry: '',          // partial marker held back between chunks
        thinkChars: 0,
        tokens: [],          // { txt, ws, lockAt, el, locked, justUntil }
        blocks: [],          // { chars, start, dur, rowEl }
        t0: performance.now(),
        seed: ((Math.random() * 1e9) | 0) || 7,
        rng: null,
        fullText: '',
        thought: false,
        done: false,
        settled: false,
        totalMs: 0,
        streamMs: 0,
        replay: null,        // { playing, speed, T, wall }
        lastNoise: 0,
    };
    m.rng = mulberry(m.seed);
    messages.push(m);
    // pin the viewport to the top of the reply: the surface grows downward
    // and resolves in place — yanking the scroll would fight the reader
    feed.scrollTop = Math.max(0, div.offsetTop - 70);
    return m;
}

// ─────────────────────────────────────────────────────────────
// channel splitter: <|channel>thought ... <channel|> → reasoning,
// everything after → answer. Markers can split across chunks, so a
// partial-marker tail is carried into the next chunk.
// ─────────────────────────────────────────────────────────────
var OPEN_T = '<|channel>thought';
var CLOSE_T = '<channel|>';
var TURN_T = '<turn|>';
var MARKERS = [OPEN_T, CLOSE_T, TURN_T];

function partialHold(s) {
    var max = 0;
    for (var k = 0; k < MARKERS.length; k++) {
        var tok = MARKERS[k];
        var lim = Math.min(tok.length - 1, s.length);
        for (var L = lim; L > max; L--) {
            if (tok.indexOf(s.slice(s.length - L)) === 0) { max = L; break; }
        }
    }
    return max;
}

// returns [{ tgt: 't'|'a', txt }]
function processPiece(m, piece) {
    var s = m.carry + piece;
    m.carry = '';
    var out = [];

    function emit(tgt, txt) {
        if (txt) out.push({ tgt: tgt, txt: txt });
    }

    while (s.length > 0) {
        if (m.mode === 'detect') {
            if (s.length < OPEN_T.length) {
                if (OPEN_T.indexOf(s) === 0) { m.carry = s; return out; }
                m.mode = 'answer';
                continue;
            }
            if (s.indexOf(OPEN_T) === 0) {
                m.mode = 'think';
                s = s.slice(OPEN_T.length);
                if (s[0] === NL) s = s.slice(1);
            } else {
                m.mode = 'answer';
            }
            continue;
        }

        if (m.mode === 'think') {
            var ci = s.indexOf(CLOSE_T);
            if (ci !== -1) {
                emit('t', s.slice(0, ci));
                s = s.slice(ci + CLOSE_T.length);
                m.mode = 'answer';
                continue;
            }
            var hold = partialHold(s);
            if (hold) { m.carry = s.slice(s.length - hold); s = s.slice(0, s.length - hold); }
            emit('t', s);
            return out;
        }

        // answer mode: drop stray markers, switch back on a reopened channel
        var best = -1, bestTok = '';
        for (var mi = 0; mi < MARKERS.length; mi++) {
            var idx = s.indexOf(MARKERS[mi]);
            if (idx !== -1 && (best === -1 || idx < best)) { best = idx; bestTok = MARKERS[mi]; }
        }
        if (best !== -1) {
            emit('a', s.slice(0, best));
            s = s.slice(best + bestTok.length);
            if (bestTok === OPEN_T) {
                m.mode = 'think';
                if (s[0] === NL) s = s.slice(1);
            }
            continue;
        }
        var hold2 = partialHold(s);
        if (hold2) { m.carry = s.slice(s.length - hold2); s = s.slice(0, s.length - hold2); }
        emit('a', s);
        return out;
    }
    return out;
}

// ─────────────────────────────────────────────────────────────
// block scheduling: assign deterministic lock times in waves
// ─────────────────────────────────────────────────────────────
function scheduleBlock(m, segs, tStart, estDur) {
    var toks = [];
    var bIdx = m.blocks.length;
    var totalChars = 0;

    for (var si = 0; si < segs.length; si++) {
        var seg = segs[si];
        var segToks = tokenize(seg.txt);
        if (segToks.length === 0) continue;
        totalChars += seg.txt.length;

        var target = seg.tgt === 't' ? m.thinkBodyEl : m.bodyEl;
        if (seg.tgt === 't') {
            m.thinkWrapEl.classList.add('used');
            m.thinkChars += seg.txt.length;
            m.thinkMetaEl.textContent = '· ' + m.thinkChars + ' chars';
        }
        var blkSpan = document.createElement('span');
        blkSpan.className = 'blk';
        blkSpan.title = 'block ' + (bIdx + 1);
        target.appendChild(blkSpan);
        for (var ti = 0; ti < segToks.length; ti++) {
            segToks[ti].seg = blkSpan;
            segToks[ti].ch = seg.tgt;
            toks.push(segToks[ti]);
        }
    }
    if (toks.length === 0) return false;

    // weight: mostly random, biased so short words surface first
    var order = [];
    for (var i = 0; i < toks.length; i++) {
        var t = toks[i];
        var w = m.rng() * 0.7 + Math.min(t.txt.length, 12) / 12 * 0.3;
        order.push({ i: i, w: w });
    }
    order.sort(function (a, b) { return a.w - b.w; });

    // waves: visible denoising passes across the block window
    var waves = Math.max(4, Math.min(9, Math.round(estDur / 170)));
    var perWave = Math.ceil(order.length / waves);

    for (var k = 0; k < order.length; k++) {
        var wave = (k / perWave) | 0;
        // ease-in-out pacing: slow start, fast middle, slow end
        var p = (wave + 1) / waves;
        var eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        var lockAt = tStart + eased * estDur + (m.rng() - 0.5) * 90;
        var tok = toks[order[k].i];
        tok.lockAt = Math.max(tStart + 30, lockAt);
        tok.locked = false;
        tok.justUntil = 0;
    }

    // build spans in document order, each into its segment's container
    for (var j = 0; j < toks.length; j++) {
        var tk = toks[j];
        var span = document.createElement('span');
        span.className = 'tk noise';
        span.textContent = noiseFor(tk, m.rng);
        tk.seg.appendChild(span);
        tk.el = span;
        m.tokens.push(tk);
    }

    m.blocks.push({ chars: totalChars, start: tStart, dur: estDur, rowEl: null });
    railAddBlock(m, bIdx, totalChars);
    return true;
}

// compress: pull every unlocked token's lockAt into [now, now+span]
function compressPending(m, nowRel, span) {
    var pend = [];
    for (var i = 0; i < m.tokens.length; i++) {
        var t = m.tokens[i];
        if (!t.locked && t.lockAt > nowRel + span) pend.push(t);
    }
    pend.sort(function (a, b) { return a.lockAt - b.lockAt; });
    for (var k = 0; k < pend.length; k++) {
        pend[k].lockAt = nowRel + (k / Math.max(1, pend.length)) * span;
    }
}

// ─────────────────────────────────────────────────────────────
// telemetry rail
// ─────────────────────────────────────────────────────────────
var blocksEl = document.getElementById('blocks');
var computingRow = null;

function railReset() {
    blocksEl.innerHTML = '';
    computingRow = null;
    document.getElementById('d-tokps').textContent = '—';
    document.getElementById('d-blocks').textContent = '0';
    document.getElementById('d-time').textContent = '0.00s';
    document.getElementById('r-diff').style.width = '0%';
    document.getElementById('r-ar').style.width = '0%';
    document.getElementById('r-diff-t').textContent = '';
    document.getElementById('r-ar-t').textContent = '';
    document.getElementById('verdict').textContent = '';
}

function railAddBlock(m, idx, chars) {
    if (computingRow) { computingRow.remove(); computingRow = null; }
    // a block's compute time is the gap BEFORE its arrival
    // (block 1's window includes prompt prefill)
    var prevStart = idx > 0 ? m.blocks[idx - 1].start : 0;
    var realDur = m.blocks[idx].start - prevStart;
    m.blocks[idx].realDur = realDur;

    var row = document.createElement('div');
    row.className = 'brow';
    row.innerHTML =
        '<span class="bid">B' + String(idx + 1).padStart(2, '0') + '</span>' +
        '<span class="bbar"><i style="width:8%"></i></span>' +
        '<span class="bt">' + fmtS(realDur) + '</span>';
    blocksEl.appendChild(row);
    m.blocks[idx].rowEl = row;

    rescaleBars(m);
    railComputing();
    blocksEl.scrollTop = blocksEl.scrollHeight;
}

function rescaleBars(m) {
    var maxDur = 1;
    for (var i = 0; i < m.blocks.length; i++) {
        if (m.blocks[i].realDur && m.blocks[i].realDur > maxDur) maxDur = m.blocks[i].realDur;
    }
    for (var k = 0; k < m.blocks.length; k++) {
        var bb = m.blocks[k];
        if (bb.realDur && bb.rowEl) {
            bb.rowEl.querySelector('i').style.width = Math.max(8, bb.realDur / maxDur * 100) + '%';
        }
    }
}

function railComputing() {
    computingRow = document.createElement('div');
    computingRow.className = 'brow computing';
    computingRow.innerHTML =
        '<span class="bid">B' + String((live ? live.blocks.length : 0) + 1).padStart(2, '0') + '</span>' +
        '<span class="bbar"><i></i></span>' +
        '<span class="bt">denoise</span>';
    blocksEl.appendChild(computingRow);
}

function railFinish(m) {
    if (computingRow) { computingRow.remove(); computingRow = null; }
    // race
    var chars = m.fullText.length;
    var toks = estTok(chars);
    var diffS = m.streamMs / 1000;
    var arS = toks / 55;
    var maxS = Math.max(diffS, arS, 0.001);
    document.getElementById('r-diff').style.width = (diffS / maxS * 100) + '%';
    document.getElementById('r-ar').style.width = (arS / maxS * 100) + '%';
    document.getElementById('r-diff-t').textContent = diffS.toFixed(2) + 's';
    document.getElementById('r-ar-t').textContent = arS.toFixed(1) + 's';
    if (arS > diffS && diffS > 0) {
        document.getElementById('verdict').textContent = '× ' + (arS / diffS).toFixed(1) + ' faster';
    }
    if (diffS > 0) {
        document.getElementById('d-tokps').textContent = String(Math.round(toks / diffS));
        document.getElementById('d-time').textContent = fmtS(m.streamMs);
    }
}

// ─────────────────────────────────────────────────────────────
// markdown: minimal zero-dep renderer for the settled reading view.
// All input is HTML-escaped first; we only emit our own tags.
// (Backtick literals via charCode — see the template-literal note.)
// ─────────────────────────────────────────────────────────────
var BT = String.fromCharCode(96);
var FENCE = BT + BT + BT;

function escMd(s) {
    return s.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
}

// wrap delimiter pairs: pairWrap('a **b** c','**','<strong>','</strong>')
function pairWrap(s, delim, tagO, tagC) {
    var out = '', rest = s;
    while (true) {
        var a = rest.indexOf(delim);
        if (a === -1) break;
        var b = rest.indexOf(delim, a + delim.length);
        if (b === -1) break;
        var inner = rest.slice(a + delim.length, b);
        if (inner.length === 0 || inner.length > 400) { out += rest.slice(0, b); rest = rest.slice(b); continue; }
        out += rest.slice(0, a) + tagO + inner + tagC;
        rest = rest.slice(b + delim.length);
    }
    return out + rest;
}

function linkify(s) {
    var out = '', rest = s;
    while (true) {
        var a = rest.indexOf('[');
        if (a === -1) break;
        var b = rest.indexOf('](', a);
        if (b === -1) break;
        var c = rest.indexOf(')', b + 2);
        if (c === -1) break;
        var label = rest.slice(a + 1, b);
        var url = rest.slice(b + 2, c);
        if (url.indexOf('http') === 0 && label.indexOf('[') === -1) {
            out += rest.slice(0, a) + '<a href="' + url.split('"').join('') + '" target="_blank" rel="noopener">' + label + '</a>';
            rest = rest.slice(c + 1);
        } else {
            out += rest.slice(0, a + 1);
            rest = rest.slice(a + 1);
        }
    }
    return out + rest;
}

function inlineMd(s) {
    s = escMd(s);
    s = pairWrap(s, BT, '<code>', '</code>');
    s = linkify(s);
    s = pairWrap(s, '**', '<strong>', '</strong>');
    s = pairWrap(s, '*', '<em>', '</em>');
    return s;
}

function mdRender(text) {
    var lines = text.split(NL);
    var html = '', para = [], i = 0;

    function flushPara() {
        if (para.length === 0) return;
        html += '<p>' + para.map(inlineMd).join('<br>') + '</p>';
        para = [];
    }

    while (i < lines.length) {
        var line = lines[i];
        var t = line.trim();

        if (t.indexOf(FENCE) === 0) {                       // fenced code
            flushPara();
            var code = [];
            i++;
            while (i < lines.length && lines[i].trim().indexOf(FENCE) !== 0) { code.push(lines[i]); i++; }
            i++; // closing fence
            html += '<pre><code>' + escMd(code.join(NL)) + '</code></pre>';
            continue;
        }

        if (t === '') { flushPara(); i++; continue; }

        if (t === '---' || t === '***' || t === '___') { flushPara(); html += '<hr>'; i++; continue; }

        var h = 0;
        while (h < 4 && t[h] === '#') h++;
        if (h > 0 && t[h] === ' ') {
            flushPara();
            html += '<h' + h + '>' + inlineMd(t.slice(h + 1)) + '</h' + h + '>';
            i++; continue;
        }

        if (t[0] === '>') {
            flushPara();
            var quote = [];
            while (i < lines.length && lines[i].trim()[0] === '>') {
                quote.push(lines[i].trim().slice(1).trim());
                i++;
            }
            html += '<blockquote>' + quote.map(inlineMd).join('<br>') + '</blockquote>';
            continue;
        }

        var isUl = (t.indexOf('- ') === 0 || t.indexOf('* ') === 0 || t.indexOf('+ ') === 0);
        var olLen = 0;
        while (olLen < 3 && t.charCodeAt(olLen) >= 48 && t.charCodeAt(olLen) <= 57) olLen++;
        var isOl = olLen > 0 && t.slice(olLen, olLen + 2) === '. ';
        if (isUl || isOl) {
            flushPara();
            var tag = isUl ? 'ul' : 'ol';
            html += '<' + tag + '>';
            while (i < lines.length) {
                var lt = lines[i].trim();
                var ul2 = (lt.indexOf('- ') === 0 || lt.indexOf('* ') === 0 || lt.indexOf('+ ') === 0);
                var on = 0;
                while (on < 3 && lt.charCodeAt(on) >= 48 && lt.charCodeAt(on) <= 57) on++;
                var ol2 = on > 0 && lt.slice(on, on + 2) === '. ';
                if (isUl ? !ul2 : !ol2) break;
                html += '<li>' + inlineMd(isUl ? lt.slice(2) : lt.slice(on + 2)) + '</li>';
                i++;
            }
            html += '</' + tag + '>';
            continue;
        }

        para.push(line);
        i++;
    }
    flushPara();
    return html;
}

function answerText(m) {
    var s = '';
    for (var i = 0; i < m.tokens.length; i++) {
        var t = m.tokens[i];
        if (t.ch !== 't') s += t.txt + t.ws;
    }
    return s;
}

function showMd(m) {
    if (m.mdShown) return;
    var txt = answerText(m).trim();
    if (!txt) return;
    m.mdEl.innerHTML = mdRender(txt);
    m.mdEl.classList.add('show');
    m.bodyEl.style.display = 'none';
    m.mdShown = true;
}

function hideMd(m) {
    if (!m.mdShown) return;
    m.mdEl.classList.remove('show');
    m.bodyEl.style.display = '';
    m.mdShown = false;
}

// ─────────────────────────────────────────────────────────────
// the engine: one pure render pass, driven by T per message
// ─────────────────────────────────────────────────────────────
var noiseRng = mulberry(42);

function msgTime(m, now) {
    if (m.replay) {
        if (m.replay.playing) {
            var t = m.replay.T + (now - m.replay.wall) * m.replay.speed;
            if (t >= m.totalMs) { m.replay = null; return m.totalMs; }
            return t;
        }
        return m.replay.T;   // paused via scrubber
    }
    if (!m.done) return now - m.t0;
    return m.totalMs;
}

function renderMsg(m, now) {
    var T = msgTime(m, now);
    var doNoise = now - m.lastNoise > 70;
    if (doNoise) m.lastNoise = now;
    var unlockedBudget = 700;
    var unsettled = 0;

    for (var i = 0; i < m.tokens.length; i++) {
        var t = m.tokens[i];
        if (t.lockAt <= T) {
            if (!t.locked) {
                t.locked = true;
                t.el.textContent = t.txt + t.ws;
                t.el.className = 'tk lock just';
                t.justUntil = now + 380;
                unsettled++;
            } else if (t.justUntil) {
                if (now > t.justUntil) {
                    t.el.className = 'tk lock';
                    t.justUntil = 0;
                } else {
                    unsettled++;
                }
            }
        } else {
            unsettled++;
            if (t.locked) {           // scrubbed backwards
                t.locked = false;
                t.el.className = 'tk noise';
                t.el.textContent = noiseFor(t, noiseRng);
            } else if (doNoise && unlockedBudget > 0) {
                t.el.textContent = noiseFor(t, noiseRng);
                unlockedBudget--;
            }
        }
    }

    // scrub position
    if (m.scrubEl && m.totalMs > 0) {
        m.scrubEl.value = String(Math.round(T / m.totalMs * 1000));
    }
    return unsettled;
}

function anyActive() {
    if (live) return true;
    for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (m.replay && m.replay.playing) return true;
        for (var k = 0; k < m.tokens.length; k++) {
            if (!m.tokens[k].locked) return true;
        }
        if (m.replay) return true;
    }
    return false;
}

var lastGrain = 0;
function drawGrain(now) {
    if (now - lastGrain < 90) return;
    lastGrain = now;
    var w = grain.width, h = grain.height;
    var img = gctx.createImageData(w, h);
    var d = img.data;
    for (var i = 0; i < 4200; i++) {
        var p = ((Math.random() * w * h) | 0) * 4;
        var v = 90 + ((Math.random() * 120) | 0);
        d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
    }
    gctx.putImageData(img, 0, 0);
}

function loop() {
    var now = performance.now();
    var active = false;

    for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        // a message stays animated until every token is locked AND its
        // lock-flash has faded — m.done alone is not enough (fast streams
        // finish before the tail of the schedule plays out)
        if (m.settled && !m.replay) { showMd(m); continue; }
        active = true;
        var unsettled = renderMsg(m, now);
        m.settled = (m.done && !m.replay && unsettled === 0);
    }

    if (live) {
        active = true;
        var T = now - live.t0;
        // HUD
        var lockedChars = 0;
        for (var k = 0; k < live.tokens.length; k++) {
            if (live.tokens[k].locked) lockedChars += live.tokens[k].txt.length + 1;
        }
        document.getElementById('d-time').textContent = fmtS(T);
        document.getElementById('d-blocks').textContent = String(live.blocks.length);
        if (T > 200) {
            document.getElementById('d-tokps').textContent =
                String(Math.round(estTok(live.fullText.length) / (live.streamMs ? live.streamMs / 1000 : T / 1000)));
        }
    }

    if (active) {
        grain.classList.add('on');
        drawGrain(now);
    } else {
        grain.classList.remove('on');
    }
    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function scrollFeed(force) {
    var nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
    if (force || nearBottom) feed.scrollTop = feed.scrollHeight;
}

// ─────────────────────────────────────────────────────────────
// streaming
// ─────────────────────────────────────────────────────────────
async function transmit() {
    var text = inputEl.value.trim();
    if (!text || live || engineReloading) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';

    // older messages may be mid-replay or scrubbed — snap them back to settled
    for (var oi = 0; oi < messages.length; oi++) {
        if (messages[oi].done) { messages[oi].replay = null; messages[oi].settled = false; }
    }

    convo.push({ role: 'user', content: text });
    addUserMsg(text);

    var m = newAiMsg();
    live = m;
    railReset();
    railComputing();
    txBtn.textContent = 'HALT ■';
    txBtn.className = 'tx-btn halt';
    aborter = new AbortController();

    var defaultGap = 1100;
    var lastArrival = 0;

    try {
        var res = await fetch('/api/stream-raw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: convo,
                maxTokens: parseInt(document.getElementById('max-tok').value, 10) || 1024,
            }),
            signal: aborter.signal,
        });
        if (!res.ok) throw new Error('upstream ' + res.status);

        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        while (true) {
            var r = await reader.read();
            if (r.done) break;
            buffer += decoder.decode(r.value, { stream: true });
            var lines = buffer.split(NL);
            buffer = lines.pop() || '';

            for (var li = 0; li < lines.length; li++) {
                var line = lines[li];
                if (line.indexOf('data: ') !== 0 || line === 'data: [DONE]') continue;
                var chunk;
                try { chunk = JSON.parse(line.slice(6)); } catch (e) { continue; }
                var choice0 = chunk.choices && chunk.choices[0];
                var delta = choice0 && choice0.delta;
                if (choice0 && choice0.finish_reason === 'length') m.capped = true;
                if (!delta) continue;
                var piece = delta.reasoning_content || delta.content || '';
                if (!piece) continue;

                var rel = performance.now() - m.t0;
                m.fullText += piece;   // raw with markers — the chat template strips thinking itself

                var segs = processPiece(m, piece);
                if (segs.length === 0) continue;   // chunk was only markers / carried tail

                // estimate this block's denoise window from the previous gap
                var gap = lastArrival > 0 ? rel - lastArrival : defaultGap;
                lastArrival = rel;
                var estDur = Math.max(450, Math.min(2400, gap)) * 0.92;

                // earlier blocks must not lag behind: compress leftovers
                compressPending(m, rel, 220);
                if (scheduleBlock(m, segs, rel, estDur)) {
                    m.phaseEl.textContent = '▚ block ' + m.blocks.length + ' resolving · next one computing…';
                }
            }
        }
        m.streamMs = performance.now() - m.t0;
    } catch (err) {
        if (err && err.name === 'AbortError') {
            m.streamMs = performance.now() - m.t0;
            m.phaseEl.textContent = '■ halted';
        } else {
            m.el.classList.add('error');
            m.bodyEl.textContent = '✕ ' + (err && err.message ? err.message : String(err));
            m.phaseEl.textContent = '✕ link error';
        }
    }

    // flush any held-back partial-marker tail as literal text
    if (m.carry) {
        var tailSegs = [{ tgt: m.mode === 'think' ? 't' : 'a', txt: m.carry }];
        m.carry = '';
        scheduleBlock(m, tailSegs, performance.now() - m.t0, 300);
    }

    // settle: lock whatever remains over a short tail
    var nowRel = performance.now() - m.t0;
    compressPending(m, nowRel, 600);
    if (!m.streamMs) m.streamMs = nowRel;

    var maxLock = 0;
    for (var i = 0; i < m.tokens.length; i++) {
        if (m.tokens[i].lockAt > maxLock) maxLock = m.tokens[i].lockAt;
    }
    m.totalMs = maxLock + 200;
    m.done = true;

    if (m.fullText) convo.push({ role: 'assistant', content: m.fullText });
    if (!m.el.classList.contains('error')) buildFoot(m);
    railFinish(m);
    m.phaseEl.className = 'phase';
    if (m.phaseEl.textContent.indexOf('■') !== 0 && m.phaseEl.textContent.indexOf('✕') !== 0) {
        m.phaseEl.textContent = m.capped ? '▰ settled · ⚠ capped' : '▰ settled';
        if (m.capped) m.phaseEl.className = 'phase cap-warn';
    }

    live = null;
    aborter = null;
    txBtn.textContent = 'TRANSMIT ▸';
    txBtn.className = 'tx-btn';
    inputEl.focus();
}

// ─────────────────────────────────────────────────────────────
// per-message footer: stats + replay + scrubber
// ─────────────────────────────────────────────────────────────
function buildFoot(m) {
    var toks = estTok(m.fullText.length);
    var tokps = m.streamMs > 0 ? Math.round(toks / (m.streamMs / 1000)) : 0;
    var stats = document.createElement('span');
    stats.className = 'stat';
    stats.innerHTML =
        '<b>' + m.blocks.length + '</b> blocks · <b>≈' + toks + '</b> tok · ' +
        '<b>' + fmtS(m.streamMs) + '</b> · <b>' + tokps + '</b> tok/s' +
        (m.capped ? ' · <b class="cap-warn">⚠ hit the token cap — raise MAX TOKENS</b>' : '');
    m.footEl.appendChild(stats);

    var ctl = document.createElement('span');
    ctl.className = 'replay-ctl';

    var btn = document.createElement('button');
    btn.textContent = '⟲ REPLAY';
    var speeds = [0.35, 0.7, 1];
    var speedNames = ['⅓×', '⅔×', '1×'];
    var si = 0;
    var spd = document.createElement('button');
    spd.textContent = speedNames[si];
    var scrub = document.createElement('input');
    scrub.type = 'range';
    scrub.min = '0'; scrub.max = '1000'; scrub.value = '1000';
    m.scrubEl = scrub;

    btn.addEventListener('click', function () {
        hideMd(m);
        m.replay = { playing: true, speed: speeds[si], T: 0, wall: performance.now() };
    });
    spd.addEventListener('click', function () {
        si = (si + 1) % speeds.length;
        spd.textContent = speedNames[si];
        if (m.replay) {
            var now = performance.now();
            m.replay.T = msgTime(m, now);
            m.replay.wall = now;
            m.replay.speed = speeds[si];
        }
    });
    scrub.addEventListener('input', function () {
        hideMd(m);
        var frac = parseInt(scrub.value, 10) / 1000;
        m.replay = { playing: false, speed: speeds[si], T: frac * m.totalMs, wall: performance.now() };
    });

    ctl.appendChild(btn);
    ctl.appendChild(spd);
    ctl.appendChild(scrub);
    m.footEl.appendChild(ctl);
    m.footEl.classList.add('show');
}

// ─────────────────────────────────────────────────────────────
// engine config: entropy is engine-level (vLLM hf_overrides), so
// applying a new value reloads the container (~2–4 min)
// ─────────────────────────────────────────────────────────────
var engineReloading = false;
var entropySel = document.getElementById('entropy-sel');
var entropyApply = document.getElementById('entropy-apply');
var engineStatus = document.getElementById('engine-status');
var lampEl = document.getElementById('lamp');

fetch('/api/engine-config').then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.entropy != null) {
        var v = String(d.entropy);
        for (var i = 0; i < entropySel.options.length; i++) {
            if (entropySel.options[i].value === v) { entropySel.value = v; break; }
        }
    }
}).catch(function () {});

entropyApply.addEventListener('click', function () {
    if (engineReloading || live) return;
    var v = parseFloat(entropySel.value);
    engineReloading = true;
    entropyApply.disabled = true;
    txBtn.disabled = true;
    lampEl.className = 'lamp warm';
    engineStatus.textContent = '⟳ requesting engine reload…';
    var t0 = Date.now();

    fetch('/api/engine-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entropy: v }),
    }).then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || ('http ' + r.status)); });
        var timer = setInterval(function () {
            var secs = Math.round((Date.now() - t0) / 1000);
            engineStatus.textContent = '⟳ engine reloading · entropy ' + v + ' · ' + secs + 's (typ. 2–4 min)';
            fetch('/api/health').then(function (hr) { return hr.json(); }).then(function (h) {
                if (h.status === 'ok') {
                    clearInterval(timer);
                    engineReloading = false;
                    entropyApply.disabled = false;
                    txBtn.disabled = false;
                    lampEl.className = 'lamp live';
                    engineStatus.textContent = '▰ engine live · entropy ' + v + ' · reloaded in ' + secs + 's';
                }
            }).catch(function () {});
        }, 5000);
    }).catch(function (e) {
        engineReloading = false;
        entropyApply.disabled = false;
        txBtn.disabled = false;
        lampEl.className = 'lamp dead';
        engineStatus.textContent = '✕ ' + e.message;
    });
});

// ─────────────────────────────────────────────────────────────
// input wiring
// ─────────────────────────────────────────────────────────────
inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
});
inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        transmit();
    }
});
txBtn.addEventListener('click', function () {
    if (live && aborter) { aborter.abort(); return; }
    transmit();
});
document.querySelectorAll('.chip').forEach(function (c) {
    c.addEventListener('click', function () {
        inputEl.value = c.getAttribute('data-p') || '';
        transmit();
    });
});
inputEl.focus();
</script>
</body>
</html>`;
