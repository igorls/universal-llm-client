# Deep Research (Gemini)

Google Gemini's **Deep Research** is an agentic, long-running mode: the model plans, browses,
and synthesizes a cited report over several minutes. It runs on a dedicated `interactions`
endpoint (not `generateContent`), so the client exposes it as its own methods.

> **Google AI Studio only.** `deepResearch` requires a `type: 'google'` provider and throws a
> clear error otherwise (Vertex AI is not supported).

## Run and await a report

`deepResearch()` creates a background interaction and polls until it completes (or the timeout
elapses), returning the report and intermediate steps:

```typescript
const model = new AIModel({
  model: 'gemini-3.5-flash',
  providers: [{ type: 'google', apiKey: process.env.GOOGLE_API_KEY }],
});

const result = await model.deepResearch('Research the history of Google TPUs.', {
  tools: ['google_search', 'url_context'],
  pollIntervalMs: 10_000,
  timeoutMs: 1_800_000, // 30 min ceiling
});

console.log(result.status); // 'completed' | 'failed' | 'in_progress'
console.log(result.report); // the final report (assembled from steps)
console.log(result.steps?.length);
```

## Stream intermediate progress

`deepResearchStream()` yields `thought` / `text` / `status` events as the agent works, and
returns the final `DeepResearchResult`:

```typescript
for await (const ev of model.deepResearchStream('Compare RISC-V vs ARM in 2026.')) {
  if (ev.type === 'thought') console.log('[thinking]', ev.content);
  else if (ev.type === 'text') process.stdout.write(ev.content);
  else if (ev.type === 'status') console.log('status:', ev.status);
}
```

## Options

| Option | Default | Description |
|---|---|---|
| `agent` | `'deep-research-preview-04-2026'` | Research agent id. |
| `tools` | — | Allowed tools, e.g. `['google_search', 'url_context', 'code_execution']`. |
| `thinkingSummaries` | `'auto'` | Emit intermediate reasoning (`'auto'`) or not (`'none'`). |
| `previousInteractionId` | — | Continue a prior interaction (follow-up question). |
| `pollIntervalMs` | `5000` | Poll cadence while awaiting completion. |
| `timeoutMs` | `600000` | Overall poll-loop ceiling. |
| `signal` | — | `AbortSignal` forwarded to every request. |

## Result shape

```typescript
interface DeepResearchResult {
  id: string;
  status: 'in_progress' | 'completed' | 'failed' | string;
  report?: string;          // final report (from output_text, or assembled from steps)
  steps?: DeepResearchStep[];
  error?: unknown;
  raw?: unknown;            // the raw last interaction object
}
```

## Notes

- Runs take **minutes** — keep `timeoutMs` generous, or use the streaming variant for progress.
- The interactions preview API can be flaky; `deepResearch()` retries transient errors and
  tolerates blips during polling.
- The interaction continues server-side even if you stop polling (it's a background job).
