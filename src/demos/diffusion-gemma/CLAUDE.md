# DiffusionGemma demo — test harness + "Signal from Noise" canvas

Standalone Bun server exercising `universal-llm-client` against DiffusionGemma
(a discrete diffusion LM served by vLLM).

## Run

```bash
bun run src/demos/diffusion-gemma/server.ts   # from packages/universal-llm-client
```

- Demo server: **http://localhost:3333** (`/` test harness, `/canvas` diffusion chat UI)
- vLLM upstream: `VLLM_URL` env, default `http://localhost:8000`
- Model: `MODEL_NAME` env, default `RedHatAI/diffusiongemma-26B-A4B-it-NVFP4`
- vLLM is started via `scripts/diffusiongemma-start.sh` (repo root) — includes a
  WSL2 UVA patch and the `entropy_bound` diffusion sampler. Runs as docker
  container `diffusiongemma` (script is bind-mounted as `/start.sh`, so edits
  apply on `docker restart diffusiongemma`). The script also sources
  `~/.cache/huggingface/diffusion-env.sh` (host-writable through the HF-cache
  bind mount) — that's how `/api/engine-config` changes settings without
  recreating the container.
- **Tuned for single-user local serving** (env-overridable in the start script):
  `GPU_MEM_UTIL` (default 0.28 ≈ 27 GiB — without caps vLLM grabbed ~88 GiB:
  69 GiB KV cache for the native 262k context, measured <0.5% used),
  `MAX_MODEL_LEN` (32768), `MAX_NUM_SEQS` (1), `DIFFUSION_ENTROPY` (0.1),
  `ENFORCE_EAGER` (0). Weights are 17.4 GiB.
- **Never re-add `--enforce-eager` casually:** it disables CUDA graphs AND
  torch.compile and cost 2.2× throughput (387 → 841 tok/s avg, peak 1002,
  steady-state ~644 on long runs). Set `ENFORCE_EAGER=1` only to debug
  WSL2/Blackwell graph-capture issues. Entropy 0.1→0.2 measured ≈ no speed
  change (745–845 tok/s) — the dial trades quality, not meaningful speed,
  at these settings.

## Routes

| Route | What |
| ----- | ---- |
| `/` | Test harness UI (chat + compatibility tests via universal-llm-client) |
| `/canvas` | "Signal from Noise" — cinematic chat UI replaying the diffusion process |
| `/api/chat` | Chat via universal-llm-client (`messages`, `stream`, `maxTokens`, `temperature`) |
| `/api/stream-raw` | Direct vLLM SSE proxy preserving chunk timing (`messages` or `prompt`, `maxTokens`, `thinking:false` to disable the thought channel). Always sets `skip_special_tokens:false` so channel markers survive. |
| `/api/engine-config` | GET current entropy; POST `{entropy}` writes the env file + `docker restart`s the engine (~2–4 min; UI polls `/api/health`) |
| `/api/health` | Pings vLLM `/v1/models` |

## Native protocol (no server-side parsers!)

This vLLM build has **no reasoning parser and no tool-call parser module** —
request-level `tools` with auto choice 400s. Everything is client-side, against
the chat template's native markers (visible only with `skip_special_tokens:false`):

- Reasoning: `<|channel>thought\n …<channel|>answer`. The canvas splits this
  with a streaming state machine (partial markers carried across chunks) and
  renders reasoning as a collapsible amber channel above the answer surface.
- **Canvas reading view:** the mono token surface is the animation; when a
  reply settles it fades into a rendered-markdown view (zero-dep renderer in
  the inner script — headings/lists/code/bold/links, all input HTML-escaped
  first; backticks via `String.fromCharCode(96)` because literal backticks
  would terminate the outer template literal). Replay/scrub swaps back to the
  token surface. Root font scales with viewport (`clamp` on `html`) for
  screen-recording legibility. Max-tokens select goes to 16k (default 4k);
  `finish_reason:'length'` shows an amber "⚠ capped" warning in phase+footer.
- Tool calls: `<|tool_call>call:name{k:<|"|>v<|"|>,n:3}<tool_call|>` — pseudo-JSON
  args (bare keys, `<|"|>` quote token). Send `tools` + `tool_choice:'none'`
  (declarations still get rendered into the template); history tool turns go as
  standard structured `tool_calls` + `role:'tool'` messages (template renders
  them natively).
- All of this is implemented for the library in `src/gemma-diffusion.ts` and
  wired into the OpenAI provider (auto-detected by model name; override with
  `LLMClientOptions.gemmaNativeProtocol`). `chatWithTools` works end-to-end.
  Tests: `src/tests/gemma-diffusion.test.ts`. Probes: `probe-stream.ts`
  (chunk timing), `probe-tools.ts` (tool-loop wire format).

## Things that bite

- **`canvas.ts` is one giant TS template literal.** Backslash escapes inside the
  inner `<script>` are eaten by the outer literal (`/\S+/` silently becomes
  `/S+/`). The inner script is written with ZERO backslashes — newlines via
  `String.fromCharCode(10)`, tokenizing via charCode scans. Keep it that way.
- **No hot reload.** `CANVAS_HTML` is bundled at startup — restart the server
  after editing `canvas.ts` (kill the bun process on :3333, start again).
- **Don't name a top-level browser var `history`** — `window.history` is
  unshadowable; the conversation array is called `convo`.
- **Stream shape (measured):** the vLLM OpenAI stream emits ~1KB bursts, one per
  finished 256-token diffusion block, every ~0.8–1.2s. There is no per-denoise-step
  state in the stream; `/canvas` animates each block's reveal during the real
  compute window of the next block. `probe-stream.ts` logs chunk timing.
- **The model emits stray unbalanced `<channel|>` closers** occasionally —
  the parser strips them (`RESIDUAL_SPECIAL` in gemma-diffusion.ts), and it
  sometimes puts the whole final answer inside the thought channel on
  post-tool turns.
- **Entropy is engine-level** (`hf_overrides` read once at model init in
  vLLM's `diffusion_gemma.py`); per-request `vllm_xargs` is accepted but
  ignored. Hence the reload-based `/api/engine-config`.
