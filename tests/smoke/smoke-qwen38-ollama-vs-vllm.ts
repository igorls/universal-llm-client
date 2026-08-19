#!/usr/bin/env bun
/**
 * Same prompt + unified thinking rungs on local Ollama vs local vLLM.
 *
 *   bun tests/smoke/smoke-qwen38-ollama-vs-vllm.ts
 */
import { OllamaClient } from '../../src/providers/ollama.js';
import { OpenAICompatibleClient } from '../../src/providers/openai.js';
import { AIModelApiType, type ThinkingLevel } from '../../src/interfaces.js';

const OLLAMA_URL = (process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
const VLLM_URL = (process.env['VLLM_URL'] ?? 'http://127.0.0.1:8010/v1').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'qwen3.8:27b-mtp-q4_K_M';
const VLLM_MODEL = process.env['VLLM_MODEL'] ?? 'qwen3.8-27b-nvfp4';
const MAX = Number(process.env['MAX_TOKENS'] ?? 2048);
const PROMPT =
  process.env['PROMPT'] ??
  'Compute 7^100 mod 100 using Euler\'s theorem. Show φ(100), the reduced exponent, and the last two digits. Then: a bat and a ball cost $1.10; the bat costs $1.00 more than the ball. How much is the ball?';

const LEVELS = [false, 'low', 'medium', 'xhigh'] as const;

let lastWire: Record<string, unknown> | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.body && typeof init.body === 'string') {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const kwargs = body['chat_template_kwargs'] as Record<string, unknown> | undefined;
    lastWire = {
      think: body['think'],
      effort: body['reasoning_effort'] ?? kwargs?.['reasoning_effort'],
      enable_thinking: kwargs?.['enable_thinking'],
    };
  }
  return realFetch(input, init);
}) as typeof fetch;

type Row = {
  readonly engine: string;
  readonly thinking: boolean | ThinkingLevel;
  readonly ms: number;
  readonly thinkChars: number;
  readonly contentChars: number;
  readonly eval: number | null;
  readonly finish: string;
  readonly wire: Record<string, unknown> | null;
};

async function ollama(thinking: boolean | ThinkingLevel): Promise<Row> {
  lastWire = null;
  const client = new OllamaClient({
    model: OLLAMA_MODEL,
    url: OLLAMA_URL,
    apiType: AIModelApiType.Ollama,
    timeout: 180_000,
    thinking,
    defaultParameters: { keep_alive: '15m', temperature: 1.0, top_p: 0.95, seed: 1 },
  });
  const t0 = performance.now();
  const res = await client.chat([{ role: 'user', content: PROMPT }], { maxTokens: MAX });
  return {
    engine: 'ollama-q4_K_M',
    thinking,
    ms: Math.round(performance.now() - t0),
    thinkChars: res.reasoning?.length ?? 0,
    contentChars: (res.message.content ?? '').length,
    eval: res.usage?.outputTokens ?? null,
    finish: res.finishReason ?? '?',
    wire: lastWire,
  };
}

async function vllm(thinking: boolean | ThinkingLevel): Promise<Row> {
  lastWire = null;
  const client = new OpenAICompatibleClient({
    model: VLLM_MODEL,
    url: VLLM_URL,
    apiType: AIModelApiType.OpenAI,
    timeout: 180_000,
    thinking,
    defaultParameters: { temperature: 1.0, top_p: 0.95, seed: 1 },
  });
  const t0 = performance.now();
  const res = await client.chat([{ role: 'user', content: PROMPT }], { maxTokens: MAX });
  return {
    engine: 'vllm-nvfp4',
    thinking,
    ms: Math.round(performance.now() - t0),
    thinkChars: res.reasoning?.length ?? 0,
    contentChars: (res.message.content ?? '').length,
    eval: res.usage?.outputTokens ?? null,
    finish: res.finishReason ?? '?',
    wire: lastWire,
  };
}

console.log(`ollama=${OLLAMA_URL} ${OLLAMA_MODEL}`);
console.log(`vllm=${VLLM_URL} ${VLLM_MODEL}`);
console.log(`maxTokens=${MAX}`);
console.log(`prompt=${PROMPT}`);

const rows: Row[] = [];
for (const level of LEVELS) {
  const a = await ollama(level);
  rows.push(a);
  console.log(JSON.stringify(a));
  const b = await vllm(level);
  rows.push(b);
  console.log(JSON.stringify(b));
}

console.log('');
console.log('engine            rung     thinkChars  eval  content  ms     finish  wire');
for (const r of rows) {
  const wire =
    r.engine.startsWith('ollama')
      ? `think=${String(r.wire?.['think'])}`
      : `enable=${String(r.wire?.['enable_thinking'])} effort=${String(r.wire?.['effort'])}`;
  console.log(
    `${r.engine.padEnd(17)} ${String(r.thinking).padEnd(8)} ${String(r.thinkChars).padStart(10)} ${String(r.eval ?? '?').padStart(5)} ${String(r.contentChars).padStart(8)} ${String(r.ms).padStart(6)} ${r.finish.padEnd(7)} ${wire}`,
  );
}
