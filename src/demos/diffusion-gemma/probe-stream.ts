/**
 * Probe the raw vLLM SSE stream to understand chunk arrival patterns.
 * Logs: chunk index, ms since start, gap since last chunk, content length, field, preview.
 */

const res = await fetch('http://localhost:3333/api/stream-raw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        prompt: 'Write a short poem about the stars at night.',
        maxTokens: 512,
    }),
});

if (!res.ok || !res.body) {
    console.error('HTTP', res.status, res.statusText);
    process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
const t0 = performance.now();
let last = t0;
let i = 0;
let total = 0;

while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        let chunk: any;
        try { chunk = JSON.parse(line.slice(6)); } catch { continue; }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        const field = delta.reasoning_content != null ? 'reasoning' : delta.content != null ? 'content' : '?';
        const text: string = delta.reasoning_content ?? delta.content ?? '';
        const now = performance.now();
        total += text.length;
        const extraKeys = Object.keys(delta).filter(k => !['content', 'reasoning_content', 'role', 'tool_calls'].includes(k));
        console.log(
            `#${String(i++).padStart(3)}  t=${(now - t0).toFixed(0).padStart(6)}ms  gap=${(now - last).toFixed(1).padStart(7)}ms  len=${String(text.length).padStart(4)}  ${field.padEnd(9)}  ${JSON.stringify(text.slice(0, 60))}${extraKeys.length ? '  extra=' + JSON.stringify(extraKeys) : ''}`,
        );
        last = now;
    }
}
console.log(`\nTotal: ${i} chunks, ${total} chars, ${(performance.now() - t0).toFixed(0)}ms`);
