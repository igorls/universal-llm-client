#!/usr/bin/env bun
/**
 * Live confirmation: ULC thinking levels against Ollama qwen3.8.
 *
 *   bun tests/smoke/smoke-ollama-qwen38-thinking.ts
 *   OLLAMA_URL=http://z690-ex-glacial-win:11434 bun tests/smoke/smoke-ollama-qwen38-thinking.ts
 *
 * Default host is z590 (idle 3090). Do not point this at a box that must
 * keep Gemma pinned unless you accept a 16 GB evict.
 */
import { OllamaClient } from '../../src/providers/ollama.js';
import { OpenAICompatibleClient } from '../../src/providers/openai.js';
import { AIModelApiType, type ThinkingLevel } from '../../src/interfaces.js';

const URL = (process.env['OLLAMA_URL'] ?? 'http://z590-vision-d:11434').replace(/\/+$/, '');
const MODEL = process.env['OLLAMA_MODEL'] ?? 'qwen3.8:27b-mtp-q4_K_M';
const PROMPT =
  process.env['PROMPT'] ??
  'O plano Bronze tem carência de 90 dias para consultas. Um cliente pergunta se pode marcar consulta amanhã. Responda em 2 frases, em português.';

type Wire = { readonly path: string; readonly think?: unknown; readonly effort?: unknown };

let lastWire: Wire | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input);
  if (init?.body && typeof init.body === 'string' && path.includes('chat')) {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const kwargs = body['chat_template_kwargs'] as { reasoning_effort?: unknown } | undefined;
    lastWire = {
      path,
      think: body['think'],
      effort: body['reasoning_effort'] ?? kwargs?.reasoning_effort,
    };
  }
  return realFetch(input, init);
}) as typeof fetch;

function clip(s: string, n = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

async function native(thinking: boolean | ThinkingLevel, maxTokens: number) {
  lastWire = null;
  const client = new OllamaClient({
    model: MODEL,
    url: URL,
    apiType: AIModelApiType.Ollama,
    timeout: 300_000,
    thinking,
    defaultParameters: { keep_alive: '15m', temperature: thinking === false ? 0.7 : 1.0 },
  });
  const t0 = performance.now();
  const res = await client.chat([{ role: 'user', content: PROMPT }], { maxTokens });
  return {
    lane: 'native',
    thinking,
    ms: Math.round(performance.now() - t0),
    wire: lastWire,
    thinkChars: res.reasoning?.length ?? 0,
    contentChars: (res.message.content ?? '').length,
    content: clip(res.message.content ?? ''),
    finish: res.finishReason ?? '?',
    eval: res.usage?.outputTokens ?? null,
  };
}

async function compat(thinking: boolean | ThinkingLevel, maxTokens: number) {
  lastWire = null;
  const client = new OpenAICompatibleClient({
    model: MODEL,
    url: URL,
    apiType: AIModelApiType.OpenAI,
    timeout: 300_000,
    thinking,
  });
  const t0 = performance.now();
  const res = await client.chat([{ role: 'user', content: PROMPT }], { maxTokens });
  return {
    lane: 'compat-/v1',
    thinking,
    ms: Math.round(performance.now() - t0),
    wire: lastWire,
    thinkChars: res.reasoning?.length ?? 0,
    contentChars: (res.message.content ?? '').length,
    content: clip(res.message.content ?? ''),
    finish: res.finishReason ?? '?',
    eval: res.usage?.outputTokens ?? null,
  };
}

async function rawThinkFalseOnly() {
  lastWire = null;
  const t0 = performance.now();
  const r = await realFetch(`${URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: PROMPT }],
      stream: false,
      think: false,
      keep_alive: '15m',
      options: { temperature: 0.7, num_predict: 256 },
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const json = (await r.json()) as {
    message?: { content?: string; thinking?: string };
    done_reason?: string;
    eval_count?: number;
    error?: string;
  };
  lastWire = { path: `${URL}/api/chat`, think: false, effort: undefined };
  if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
  return {
    lane: 'raw-think-false-only',
    thinking: false,
    ms: Math.round(performance.now() - t0),
    wire: lastWire,
    thinkChars: json.message?.thinking?.length ?? 0,
    contentChars: (json.message?.content ?? '').length,
    content: clip(json.message?.content ?? ''),
    finish: json.done_reason ?? '?',
    eval: json.eval_count ?? null,
  };
}

const rows: unknown[] = [];
function add(row: unknown) {
  rows.push(row);
  console.log(JSON.stringify(row));
}

console.log(`host=${URL} model=${MODEL}`);

// Control first so we still see the 3.8 bug if ULC off later succeeds.
add(await rawThinkFalseOnly());
add(await native(false, 256));
add(await native('low', 512));
add(await native('medium', 512));
add(await native('xhigh', 512));
add(await compat(false, 256));
add(await compat('low', 512));

function row(lane: string, thinking: unknown) {
  return rows.find((r) => {
    const x = r as { lane: string; thinking: unknown };
    return x.lane === lane && x.thinking === thinking;
  }) as { thinkChars: number; contentChars: number; wire?: { think?: unknown; effort?: unknown } };
}

const nativeOff = row('native', false);
const nativeLow = row('native', 'low');
const nativeMed = row('native', 'medium');
const nativeX = row('native', 'xhigh');
const compatOff = row('compat-/v1', false);
const compatLow = row('compat-/v1', 'low');

const ok =
  nativeOff.thinkChars === 0 &&
  nativeOff.contentChars > 0 &&
  nativeOff.wire?.effort === 'none' &&
  nativeLow.thinkChars > 0 &&
  nativeLow.wire?.think === 'low' &&
  nativeMed.thinkChars > 0 &&
  nativeX.thinkChars > 0 &&
  nativeX.wire?.think === true &&
  nativeX.wire?.effort === 'xhigh' &&
  compatOff.thinkChars === 0 &&
  compatOff.wire?.effort === 'none' &&
  compatLow.thinkChars > 0;

console.log(
  ok
    ? 'PASS: ULC off has no think block; levels emit think; xhigh maps to think=true+effort=xhigh'
    : 'FAIL: see rows above',
);
process.exit(ok ? 0 : 1);
