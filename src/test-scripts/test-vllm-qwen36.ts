/**
 * vLLM + Qwen3.6 (NVFP4) compatibility test for universal-llm-client.
 *
 * Exercises the OpenAI-compatible provider against a local vLLM server running
 * nvidia/Qwen3.6-35B-A3B-NVFP4, with special attention to REASONING handling.
 *
 * Run (server must be up on :8000):
 *   bun run src/test-scripts/test-vllm-qwen36.ts
 *
 * Env overrides:
 *   VLLM_URL   (default http://localhost:8000)
 *   VLLM_MODEL (default qwen3.6-nvfp4)
 */

import { AIModel } from '../index.js';
import type { DecodedEvent } from '../stream-decoder.js';
import type { LLMChatResponse } from '../interfaces.js';

const URL = process.env.VLLM_URL ?? 'http://localhost:8000';
const MODEL = process.env.VLLM_MODEL ?? 'qwen3.6-nvfp4';

// ---------------------------------------------------------------------------
// tiny test harness
// ---------------------------------------------------------------------------
type Status = 'PASS' | 'FAIL' | 'PARTIAL';
const results: { name: string; status: Status; note: string }[] = [];
function record(name: string, status: Status, note = '') {
    results.push({ name, status, note });
    const icon = status === 'PASS' ? '✅' : status === 'PARTIAL' ? '🟡' : '❌';
    console.log(`\n${icon} ${name} — ${status}${note ? `\n   ${note}` : ''}`);
}
function section(title: string) {
    console.log(`\n${'━'.repeat(70)}\n${title}\n${'━'.repeat(70)}`);
}

/** Drain a chatStream generator, collecting events AND the final return value. */
async function drainStream(
    gen: AsyncGenerator<DecodedEvent, LLMChatResponse | void, unknown>,
): Promise<{ events: DecodedEvent[]; result: LLMChatResponse | void }> {
    const events: DecodedEvent[] = [];
    let result: LLMChatResponse | void;
    while (true) {
        const { value, done } = await gen.next();
        if (done) { result = value as LLMChatResponse | void; break; }
        events.push(value);
    }
    return { events, result };
}

/** Raw OpenAI call straight to vLLM — ground truth for what the server emits. */
async function rawChat(body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, ...body }),
    });
    return res.json();
}

const REASON_PROMPT =
    'A farmer has 17 sheep. All but 9 run away. Then he buys 5 more. How many sheep does he have? Think it through, then give the number.';

// ---------------------------------------------------------------------------

async function main() {
    console.log(`vLLM compatibility test\n  url   = ${URL}\n  model = ${MODEL}`);

    const model = new AIModel({
        model: MODEL,
        thinking: true, // intent flag (no-op for the openai provider, but documents intent)
        timeout: 120_000,
        providers: [{ type: 'openai', url: URL, apiKey: 'EMPTY' }],
    });

    // ----- 1. Connectivity / model discovery --------------------------------
    section('1. Connectivity & model discovery');
    try {
        const models = await model.getModels();
        console.log('   /v1/models ->', models);
        if (models.includes(MODEL)) record('Model discovery', 'PASS', `served model "${MODEL}" is listed`);
        else record('Model discovery', 'PARTIAL', `server reachable but "${MODEL}" not in ${JSON.stringify(models)}`);
    } catch (e) {
        record('Model discovery', 'FAIL', `cannot reach server: ${(e as Error).message}`);
        console.log('\nAborting — server unreachable.');
        printSummary();
        return;
    }

    // ----- 2. Basic chat (non-streaming) ------------------------------------
    section('2. Basic chat (non-streaming)');
    try {
        const r = await model.chat(
            [{ role: 'user', content: 'In one short sentence, what is the capital of Japan?' }],
            { temperature: 0, maxTokens: 256 },
        );
        const content = r.message.content?.trim() ?? '';
        console.log('   content :', JSON.stringify(content));
        console.log('   usage   :', JSON.stringify(r.usage));
        if (r.usage?.tokensPerSecond) {
            console.log(`   stats   : ${r.usage.tokensPerSecond.toFixed(1)} tok/s over ${r.usage.durationMs}ms wall-clock`);
        }
        if (content.toLowerCase().includes('tokyo')) record('Basic chat', 'PASS', 'correct, clean answer (reasoning stripped server-side)');
        else if (content.length > 0) record('Basic chat', 'PARTIAL', 'got content but expected "Tokyo"');
        else record('Basic chat', 'FAIL', 'empty content (model spent budget reasoning — see reasoning section)');
    } catch (e) {
        record('Basic chat', 'FAIL', (e as Error).message);
    }

    // ----- 3. Streaming -----------------------------------------------------
    section('3. Streaming (chatStream)');
    try {
        const { events, result } = await drainStream(
            model.chatStream(
                [{ role: 'user', content: 'List three colors, comma separated.' }],
                // Generous budget: Qwen3.6 thinks first, so a small cap is spent
                // entirely on reasoning before any answer tokens are produced.
                { temperature: 0, maxTokens: 1024 },
            ),
        );
        const textEvents = events.filter(e => e.type === 'text').length;
        const thinkingEvents = events.filter(e => e.type === 'thinking').length;
        const finalContent = (result && 'message' in result ? result.message.content : '')?.trim() ?? '';
        console.log(`   events: ${events.length} (text=${textEvents}, thinking=${thinkingEvents})`);
        console.log('   final content:', JSON.stringify(finalContent));
        if (textEvents > 0 && finalContent.length > 0) record('Streaming', 'PASS', `${textEvents} text deltas streamed, final content assembled`);
        else record('Streaming', 'PARTIAL', 'stream completed but content was empty');
    } catch (e) {
        record('Streaming', 'FAIL', (e as Error).message);
    }

    // ----- 4. REASONING (the focus) -----------------------------------------
    section('4. Reasoning exposure (Qwen3.6 thinking)');
    try {
        // 4a. Ground truth: what does vLLM actually send?
        const raw = await rawChat({
            messages: [{ role: 'user', content: REASON_PROMPT }],
            max_tokens: 800,
            temperature: 0,
        });
        const rawMsg = raw?.choices?.[0]?.message ?? {};
        const serverReasoning: string = rawMsg.reasoning ?? rawMsg.reasoning_content ?? '';
        const serverContent: string = rawMsg.content ?? '';
        console.log(`   [server raw] reasoning field: ${serverReasoning.length} chars; content field: ${serverContent.length} chars`);
        if (serverReasoning) console.log(`   [server raw] reasoning preview: ${JSON.stringify(serverReasoning.slice(0, 120))}…`);
        console.log(`   [server raw] content        : ${JSON.stringify(serverContent.slice(0, 120))}`);

        // 4b. What the client surfaces (non-streaming)
        const r = await model.chat([{ role: 'user', content: REASON_PROMPT }], { temperature: 0, maxTokens: 800 });
        const clientReasoning = r.reasoning ?? '';
        const clientContent = r.message.content ?? '';
        console.log(`   [client chat] .reasoning: ${clientReasoning.length} chars; .content: ${clientContent.length} chars`);

        // 4c. What the client surfaces (streaming — uses StandardChatDecoder <think> parser)
        const { result } = await drainStream(model.chatStream([{ role: 'user', content: REASON_PROMPT }], { temperature: 0, maxTokens: 800 }));
        const streamReasoning = (result && 'reasoning' in result ? result.reasoning : '') ?? '';
        console.log(`   [client stream] .reasoning: ${streamReasoning.length} chars`);

        const serverHasReasoning = serverReasoning.length > 50;
        const clientExposes = clientReasoning.length > 0 || streamReasoning.length > 0;
        const contentClean = !clientContent.includes('<think>');

        if (serverHasReasoning && clientExposes) {
            record('Reasoning exposure', 'PASS', 'client surfaces the reasoning trace via .reasoning');
        } else if (serverHasReasoning && !clientExposes && contentClean) {
            record('Reasoning exposure', 'PARTIAL',
                'Server emits reasoning in a separate `reasoning` field; client returns CLEAN answers but does NOT expose the trace ' +
                '(the openai provider reads `content`/`delta.content` only, never `reasoning`/`reasoning_content`). ' +
                'Fix: read `message.reasoning`/`delta.reasoning` in providers/openai.ts.');
        } else if (clientContent.includes('<think>')) {
            record('Reasoning exposure', 'PARTIAL', 'Reasoning leaks into content as <think> tags (run server WITHOUT --reasoning-parser, then streaming separates it).');
        } else {
            record('Reasoning exposure', 'FAIL', 'No reasoning surfaced anywhere.');
        }
    } catch (e) {
        record('Reasoning exposure', 'FAIL', (e as Error).message);
    }

    // ----- 5. Tool calling --------------------------------------------------
    section('5. Tool calling (chatWithTools)');
    try {
        let toolHit = false;
        model.registerTool(
            'multiply',
            'Multiply two integers and return the product',
            { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
            async (args: any) => { toolHit = true; return { product: args.a * args.b }; },
        );
        const r = await model.chatWithTools(
            [{ role: 'user', content: 'Use the multiply tool to compute 17 times 23, then state the result.' }],
            { temperature: 0, maxTokens: 1024, maxIterations: 3 },
        );
        const trace = r.toolExecutions ?? [];
        const content = r.message.content ?? '';
        console.log('   toolExecutions:', JSON.stringify(trace));
        console.log('   content  :', JSON.stringify(content.slice(0, 160)));
        if (toolHit && content.includes('391')) record('Tool calling', 'PASS', `tool executed (${trace.length} trace entr${trace.length === 1 ? 'y' : 'ies'}), answer 391 returned`);
        else if (toolHit) record('Tool calling', 'PARTIAL', 'tool fired but final answer missing 391');
        else record('Tool calling', 'PARTIAL', 'tool NOT invoked — vLLM likely needs `--enable-auto-tool-choice --tool-call-parser hermes`');
    } catch (e) {
        record('Tool calling', 'FAIL', (e as Error).message);
    }

    // ----- 6. Structured output (JSON schema / guided decoding) --------------
    section('6. Structured output (response_format json_schema)');
    try {
        const r = await model.chat(
            [{ role: 'user', content: 'Give the capital and population (millions, integer) of France.' }],
            {
                temperature: 0,
                maxTokens: 1024,
                // Unified thinking flag — now wired through the openai provider to
                // vLLM's chat_template_kwargs.enable_thinking. Disable thinking so
                // guided decoding emits the object directly.
                thinking: false,
                jsonSchema: {
                    type: 'object',
                    properties: { capital: { type: 'string' }, population_millions: { type: 'number' } },
                    required: ['capital', 'population_millions'],
                    additionalProperties: false,
                },
                name: 'CountryFact',
            } as any,
        );
        const content = r.message.content ?? '';
        const structured = (r as any).structured;
        console.log('   content   :', JSON.stringify(content.slice(0, 200)));
        console.log('   structured:', JSON.stringify(structured));
        let parsed: any = structured;
        if (!parsed) { try { parsed = JSON.parse(content); } catch { /* ignore */ } }
        if (parsed && typeof parsed.capital === 'string' && typeof parsed.population_millions === 'number') {
            record('Structured output', 'PASS', `valid JSON: capital=${parsed.capital}`);
        } else if (parsed) {
            record('Structured output', 'PARTIAL', 'JSON parsed but schema fields missing/mistyped');
        } else {
            record('Structured output', 'FAIL', 'response was not valid JSON');
        }
    } catch (e) {
        record('Structured output', 'FAIL', (e as Error).message);
    }

    await model.dispose();
    printSummary();
}

function printSummary() {
    section('SUMMARY');
    const pad = Math.max(...results.map(r => r.name.length));
    for (const r of results) {
        const icon = r.status === 'PASS' ? '✅' : r.status === 'PARTIAL' ? '🟡' : '❌';
        console.log(`${icon} ${r.name.padEnd(pad)}  ${r.status}`);
    }
    const pass = results.filter(r => r.status === 'PASS').length;
    console.log(`\n${pass}/${results.length} PASS`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
