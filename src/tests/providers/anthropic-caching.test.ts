import { afterEach, expect, test } from 'bun:test';
import { AnthropicClient } from '../../providers/anthropic';
import { AIModelApiType } from '../../interfaces';

const savedFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = savedFetch;
});
const rawUsage = {
    input_tokens: 50,
    cache_read_input_tokens: 6000,
    cache_creation_input_tokens: 1000,
    output_tokens: 2,
};
const response = {
    id: 'fixture-message',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: rawUsage,
};
const client = () =>
    new AnthropicClient({ apiType: AIModelApiType.Anthropic, apiKey: 'fixture-key', model: 'claude-haiku-4-5' });

test('checkpoints recent assistant history before volatile per-turn context within the four-slot limit', async () => {
    let request: any;
    globalThis.fetch = (async (_url, init) => {
        request = JSON.parse(String(init?.body));
        return Response.json(response);
    }) as typeof fetch;
    await client().chat(
        [
            { role: 'system', content: 'Stable soul' },
            { role: 'user', content: 'Old fixture' },
            { role: 'assistant', content: 'Old reply' },
            { role: 'user', content: 'Stable fixture' },
            { role: 'assistant', content: 'Stable reply' },
            { role: 'user', content: 'Recent fixture' },
            { role: 'assistant', content: 'Recent reply' },
            { role: 'user', content: 'Ephemeral clock and task state' },
            { role: 'user', content: 'Current request' },
        ],
        { enablePromptCaching: true },
    );
    const checkpoints = request.messages
        .filter((message: any) => message.role === 'assistant')
        .map((message: any) => message.content.at(-1).cache_control);
    expect(checkpoints).toEqual([undefined, { type: 'ephemeral' }, { type: 'ephemeral' }]);
    expect(request.messages.at(-1).content.every((block: any) => !block.cache_control)).toBe(true);
    expect(request.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(request.cache_control).toEqual({ type: 'ephemeral' });
});

test('counts all Anthropic input and preserves cache reads/writes for non-streaming calls', async () => {
    globalThis.fetch = (async () => Response.json(response)) as typeof fetch;
    const result = await client().chat([{ role: 'user', content: 'ok' }]);
    expect(result.usage).toMatchObject({
        inputTokens: 7050,
        outputTokens: 2,
        totalTokens: 7052,
        cachedTokens: 6000,
        cacheWriteTokens: 1000,
    });
});

test('streamed cumulative usage and the third-argument call options survive the runtime contract', async () => {
    let request: any;
    const frames = [
        { type: 'message_start', message: response },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { ...rawUsage, output_tokens: 5 } },
        { type: 'message_stop' },
    ];
    globalThis.fetch = (async (_url, init) => {
        request = JSON.parse(String(init?.body));
        return new Response(frames.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
            headers: { 'content-type': 'text/event-stream' },
        });
    }) as typeof fetch;
    const stream = (client().chatStream as any)(
        [
            { role: 'system', content: 'stable policy' },
            { role: 'user', content: 'ok' },
        ],
        undefined,
        { enablePromptCaching: true, maxTokens: 32 },
    );
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    expect(request.max_tokens).toBe(32);
    expect(request.cache_control).toEqual({ type: 'ephemeral' });
    expect(next.value.usage).toMatchObject({
        inputTokens: 7050,
        outputTokens: 5,
        totalTokens: 7055,
        cachedTokens: 6000,
        cacheWriteTokens: 1000,
    });
});

test('tool results use the Anthropic wire identifier and opt-out remains available', async () => {
    let request: any;
    globalThis.fetch = (async (_url, init) => {
        request = JSON.parse(String(init?.body));
        return Response.json(response);
    }) as typeof fetch;
    await client().chat(
        [
            { role: 'user', content: 'probe' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'probe', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'fixture-call', content: 'result' },
        ],
        { enablePromptCaching: false },
    );
    expect(request.cache_control).toBeUndefined();
    expect(request.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'fixture-call' });
    expect(request.messages.at(-1).content[0]).not.toHaveProperty('tool_call_id');
});
