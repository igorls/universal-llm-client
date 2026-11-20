import { LLMProviderError } from '../errors.js';

/** A WebSocket implementation that forwards authentication headers during upgrade. */
export type ResponsesWebSocketFactory = (url: string, headers: Readonly<Record<string, string>>) => WebSocket;

function openSocket(url: string, headers: Readonly<Record<string, string>>): WebSocket {
    const RuntimeWebSocket = globalThis.WebSocket as unknown as new (
        url: string,
        options: { headers: Readonly<Record<string, string>> },
    ) => WebSocket;
    if (typeof process === 'undefined' || (!process.versions.bun && !process.versions.node) || !RuntimeWebSocket) {
        throw new LLMProviderError('openai-responses', 'WebSocket mode requires a server-side WebSocket with header support');
    }
    return new RuntimeWebSocket(url, { headers });
}

/** Reuse one idle connection. Concurrent calls lease separate sockets. */
export class ResponsesWebSocketTransport {
    private idle?: { socket: WebSocket; key: string; openedAt: number; timer: ReturnType<typeof setTimeout> };

    constructor(private readonly connect: ResponsesWebSocketFactory = openSocket) {}

    close(): void {
        if (!this.idle) return;
        clearTimeout(this.idle.timer);
        this.idle.socket.close();
        this.idle = undefined;
    }

    async *stream(
        httpUrl: string,
        headers: Record<string, string>,
        body: Record<string, unknown>,
        timeout: number,
        signal?: AbortSignal,
    ): AsyncGenerator<{ data: string; event?: string }> {
        signal?.throwIfAborted();
        const url = new URL(httpUrl);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            throw new LLMProviderError('openai-responses', 'Responses WebSocket mode requires an HTTP or HTTPS base URL');
        }
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const key = JSON.stringify([url.href, headers]);
        let socket: WebSocket;
        let openedAt = Date.now();
        // Leave headroom for a long response before the server's one-hour connection limit.
        if (this.idle?.key === key && this.idle.socket.readyState === 1 && openedAt - this.idle.openedAt < 55 * 60_000) {
            socket = this.idle.socket;
            openedAt = this.idle.openedAt;
            clearTimeout(this.idle.timer);
            this.idle = undefined;
        } else {
            this.close();
            socket = this.connect(url.href, headers);
        }

        const { stream: _stream, background: _background, ...request } = body;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let finished = false;
        let reusable = false;
        let frames!: ReadableStreamDefaultController<string>;
        const queue = new ReadableStream<string>({
            start(controller) { frames = controller; },
        });
        const fail = (error: unknown): void => {
            if (finished) return;
            finished = true;
            frames.error(error);
        };
        const resetTimer = (): void => {
            clearTimeout(timer);
            timer = setTimeout(() => fail(new LLMProviderError('openai-responses', 'WebSocket response timed out')), timeout);
        };
        const send = (): void => {
            try {
                socket.send(JSON.stringify({ ...request, type: 'response.create' }));
            } catch (error) {
                fail(error);
            }
        };
        const onMessage = (event: MessageEvent): void => {
            if (finished) return;
            resetTimer();
            try {
                if (typeof event.data !== 'string') throw new Error('Expected a text frame');
                const frame = JSON.parse(event.data) as { type?: string } | null;
                if (typeof frame?.type !== 'string') throw new Error('Missing Responses event type');
                frames.enqueue(event.data);
                reusable = frame.type === 'response.completed' || frame.type === 'response.incomplete';
                if (reusable || frame.type === 'error' || frame.type === 'response.failed' || frame.type === 'response.cancelled') {
                    finished = true;
                    frames.close();
                }
            } catch {
                fail(new LLMProviderError('openai-responses', 'Invalid Responses WebSocket event'));
            }
        };
        const onClose = (): void => fail(new LLMProviderError('openai-responses', 'WebSocket closed before the response finished'));
        const onError = (): void => fail(new LLMProviderError('openai-responses', 'Responses WebSocket connection failed'));
        const onAbort = (): void => fail(signal?.reason);

        socket.addEventListener('open', send, { once: true });
        socket.addEventListener('message', onMessage);
        socket.addEventListener('close', onClose);
        socket.addEventListener('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
        const reader = queue.getReader();
        try {
            resetTimer();
            if (signal?.aborted) onAbort();
            else if (socket.readyState === 1) send();
            else if (socket.readyState !== 0) onClose();
            for (;;) {
                signal?.throwIfAborted();
                const { done, value } = await reader.read();
                if (done) break;
                yield { data: value };
            }
        } finally {
            clearTimeout(timer);
            reader.releaseLock();
            socket.removeEventListener('open', send);
            socket.removeEventListener('message', onMessage);
            socket.removeEventListener('close', onClose);
            socket.removeEventListener('error', onError);
            signal?.removeEventListener('abort', onAbort);
            if (reusable && !signal?.aborted && socket.readyState === 1 && !this.idle) {
                const idleTimer = setTimeout(() => this.close(), 30_000);
                idleTimer.unref?.();
                this.idle = { socket, key, openedAt, timer: idleTimer };
            } else {
                socket.close();
            }
        }
    }
}
