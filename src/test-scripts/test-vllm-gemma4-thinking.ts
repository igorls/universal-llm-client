/**
 * vLLM + Gemma-4 (NVFP4) reasoning/thinking probe via universal-llm-client.
 *
 * Server (default): infra/vllm-gemma on :8010 — gemma-4-26b-a4b-nvfp4
 *
 *   bun run src/test-scripts/test-vllm-gemma4-thinking.ts
 *
 * Env:
 *   VLLM_URL   (default http://localhost:8010)
 *   VLLM_MODEL (default gemma-4-26b-a4b-nvfp4)
 */

import { AIModel } from '../index.js';
import type { DecodedEvent } from '../stream-decoder.js';
import type { LLMChatResponse, ThinkingLevel } from '../interfaces.js';

const URL = process.env.VLLM_URL ?? 'http://localhost:8010';
const MODEL = process.env.VLLM_MODEL ?? 'gemma-4-26b-a4b-nvfp4';

type Status = 'PASS' | 'FAIL' | 'PARTIAL' | 'INFO';
const results: { name: string; status: Status; note: string }[] = [];

function record(name: string, status: Status, note = '') {
    results.push({ name, status, note });
    const icon = status === 'PASS' ? '✅' : status === 'PARTIAL' ? '🟡' : status === 'INFO' ? 'ℹ️' : '❌';
    console.log(`\n${icon} ${name} — ${status}${note ? `\n   ${note}` : ''}`);
}
function section(title: string) {
    console.log(`\n${'━'.repeat(72)}\n${title}\n${'━'.repeat(72)}`);
}

async function drainStream(
    gen: AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>,
): Promise<{ events: DecodedEvent[]; result: LLMChatResponse | void }> {
    const events: DecodedEvent[] = [];
    let result: LLMChatResponse | void;
    while (true) {
        const { value, done } = await gen.next();
        if (done) {
            result = value as LLMChatResponse | void;
            break;
        }
        events.push(value);
    }
    return { events, result };
}

async function rawChat(body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, ...body }),
    });
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        return { _httpStatus: res.status, _raw: text.slice(0, 500) };
    }
}

const REASON_PROMPT =
    'A farmer has 17 sheep. All but 9 run away. Then he buys 5 more. How many sheep does he have? Think carefully, then give only the final number.';

const SHORT_PROMPT = 'What is the capital of Japan? One short sentence.';

function summarizeEvents(events: DecodedEvent[]) {
    const byType: Record<string, number> = {};
    let text = '';
    let thinking = '';
    for (const e of events) {
        byType[e.type] = (byType[e.type] ?? 0) + 1;
        if (e.type === 'text') text += e.content;
        if (e.type === 'thinking') thinking += e.content;
    }
    return { byType, text, thinking };
}

async function main() {
    console.log(`Gemma-4 vLLM thinking probe\n  url   = ${URL}\n  model = ${MODEL}`);

    // Model with NO default thinking — we set per-call so "unset" is measurable.
    const model = new AIModel({
        model: MODEL,
        timeout: 180_000,
        providers: [{ type: 'openai', url: URL, apiKey: 'EMPTY' }],
    });

    // -------------------------------------------------------------------------
    section('1. Connectivity');
    try {
        const models = await model.getModels();
        console.log('   models:', models);
        if (models.includes(MODEL)) record('Model discovery', 'PASS', `"${MODEL}" listed`);
        else record('Model discovery', 'PARTIAL', `"${MODEL}" not in ${JSON.stringify(models)}`);
    } catch (e) {
        record('Model discovery', 'FAIL', (e as Error).message);
        printSummary();
        return;
    }

    // -------------------------------------------------------------------------
    section('2. Default behavior (thinking unset — server default)');
    try {
        const r = await model.chat([{ role: 'user', content: SHORT_PROMPT }], {
            temperature: 0,
            maxTokens: 256,
        });
        const content = r.message.content?.trim() ?? '';
        console.log('   content :', JSON.stringify(content));
        console.log('   reasoning len:', (r.reasoning ?? '').length);
        console.log('   usage   :', JSON.stringify(r.usage));
        if (content.toLowerCase().includes('tokyo')) {
            record('Default chat (unset thinking)', 'PASS', `clean answer, completion=${r.usage?.completionTokens ?? '?'}`);
        } else if (content.length > 0) {
            record('Default chat (unset thinking)', 'PARTIAL', content.slice(0, 120));
        } else {
            record('Default chat (unset thinking)', 'FAIL', 'empty content');
        }
    } catch (e) {
        record('Default chat (unset thinking)', 'FAIL', (e as Error).message);
    }

    // -------------------------------------------------------------------------
    section('3. thinking:false (ULC → chat_template_kwargs.enable_thinking=false)');
    try {
        const t0 = performance.now();
        const r = await model.chat([{ role: 'user', content: REASON_PROMPT }], {
            temperature: 0,
            maxTokens: 512,
            thinking: false,
        });
        const ms = Math.round(performance.now() - t0);
        const content = r.message.content?.trim() ?? '';
        console.log('   content :', JSON.stringify(content));
        console.log('   reasoning len:', (r.reasoning ?? '').length);
        console.log('   usage   :', JSON.stringify(r.usage), `wall=${ms}ms`);
        const ok = content.includes('14') && (r.usage?.completionTokens ?? 999) < 50;
        if (ok) record('thinking:false non-stream', 'PASS', `answer+cheap (${r.usage?.completionTokens} tok, ${ms}ms)`);
        else if (content.includes('14')) record('thinking:false non-stream', 'PARTIAL', `got 14 but tok=${r.usage?.completionTokens}`);
        else if (content) record('thinking:false non-stream', 'PARTIAL', content.slice(0, 100));
        else record('thinking:false non-stream', 'FAIL', 'empty');
    } catch (e) {
        record('thinking:false non-stream', 'FAIL', (e as Error).message);
    }

    // -------------------------------------------------------------------------
    section('4. thinking:true non-stream');
    try {
        const t0 = performance.now();
        const r = await model.chat([{ role: 'user', content: REASON_PROMPT }], {
            temperature: 0,
            maxTokens: 1024,
            thinking: true,
        });
        const ms = Math.round(performance.now() - t0);
        const content = r.message.content?.trim() ?? '';
        const reasoning = r.reasoning ?? '';
        console.log('   content len:', content.length, 'head:', JSON.stringify(content.slice(0, 160)));
        console.log('   reasoning len:', reasoning.length, 'head:', JSON.stringify(reasoning.slice(0, 160)));
        console.log('   usage   :', JSON.stringify(r.usage), `wall=${ms}ms`);

        // Ground-truth raw
        const raw = await rawChat({
            messages: [{ role: 'user', content: REASON_PROMPT }],
            max_tokens: 1024,
            temperature: 0,
            chat_template_kwargs: { enable_thinking: true },
        });
        const rawMsg = raw?.choices?.[0]?.message ?? {};
        console.log('   [raw] content type:', typeof rawMsg.content, 'len:', (rawMsg.content ?? '').length ?? 0);
        console.log('   [raw] reasoning type:', typeof rawMsg.reasoning, 'len:', (rawMsg.reasoning ?? '').length ?? 0);
        console.log('   [raw] reasoning_content type:', typeof rawMsg.reasoning_content);
        console.log('   [raw] keys:', Object.keys(rawMsg));
        console.log('   [raw] usage:', JSON.stringify(raw?.usage));

        if (!content && !reasoning && (r.usage?.completionTokens ?? 0) > 20) {
            record(
                'thinking:true non-stream',
                'FAIL',
                `Spent ${r.usage?.completionTokens} completion tokens but content+reasoning both empty (raw same). Tokens are generated then dropped — non-stream thinking is broken/unusable on this vLLM+Gemma stack.`,
            );
        } else if (reasoning.length > 20 && content.includes('14')) {
            record('thinking:true non-stream', 'PASS', `reasoning=${reasoning.length}c content clean`);
        } else if (content.includes('14')) {
            record('thinking:true non-stream', 'PARTIAL', 'answer ok but no separate reasoning field');
        } else {
            record('thinking:true non-stream', 'FAIL', `content=${JSON.stringify(content.slice(0, 80))} reasoning=${reasoning.length}`);
        }
    } catch (e) {
        record('thinking:true non-stream', 'FAIL', (e as Error).message);
    }

    // -------------------------------------------------------------------------
    section('5. thinking:true stream (ULC chatStream)');
    try {
        const t0 = performance.now();
        const { events, result } = await drainStream(
            model.chatStream([{ role: 'user', content: REASON_PROMPT }], {
                temperature: 0,
                maxTokens: 1024,
                thinking: true,
            }),
        );
        const ms = Math.round(performance.now() - t0);
        const { byType, text, thinking } = summarizeEvents(events);
        const finalContent = (result && 'message' in result ? result.message.content : '') ?? '';
        const finalReasoning = (result && 'reasoning' in result ? result.reasoning : '') ?? '';
        console.log('   events by type:', byType);
        console.log('   stream text len:', text.length, 'head:', JSON.stringify(text.slice(0, 200)));
        console.log('   stream thinking len:', thinking.length, 'head:', JSON.stringify(thinking.slice(0, 200)));
        console.log('   final content len:', finalContent.length, 'head:', JSON.stringify(finalContent.slice(0, 200)));
        console.log('   final reasoning len:', finalReasoning.length);
        console.log('   usage:', JSON.stringify(result && 'usage' in result ? result.usage : null), `wall=${ms}ms`);

        const hasThinkEvents = (byType['thinking'] ?? 0) > 0;
        const answerInText = text.includes('14') || finalContent.includes('14');
        const thoughtInText = /^thought\b/i.test(text.trim()) || text.includes('Initial number of sheep');

        if (hasThinkEvents && answerInText) {
            record('thinking:true stream', 'PASS', `thinking events + answer; wall=${ms}ms`);
        } else if (thoughtInText && !answerInText) {
            record(
                'thinking:true stream',
                'FAIL',
                `Reasoning leaked into content as "thought…" and no final number — model burned budget on CoT only (or answer not separated). text=${text.length}c thinkingEvents=${byType['thinking'] ?? 0}`,
            );
        } else if (thoughtInText && answerInText) {
            record(
                'thinking:true stream',
                'PARTIAL',
                'Answer present but CoT mixed into content (not split into thinking events). ULC would show raw thought to visitors if enabled.',
            );
        } else if (answerInText) {
            record('thinking:true stream', 'PARTIAL', 'answer ok, no thinking events');
        } else {
            record('thinking:true stream', 'FAIL', `no answer; types=${JSON.stringify(byType)}`);
        }
    } catch (e) {
        record('thinking:true stream', 'FAIL', (e as Error).message);
    }

    // -------------------------------------------------------------------------
    section('6. thinking:false stream');
    try {
        const t0 = performance.now();
        const { events, result } = await drainStream(
            model.chatStream([{ role: 'user', content: REASON_PROMPT }], {
                temperature: 0,
                maxTokens: 256,
                thinking: false,
            }),
        );
        const ms = Math.round(performance.now() - t0);
        const { byType, text } = summarizeEvents(events);
        const finalContent = (result && 'message' in result ? result.message.content : '') ?? '';
        console.log('   events by type:', byType);
        console.log('   text:', JSON.stringify(text || finalContent));
        console.log('   usage:', JSON.stringify(result && 'usage' in result ? result.usage : null), `wall=${ms}ms`);
        if ((text || finalContent).includes('14')) {
            record('thinking:false stream', 'PASS', `fast clean answer (${ms}ms)`);
        } else {
            record('thinking:false stream', 'FAIL', JSON.stringify(text || finalContent).slice(0, 100));
        }
    } catch (e) {
        record('thinking:false stream', 'FAIL', (e as Error).message);
    }

    // -------------------------------------------------------------------------
    section('7. Thinking levels (minimal / low / medium / high) — stream, short prompt');
    const levels: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];
    for (const level of levels) {
        try {
            const t0 = performance.now();
            const { events, result } = await drainStream(
                model.chatStream([{ role: 'user', content: REASON_PROMPT }], {
                    temperature: 0,
                    maxTokens: 1024,
                    thinking: level,
                }),
            );
            const ms = Math.round(performance.now() - t0);
            const { byType, text, thinking } = summarizeEvents(events);
            const usage = result && 'usage' in result ? result.usage : undefined;
            const finalContent = (result && 'message' in result ? result.message.content : '') ?? '';
            const combined = text || finalContent;
            console.log(
                `   [${level}] tok=${usage?.completionTokens ?? '?'} wall=${ms}ms types=${JSON.stringify(byType)} ` +
                    `text=${combined.length}c think=${thinking.length}c head=${JSON.stringify(combined.slice(0, 80))}`,
            );
            record(
                `level:${level}`,
                'INFO',
                `completionTokens=${usage?.completionTokens ?? '?'} wallMs=${ms} textChars=${combined.length} thinkingChars=${thinking.length} has14=${combined.includes('14')}`,
            );
        } catch (e) {
            record(`level:${level}`, 'FAIL', (e as Error).message);
        }
    }

    // -------------------------------------------------------------------------
    section('8. Tool call with thinking on vs off');
    for (const mode of [false, true] as const) {
        const label = mode ? 'tools+thinking:true' : 'tools+thinking:false';
        try {
            let toolHit = false;
            const m = new AIModel({
                model: MODEL,
                timeout: 180_000,
                providers: [{ type: 'openai', url: URL, apiKey: 'EMPTY' }],
            });
            m.registerTool(
                'multiply',
                'Multiply two integers and return the product',
                {
                    type: 'object',
                    properties: { a: { type: 'number' }, b: { type: 'number' } },
                    required: ['a', 'b'],
                },
                async (args: any) => {
                    toolHit = true;
                    return { product: args.a * args.b };
                },
            );
            const t0 = performance.now();
            const r = await m.chatWithTools(
                [{ role: 'user', content: 'Use the multiply tool to compute 17 times 23, then state the product.' }],
                { temperature: 0, maxTokens: 1024, maxIterations: 4, thinking: mode },
            );
            const ms = Math.round(performance.now() - t0);
            const content = r.message.content ?? '';
            const traces = r.toolExecutions ?? [];
            console.log(`   [${label}] toolHit=${toolHit} traces=${traces.length} content=${JSON.stringify(content.slice(0, 120))} wall=${ms}ms`);
            if (toolHit && content.includes('391')) record(label, 'PASS', `${traces.length} tool step(s), ${ms}ms`);
            else if (toolHit) record(label, 'PARTIAL', `tool ran but answer missing 391: ${content.slice(0, 80)}`);
            else record(label, 'FAIL', `tool not invoked; content=${content.slice(0, 100)}`);
            await m.dispose();
        } catch (e) {
            record(label, 'FAIL', (e as Error).message);
        }
    }

    // -------------------------------------------------------------------------
    section('9. Support-style turn (Concierge-ish) — thinking on vs off latency');
    const supportPrompt =
        'Visitor: How long does shipping take to São Paulo?\n' +
        'Knowledge: Standard shipping is 5-8 business days to Brazil capital cities; express is 2-3 days.\n' +
        'Reply in one friendly sentence in Portuguese.';
    for (const mode of [false, true] as const) {
        const label = mode ? 'support thinking:true' : 'support thinking:false';
        try {
            const t0 = performance.now();
            const { events, result } = await drainStream(
                model.chatStream([{ role: 'user', content: supportPrompt }], {
                    temperature: 0.2,
                    maxTokens: 512,
                    thinking: mode,
                }),
            );
            const ms = Math.round(performance.now() - t0);
            const { byType, text } = summarizeEvents(events);
            const finalContent = (result && 'message' in result ? result.message.content : '') ?? '';
            const combined = (text || finalContent).trim();
            const usage = result && 'usage' in result ? result.usage : undefined;
            console.log(
                `   [${label}] ${ms}ms tok=${usage?.completionTokens ?? '?'} types=${JSON.stringify(byType)} ` +
                    `out=${JSON.stringify(combined.slice(0, 160))}`,
            );
            const looksPt = /[áàâãéêíóôõúç]|dias|envio|entrega|São|Sao/i.test(combined);
            if (combined.length > 10 && !combined.startsWith('thought') && looksPt) {
                record(label, 'PASS', `${ms}ms, ${usage?.completionTokens ?? '?'} tok, visitor-safe text`);
            } else if (combined.startsWith('thought') || combined.includes('Initial')) {
                record(label, 'FAIL', `CoT leaked to visitor surface (${ms}ms): ${combined.slice(0, 100)}`);
            } else if (combined.length > 0) {
                record(label, 'PARTIAL', `${ms}ms: ${combined.slice(0, 100)}`);
            } else {
                record(label, 'FAIL', `empty after ${ms}ms`);
            }
        } catch (e) {
            record(label, 'FAIL', (e as Error).message);
        }
    }

    await model.dispose();
    printSummary();
}

function printSummary() {
    section('SUMMARY');
    const pad = Math.max(...results.map((r) => r.name.length), 10);
    for (const r of results) {
        const icon = r.status === 'PASS' ? '✅' : r.status === 'PARTIAL' ? '🟡' : r.status === 'INFO' ? 'ℹ️' : '❌';
        console.log(`${icon} ${r.name.padEnd(pad)}  ${r.status}${r.note ? '  — ' + r.note.slice(0, 140) : ''}`);
    }
    const pass = results.filter((r) => r.status === 'PASS').length;
    const fail = results.filter((r) => r.status === 'FAIL').length;
    console.log(`\n${pass} PASS / ${fail} FAIL / ${results.length} total (INFO/PARTIAL counted in total)`);
}

main().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
});
