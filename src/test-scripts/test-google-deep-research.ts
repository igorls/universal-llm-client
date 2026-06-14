/**
 * Live smoke test for the Gemini Deep Research surface. Reads GOOGLE_API_KEY
 * from the environment. This CREATES a background research interaction and
 * polls a few times to verify the create+poll plumbing — it does NOT wait for
 * full completion (deep research runs for minutes).
 *
 *   $env:GOOGLE_API_KEY="..."; bun run src/test-scripts/test-google-deep-research.ts
 */
import { AIModel } from '../index.js';

const KEY = process.env.GOOGLE_API_KEY;
if (!KEY) { console.error('Set GOOGLE_API_KEY'); process.exit(1); }

(async () => {
    const model = new AIModel({ model: 'gemini-3.5-flash', providers: [{ type: 'google', apiKey: KEY }] });

    console.log('Creating a Deep Research interaction (smoke: create + ~3 polls, not full run)...\n');
    const r = await model.deepResearch('Give a brief overview of the history of Google TPUs.', {
        pollIntervalMs: 5000,
        timeoutMs: 17000, // ~3 polls then return whatever state (likely in_progress)
    });

    console.log('id          :', r.id || '(none)');
    console.log('status      :', r.status);
    console.log('report chars:', (r.report ?? '').length);
    console.log('steps       :', Array.isArray(r.steps) ? r.steps.length : 0);
    if (r.error) console.log('error       :', JSON.stringify(r.error).slice(0, 400));

    const ok = !!r.id && ['in_progress', 'completed'].includes(r.status);
    console.log(ok
        ? '\n✅ Deep Research create + poll plumbing works (interaction id + status returned).'
        : '\n🟡 Check output above (API may require allow-listing the agent on this key/tier).');
})().catch(e => { console.error('ERROR', (e as Error)?.message ?? e); process.exit(1); });
