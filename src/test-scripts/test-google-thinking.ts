/**
 * Live check: unified `thinking` levels + reasoning-text surfacing against the
 * real Gemini API. Reads GOOGLE_API_KEY from the environment (never hard-code).
 *
 *   $env:GOOGLE_API_KEY="..."; bun run src/test-scripts/test-google-thinking.ts
 */
import { AIModel } from '../index.js';
import type { ThinkingLevel } from '../index.js';

const KEY = process.env.GOOGLE_API_KEY;
const MODEL = process.env.GOOGLE_MODEL ?? 'gemini-3.5-flash';
if (!KEY) { console.error('Set GOOGLE_API_KEY'); process.exit(1); }

const PROMPT = 'A farmer has 17 sheep. All but 9 run away. Then he buys 5 more. How many sheep? Give the number.';

async function run(thinking: boolean | ThinkingLevel) {
    const model = new AIModel({ model: MODEL, providers: [{ type: 'google', apiKey: KEY }] });
    const r = await model.chat([{ role: 'user', content: PROMPT }], { thinking, maxTokens: 2048 });
    return {
        content: (r.message.content ?? '').replace(/\n/g, ' ').trim().slice(0, 55),
        reasoningChars: (r.reasoning ?? '').length,
        reasoningTokens: r.usage?.reasoningTokens ?? 0,
        tps: r.usage?.tokensPerSecond,
    };
}

(async () => {
    console.log(`Live Gemini thinking-levels test — model=${MODEL}\n`);
    const settings: Array<boolean | ThinkingLevel> = ['high', 'medium', 'low', 'minimal', false];
    let anyText = false;
    for (const t of settings) {
        try {
            const x = await run(t);
            if (x.reasoningChars > 0) anyText = true;
            console.log(
                `thinking=${String(t).padEnd(8)} -> reasoning ${String(x.reasoningChars).padStart(5)} chars` +
                `, reasoningTokens ${String(x.reasoningTokens).padStart(4)}, content: ${JSON.stringify(x.content)}`,
            );
        } catch (e) {
            console.log(`thinking=${String(t).padEnd(8)} -> ERROR ${(e as Error)?.message ?? e}`);
        }
    }
    console.log(anyText
        ? '\n✅ Reasoning TEXT surfaced via response.reasoning (Part B) + levels mapped (Part A).'
        : '\n🟡 No reasoning text surfaced — check includeThoughts/thinkingLevel mapping.');
})().catch(e => { console.error('FATAL', (e as Error)?.message ?? e); process.exit(1); });
