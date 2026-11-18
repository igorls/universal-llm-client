import { expect, test } from 'bun:test';
import { AIModelApiType, type LLMChatMessage } from '../../interfaces.js';
import { ResponsesClient } from '../../providers/openai-responses.js';

const input: LLMChatMessage[] = [{ role: 'user', content: 'Hello' }];

test('streams Responses on an authenticated socket and reuses it only for matching credentials', async () => {
    const upgrades: Array<{ path: string; authorization: string | null }> = [];
    const requests: Array<Record<string, unknown>> = [];
    let token = 'fixture-first';
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(req, server) {
            upgrades.push({ path: new URL(req.url).pathname, authorization: req.headers.get('authorization') });
            if (!server.upgrade(req)) return new Response('Expected upgrade', { status: 400 });
        },
        websocket: {
            message(ws, raw) {
                const request = JSON.parse(String(raw));
                requests.push(request);
                ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello' }));
                ws.send(JSON.stringify({ type: 'response.refusal.delta', delta: '!' }));
                ws.send(JSON.stringify({
                    type: 'response.completed',
                    response: { service_tier: request.service_tier === 'fast' ? 'priority' : request.service_tier },
                }));
            },
        },
    });
    const client = new ResponsesClient({
        model: 'gpt-6.2-sol', url: new URL('/v1', server.url).href, apiType: AIModelApiType.OpenAI,
        authResolver: async () => ({ accessToken: token }), transport: 'websocket', serviceTier: 'ultrafast',
    });
    try {
        const first = await client.chat(input);
        const second = await client.chat(input, { serviceTier: 'fast' });
        expect(first.message.content).toBe('Hello!');
        expect(first.serviceTier).toBe('ultrafast');
        expect(second.serviceTier).toBe('priority');
        expect(requests[0]).toMatchObject({ type: 'response.create', model: 'gpt-6.2-sol', service_tier: 'ultrafast', store: false });
        expect(requests[0]).not.toHaveProperty('stream');
        expect(requests[0]).not.toHaveProperty('background');
        expect(requests[1]?.service_tier).toBe('fast');
        expect(upgrades).toEqual([{ path: '/v1/responses', authorization: 'Bearer fixture-first' }]);

        token = 'fixture-refresh';
        await client.chat(input);
        expect(upgrades[1]).toEqual({ path: '/v1/responses', authorization: 'Bearer fixture-refresh' });
    } finally {
        client.close();
        await server.stop(true);
    }
});

test('errors on premature close and aborts an active request without replaying it', async () => {
    const abort = new AbortController();
    let requests = 0;
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(req, server) {
            if (!server.upgrade(req)) return new Response('Expected upgrade', { status: 400 });
        },
        websocket: {
            message(ws) {
                if (++requests === 1) ws.close();
                else abort.abort(new Error('fixture abort'));
            },
        },
    });
    const client = new ResponsesClient({
        model: 'gpt-6.2-sol', url: server.url.href, apiType: AIModelApiType.OpenAI,
        apiKey: 'fixture-key', transport: 'websocket',
    });
    try {
        await expect(client.chat(input)).rejects.toThrow('closed before the response finished');
        await expect(client.chat(input, { signal: abort.signal })).rejects.toThrow('fixture abort');
        expect(requests).toBe(2);
    } finally {
        client.close();
        await server.stop(true);
    }
});
