#!/usr/bin/env bun
/**
 * Mid-difficulty ranking of Ollama Qwen3.8 thinking rungs via ULC.
 * Hard enough that off/low/xhigh separate; short enough for a 3090 (~2 min).
 *
 *   bun tests/smoke/smoke-ollama-qwen38-hard.ts
 */
import { OllamaClient } from '../../src/providers/ollama.js';
import { AIModelApiType, type ThinkingLevel } from '../../src/interfaces.js';

const URL = (process.env['OLLAMA_URL'] ?? 'http://z690-ex-glacial-win:11434').replace(/\/+$/, '');
const MODEL = process.env['OLLAMA_MODEL'] ?? 'qwen3.8:27b-mtp-q4_K_M';
const MAX = Number(process.env['MAX_TOKENS'] ?? 2048);
const PROMPT =
  process.env['PROMPT'] ??
  'Compute 7^100 mod 100 using Euler\'s theorem. Show φ(100), the reduced exponent, and the last two digits. Then: a bat and a ball cost $1.10; the bat costs $1.00 more than the ball. How much is the ball?';

let lastWire: { think?: unknown; effort?: unknown } | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.body && typeof init.body === 'string') {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    lastWire = { think: body['think'], effort: body['reasoning_effort'] };
  }
  return realFetch(input, init);
}) as typeof fetch;

async function ulc(thinking: boolean | ThinkingLevel) {
  lastWire = null;
  const client = new OllamaClient({
    model: MODEL,
    url: URL,
    apiType: AIModelApiType.Ollama,
    timeout: 180_000,
    thinking,
    defaultParameters: { keep_alive: '15m', temperature: 1.0, top_p: 0.95, seed: 1 },
  });
  const t0 = performance.now();
  const res = await client.chat([{ role: 'user', content: PROMPT }], { maxTokens: MAX });
  return {
    via: 'ulc',
    thinking,
    ms: Math.round(performance.now() - t0),
    wire: lastWire,
    thinkChars: res.reasoning?.length ?? 0,
    contentChars: (res.message.content ?? '').length,
    finish: res.finishReason ?? '?',
    eval: res.usage?.outputTokens ?? null,
  };
}

console.log(`host=${URL} model=${MODEL} maxTokens=${MAX}`);
console.log(`prompt=${PROMPT}`);

for (const level of [false, 'low', 'medium', 'xhigh'] as const) {
  const row = await ulc(level);
  console.log(JSON.stringify(row));
}
