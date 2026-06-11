/**
 * DiffusionGemma Test Harness
 * 
 * A standalone Bun server that tests universal-llm-client against
 * DiffusionGemma (a discrete diffusion language model served via vLLM).
 * 
 * This validates:
 * 1. Basic chat completion via OpenAI-compatible API
 * 2. Streaming responses (diffusion models emit token blocks, not single tokens)
 * 3. Thinking/reasoning mode
 * 4. Tool calling compatibility
 * 
 * Usage: bun run src/demos/diffusion-gemma/server.ts
 */

import { AIModel } from '../../index.js';
import { CANVAS_HTML } from './canvas.js';

const PORT = 3333;
const VLLM_URL = process.env.VLLM_URL ?? 'http://localhost:8000';
const MODEL_NAME = process.env.MODEL_NAME ?? 'RedHatAI/diffusiongemma-26B-A4B-it-NVFP4';

// ============================================================================
// Create the AIModel instance pointing at our local vLLM server
// ============================================================================

function createModel(debug = false): AIModel {
    return new AIModel({
        model: MODEL_NAME,
        timeout: 120_000, // diffusion models can take longer
        retries: 0,       // no retries for testing — we want to see raw errors
        debug,
        providers: [
            {
                type: 'openai',
                url: VLLM_URL,
                apiKey: 'not-needed', // vLLM doesn't require auth by default
            },
        ],
    });
}

// ============================================================================
// API Handlers
// ============================================================================

async function handleChat(req: Request): Promise<Response> {
    const body = await req.json() as {
        messages: Array<{ role: string; content: string }>;
        stream?: boolean;
        maxTokens?: number;
        temperature?: number;
        thinking?: boolean;
    };

    const model = createModel();

    if (body.stream) {
        // Streaming response via SSE
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    const gen = model.chatStream(body.messages as any, {
                        maxTokens: body.maxTokens ?? 512,
                        temperature: body.temperature ?? 0.7,
                    });

                    for await (const event of gen) {
                        const data = JSON.stringify(event);
                        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                    }
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                } catch (err: any) {
                    const errorData = JSON.stringify({
                        type: 'error',
                        content: err.message ?? String(err),
                    });
                    controller.enqueue(encoder.encode(`data: ${errorData}\n\n`));
                } finally {
                    controller.close();
                    await model.dispose();
                }
            },
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }

    // Non-streaming response
    try {
        const response = await model.chat(body.messages as any, {
            maxTokens: body.maxTokens ?? 512,
            temperature: body.temperature ?? 0.7,
        });
        await model.dispose();
        return Response.json(response);
    } catch (err: any) {
        await model.dispose();
        return Response.json({ error: err.message ?? String(err) }, { status: 500 });
    }
}

async function handleHealth(): Promise<Response> {
    try {
        const model = createModel();
        const models = await model.getModels();
        await model.dispose();
        return Response.json({
            status: 'ok',
            vllm: VLLM_URL,
            models,
            timestamp: new Date().toISOString(),
        });
    } catch (err: any) {
        return Response.json({
            status: 'error',
            vllm: VLLM_URL,
            error: err.message ?? String(err),
        }, { status: 503 });
    }
}

// ============================================================================
// Raw Stream Proxy — bypasses universal-llm-client for canvas visualization
// ============================================================================

async function handleStreamRaw(req: Request): Promise<Response> {
    const body = await req.json() as {
        prompt?: string;
        messages?: Array<{ role: string; content: string }>;
        maxTokens?: number;
        thinking?: boolean;
    };

    const messages = body.messages ?? [{ role: 'user', content: body.prompt ?? '' }];

    // Proxy directly to vLLM to preserve raw SSE chunk timing.
    // skip_special_tokens:false keeps the native channel markers
    // (<|channel>thought ... <channel|>) so the canvas can split
    // reasoning from the final answer deterministically.
    const vllmBody = JSON.stringify({
        model: MODEL_NAME,
        messages,
        max_tokens: body.maxTokens ?? 512,
        stream: true,
        skip_special_tokens: false,
        ...(body.thinking === false
            ? { chat_template_kwargs: { enable_thinking: false } }
            : {}),
    });

    const vllmRes = await fetch(`${VLLM_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: vllmBody,
    });

    if (!vllmRes.ok || !vllmRes.body) {
        return Response.json(
            { error: `vLLM error: ${vllmRes.status} ${vllmRes.statusText}` },
            { status: 502 },
        );
    }

    // Pass through the SSE stream unchanged
    return new Response(vllmRes.body, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        },
    });
}

// ============================================================================
// Engine Config — entropy is engine-level in vLLM (hf_overrides at init),
// so changing it requires a container restart. The start script sources
// an env file from the bind-mounted HF cache dir; we write it here and
// `docker restart` the engine. The UI polls /api/health until it returns.
// ============================================================================

const ENGINE_ENV_FILE = `${process.env.USERPROFILE ?? process.env.HOME ?? ''}/.cache/huggingface/diffusion-env.sh`;
const ENGINE_CONTAINER = process.env.ENGINE_CONTAINER ?? 'diffusiongemma';

async function readEngineEntropy(): Promise<number> {
    try {
        const text = await Bun.file(ENGINE_ENV_FILE).text();
        const m = text.match(/DIFFUSION_ENTROPY=([0-9.]+)/);
        if (m?.[1]) return parseFloat(m[1]);
    } catch { /* no env file yet — engine runs script defaults */ }
    return 0.1;
}

async function handleEngineConfig(req: Request): Promise<Response> {
    if (req.method === 'GET') {
        return Response.json({ entropy: await readEngineEntropy(), container: ENGINE_CONTAINER });
    }

    const body = await req.json() as { entropy?: number };
    const entropy = Number(body.entropy);
    if (!Number.isFinite(entropy) || entropy < 0.01 || entropy > 1) {
        return Response.json({ error: 'entropy must be in [0.01, 1]' }, { status: 400 });
    }

    await Bun.write(ENGINE_ENV_FILE, `export DIFFUSION_ENTROPY=${entropy}\n`);

    const proc = Bun.spawn(['docker', 'restart', ENGINE_CONTAINER], {
        stdout: 'pipe', stderr: 'pipe',
    });
    const code = await proc.exited;
    if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        return Response.json({ error: `docker restart failed: ${err.trim()}` }, { status: 500 });
    }

    console.log(`[engine-config] entropy=${entropy} → restarted ${ENGINE_CONTAINER}`);
    return Response.json({ ok: true, entropy, reloading: true });
}

// ============================================================================
// Static UI
// ============================================================================

function serveUI(): Response {
    return new Response(HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

function serveCanvas(): Response {
    return new Response(CANVAS_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

// ============================================================================
// Bun Server
// ============================================================================

console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🧪 DiffusionGemma Test Harness                            ║
║  ──────────────────────────────────────────────────────────  ║
║  UI:     http://localhost:${PORT}                              ║
║  vLLM:   ${VLLM_URL.padEnd(48)}  ║
║  Model:  ${MODEL_NAME.padEnd(48).slice(0, 48)}  ║
╚══════════════════════════════════════════════════════════════╝
`);

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        // CORS preflight
        if (req.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                },
            });
        }

        switch (url.pathname) {
            case '/':
                return serveUI();
            case '/canvas':
                return serveCanvas();
            case '/api/chat':
                if (req.method === 'POST') return handleChat(req);
                break;
            case '/api/stream-raw':
                if (req.method === 'POST') return handleStreamRaw(req);
                break;
            case '/api/engine-config':
                return handleEngineConfig(req);
            case '/api/health':
                return handleHealth();
        }

        return new Response('Not Found', { status: 404 });
    },
});

// ============================================================================
// Inline HTML UI
// ============================================================================

const HTML = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DiffusionGemma Test Harness</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #0a0a0f;
            --bg-secondary: #12121a;
            --bg-card: #1a1a26;
            --bg-input: #0f0f18;
            --border: #2a2a3a;
            --border-active: #6366f1;
            --text-primary: #e8e8f0;
            --text-secondary: #8888a0;
            --text-muted: #5a5a70;
            --accent: #6366f1;
            --accent-glow: rgba(99, 102, 241, 0.15);
            --accent-hover: #818cf8;
            --success: #22c55e;
            --warning: #f59e0b;
            --error: #ef4444;
            --thinking: #a78bfa;
            --thinking-bg: rgba(167, 139, 250, 0.08);
            --diffusion: #f472b6;
            --diffusion-glow: rgba(244, 114, 182, 0.12);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            overflow-x: hidden;
        }

        /* Ambient background effect */
        body::before {
            content: '';
            position: fixed;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(ellipse at 30% 20%, rgba(99, 102, 241, 0.04) 0%, transparent 60%),
                        radial-gradient(ellipse at 70% 80%, rgba(244, 114, 182, 0.03) 0%, transparent 60%);
            pointer-events: none;
            z-index: 0;
        }

        .app {
            max-width: 900px;
            margin: 0 auto;
            padding: 2rem 1.5rem;
            position: relative;
            z-index: 1;
        }

        /* Header */
        .header {
            text-align: center;
            margin-bottom: 2rem;
        }

        .header h1 {
            font-size: 1.75rem;
            font-weight: 700;
            letter-spacing: -0.02em;
            background: linear-gradient(135deg, var(--accent), var(--diffusion));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 0.25rem;
        }

        .header .subtitle {
            font-size: 0.85rem;
            color: var(--text-muted);
            font-weight: 400;
        }

        .header .model-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            margin-top: 0.75rem;
            padding: 0.35rem 0.75rem;
            background: var(--diffusion-glow);
            border: 1px solid rgba(244, 114, 182, 0.2);
            border-radius: 100px;
            font-size: 0.75rem;
            font-family: 'JetBrains Mono', monospace;
            color: var(--diffusion);
        }

        .model-badge .dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--diffusion);
            animation: pulse-dot 2s ease-in-out infinite;
        }

        @keyframes pulse-dot {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }

        /* Status bar */
        .status-bar {
            display: flex;
            gap: 0.75rem;
            justify-content: center;
            margin-bottom: 2rem;
            flex-wrap: wrap;
        }

        .status-pill {
            display: flex;
            align-items: center;
            gap: 0.35rem;
            padding: 0.3rem 0.65rem;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 6px;
            font-size: 0.72rem;
            color: var(--text-secondary);
            font-family: 'JetBrains Mono', monospace;
        }

        .status-pill .indicator {
            width: 5px;
            height: 5px;
            border-radius: 50%;
        }

        .status-pill .indicator.online { background: var(--success); box-shadow: 0 0 4px var(--success); }
        .status-pill .indicator.offline { background: var(--error); }
        .status-pill .indicator.checking { background: var(--warning); animation: pulse-dot 1s ease-in-out infinite; }

        /* Chat area */
        .chat-container {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 12px;
            overflow: hidden;
            margin-bottom: 1rem;
        }

        .messages {
            min-height: 300px;
            max-height: 500px;
            overflow-y: auto;
            padding: 1.25rem;
            scroll-behavior: smooth;
        }

        .messages::-webkit-scrollbar { width: 4px; }
        .messages::-webkit-scrollbar-track { background: transparent; }
        .messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

        .message {
            margin-bottom: 1rem;
            animation: msg-in 0.3s ease-out;
        }

        @keyframes msg-in {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .message .role {
            font-size: 0.7rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            margin-bottom: 0.3rem;
        }

        .message.user .role { color: var(--accent); }
        .message.assistant .role { color: var(--diffusion); }
        .message.system .role { color: var(--warning); }

        .message .content {
            font-size: 0.9rem;
            line-height: 1.65;
            color: var(--text-primary);
            white-space: pre-wrap;
            word-break: break-word;
        }

        .message.user .content {
            background: var(--accent-glow);
            border: 1px solid rgba(99, 102, 241, 0.15);
            padding: 0.75rem 1rem;
            border-radius: 10px;
        }

        .message.assistant .content {
            padding: 0.75rem 0;
        }

        .thinking-block {
            background: var(--thinking-bg);
            border-left: 2px solid var(--thinking);
            padding: 0.6rem 0.8rem;
            margin-bottom: 0.5rem;
            border-radius: 0 6px 6px 0;
            font-size: 0.82rem;
            color: var(--thinking);
            opacity: 0.85;
        }

        .thinking-block .label {
            font-size: 0.65rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            margin-bottom: 0.25rem;
            opacity: 0.7;
        }

        /* Metrics bar */
        .metrics {
            display: flex;
            gap: 1rem;
            padding: 0.5rem 0;
            margin-top: 0.5rem;
            border-top: 1px solid var(--border);
            flex-wrap: wrap;
        }

        .metric {
            font-size: 0.7rem;
            font-family: 'JetBrains Mono', monospace;
            color: var(--text-muted);
        }

        .metric span { color: var(--text-secondary); }

        /* Input area */
        .input-area {
            display: flex;
            gap: 0.5rem;
            padding: 1rem 1.25rem;
            border-top: 1px solid var(--border);
            background: var(--bg-card);
        }

        .input-area textarea {
            flex: 1;
            background: var(--bg-input);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 0.65rem 0.85rem;
            color: var(--text-primary);
            font-family: 'Inter', sans-serif;
            font-size: 0.875rem;
            resize: none;
            min-height: 42px;
            max-height: 120px;
            outline: none;
            transition: border-color 0.2s;
        }

        .input-area textarea:focus {
            border-color: var(--accent);
            box-shadow: 0 0 0 2px var(--accent-glow);
        }

        .input-area textarea::placeholder { color: var(--text-muted); }

        .send-btn {
            align-self: flex-end;
            padding: 0.65rem 1.2rem;
            background: linear-gradient(135deg, var(--accent), #8b5cf6);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 0.8rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            white-space: nowrap;
        }

        .send-btn:hover:not(:disabled) {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
        }

        .send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        /* Controls */
        .controls {
            display: flex;
            gap: 0.75rem;
            align-items: center;
            flex-wrap: wrap;
            margin-bottom: 1rem;
        }

        .control-group {
            display: flex;
            align-items: center;
            gap: 0.35rem;
        }

        .control-group label {
            font-size: 0.72rem;
            color: var(--text-muted);
            font-weight: 500;
        }

        .control-group input[type="number"],
        .control-group select {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 5px;
            padding: 0.3rem 0.5rem;
            color: var(--text-primary);
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.72rem;
            width: 70px;
            outline: none;
        }

        .control-group input[type="checkbox"] {
            accent-color: var(--accent);
        }

        .preset-btn {
            padding: 0.3rem 0.6rem;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 5px;
            color: var(--text-secondary);
            font-size: 0.7rem;
            cursor: pointer;
            transition: all 0.2s;
        }

        .preset-btn:hover {
            border-color: var(--accent);
            color: var(--accent);
        }

        /* Empty state */
        .empty-state {
            text-align: center;
            padding: 3rem 1rem;
            color: var(--text-muted);
        }

        .empty-state .icon {
            font-size: 2.5rem;
            margin-bottom: 0.75rem;
            opacity: 0.5;
        }

        .empty-state p {
            font-size: 0.85rem;
            max-width: 360px;
            margin: 0 auto;
            line-height: 1.5;
        }

        /* Streaming cursor */
        .streaming-cursor::after {
            content: '▊';
            animation: blink 0.8s step-end infinite;
            color: var(--diffusion);
        }

        @keyframes blink {
            50% { opacity: 0; }
        }

        /* Test results panel */
        .test-panel {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.25rem;
            margin-top: 1rem;
        }

        .test-panel h3 {
            font-size: 0.85rem;
            font-weight: 600;
            margin-bottom: 0.75rem;
            color: var(--text-secondary);
        }

        .test-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.5rem 0;
            border-bottom: 1px solid rgba(255,255,255,0.04);
            font-size: 0.8rem;
        }

        .test-row:last-child { border-bottom: none; }

        .test-row .test-name { color: var(--text-secondary); }

        .test-row .test-result {
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.72rem;
            padding: 0.15rem 0.5rem;
            border-radius: 4px;
        }

        .test-result.pass { background: rgba(34,197,94,0.1); color: var(--success); }
        .test-result.fail { background: rgba(239,68,68,0.1); color: var(--error); }
        .test-result.running { background: rgba(245,158,11,0.1); color: var(--warning); animation: pulse-dot 1s ease-in-out infinite; }
        .test-result.pending { color: var(--text-muted); }
    </style>
</head>
<body>
    <div class="app">
        <div class="header">
            <h1>🧪 DiffusionGemma Test Harness</h1>
            <p class="subtitle">Testing universal-llm-client against a discrete diffusion language model</p>
            <div class="model-badge">
                <span class="dot"></span>
                <span id="model-name">connecting...</span>
            </div>
        </div>

        <div class="status-bar">
            <div class="status-pill">
                <span class="indicator checking" id="vllm-status"></span>
                <span>vLLM</span>
                <span id="vllm-url">localhost:8000</span>
            </div>
            <div class="status-pill">
                <span class="indicator checking" id="client-status"></span>
                <span>universal-llm-client</span>
                <span>openai compat</span>
            </div>
        </div>

        <div class="controls">
            <div class="control-group">
                <label>Max Tokens</label>
                <input type="number" id="max-tokens" value="512" min="1" max="8192">
            </div>
            <div class="control-group">
                <label>Temperature</label>
                <input type="number" id="temperature" value="0.7" min="0" max="2" step="0.1">
            </div>
            <div class="control-group">
                <label>Stream</label>
                <input type="checkbox" id="stream-toggle" checked>
            </div>
            <div style="flex:1"></div>
            <button class="preset-btn" onclick="sendPreset('poem')">🎭 Poem</button>
            <button class="preset-btn" onclick="sendPreset('code')">💻 Code</button>
            <button class="preset-btn" onclick="sendPreset('reason')">🧠 Reason</button>
            <button class="preset-btn" onclick="sendPreset('speed')">⚡ Speed</button>
            <button class="preset-btn" onclick="runAllTests()">🧪 Run Tests</button>
        </div>

        <div class="chat-container">
            <div class="messages" id="messages">
                <div class="empty-state">
                    <div class="icon">🔮</div>
                    <p>DiffusionGemma generates text via <strong>parallel block diffusion</strong> — 
                    256 tokens at a time through iterative denoising. 
                    Type a message to test it.</p>
                </div>
            </div>
            <div class="input-area">
                <textarea id="input" placeholder="Type a message..." rows="1"
                    onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage()}"></textarea>
                <button class="send-btn" id="send-btn" onclick="sendMessage()">Send</button>
            </div>
        </div>

        <div class="test-panel" id="test-panel" style="display:none">
            <h3>🧪 Compatibility Test Results</h3>
            <div id="test-results"></div>
        </div>
    </div>

    <script>
        const messagesEl = document.getElementById('messages');
        const inputEl = document.getElementById('input');
        const sendBtn = document.getElementById('send-btn');
        let conversationHistory = [];
        let isStreaming = false;

        // Auto-resize textarea
        inputEl.addEventListener('input', () => {
            inputEl.style.height = 'auto';
            inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
        });

        // Health check on load
        async function checkHealth() {
            try {
                const res = await fetch('/api/health');
                const data = await res.json();
                if (data.status === 'ok') {
                    document.getElementById('vllm-status').className = 'indicator online';
                    document.getElementById('client-status').className = 'indicator online';
                    document.getElementById('model-name').textContent = data.models?.[0] ?? 'unknown';
                } else {
                    document.getElementById('vllm-status').className = 'indicator offline';
                    document.getElementById('client-status').className = 'indicator offline';
                    document.getElementById('model-name').textContent = 'offline';
                }
            } catch {
                document.getElementById('vllm-status').className = 'indicator offline';
                document.getElementById('client-status').className = 'indicator offline';
                document.getElementById('model-name').textContent = 'connection failed';
            }
        }
        checkHealth();

        function clearEmptyState() {
            const empty = messagesEl.querySelector('.empty-state');
            if (empty) empty.remove();
        }

        function addMessage(role, content, metrics) {
            clearEmptyState();
            const div = document.createElement('div');
            div.className = 'message ' + role;
            
            let thinkingHtml = '';
            let cleanContent = content;
            
            // Parse thinking content
            if (role === 'assistant' && content) {
                const thinkMatch = content.match(/^thought\\n(.*?)(?=\\n\\n[A-Z"]|$)/s);
                if (thinkMatch) {
                    thinkingHtml = '<div class="thinking-block"><div class="label">💭 Thinking</div>' + 
                        escapeHtml(thinkMatch[1]) + '</div>';
                    cleanContent = content.slice(thinkMatch[0].length).trim();
                }
            }

            let metricsHtml = '';
            if (metrics) {
                metricsHtml = '<div class="metrics">';
                if (metrics.promptTokens) metricsHtml += '<div class="metric">prompt: <span>' + metrics.promptTokens + '</span></div>';
                if (metrics.completionTokens) metricsHtml += '<div class="metric">completion: <span>' + metrics.completionTokens + '</span></div>';
                if (metrics.duration) metricsHtml += '<div class="metric">time: <span>' + metrics.duration + 'ms</span></div>';
                if (metrics.tokensPerSec) metricsHtml += '<div class="metric">speed: <span>' + metrics.tokensPerSec + ' t/s</span></div>';
                metricsHtml += '</div>';
            }

            div.innerHTML = '<div class="role">' + role + '</div>' + thinkingHtml +
                '<div class="content">' + escapeHtml(cleanContent || '') + '</div>' + metricsHtml;
            
            messagesEl.appendChild(div);
            messagesEl.scrollTop = messagesEl.scrollHeight;
            return div;
        }

        function escapeHtml(text) {
            const d = document.createElement('div');
            d.textContent = text;
            return d.innerHTML;
        }

        async function sendMessage(overrideText) {
            const text = overrideText || inputEl.value.trim();
            if (!text || isStreaming) return;

            inputEl.value = '';
            inputEl.style.height = 'auto';
            isStreaming = true;
            sendBtn.disabled = true;
            sendBtn.textContent = '...';

            addMessage('user', text);
            conversationHistory.push({ role: 'user', content: text });

            const maxTokens = parseInt(document.getElementById('max-tokens').value) || 512;
            const temperature = parseFloat(document.getElementById('temperature').value) || 0.7;
            const useStream = document.getElementById('stream-toggle').checked;
            const startTime = Date.now();

            if (useStream) {
                // Streaming
                const assistantDiv = addMessage('assistant', '');
                const contentEl = assistantDiv.querySelector('.content');
                contentEl.classList.add('streaming-cursor');
                let fullContent = '';

                try {
                    const res = await fetch('/api/chat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            messages: conversationHistory,
                            stream: true,
                            maxTokens,
                            temperature,
                        }),
                    });

                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\\n');
                        buffer = lines.pop();

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const data = line.slice(6);
                                if (data === '[DONE]') continue;
                                try {
                                    const event = JSON.parse(data);
                                    if (event.type === 'text') {
                                        fullContent += event.content;
                                        contentEl.textContent = fullContent;
                                    } else if (event.type === 'thinking') {
                                        fullContent += event.content;
                                        contentEl.textContent = fullContent;
                                    } else if (event.type === 'error') {
                                        contentEl.textContent = '❌ ' + event.content;
                                    }
                                } catch {}
                            }
                        }
                        messagesEl.scrollTop = messagesEl.scrollHeight;
                    }
                } catch (err) {
                    contentEl.textContent = '❌ Stream error: ' + err.message;
                }

                contentEl.classList.remove('streaming-cursor');
                const elapsed = Date.now() - startTime;
                const words = fullContent.split(/\\s+/).length;
                
                // Add metrics
                const metricsDiv = document.createElement('div');
                metricsDiv.className = 'metrics';
                metricsDiv.innerHTML = 
                    '<div class="metric">time: <span>' + elapsed + 'ms</span></div>' +
                    '<div class="metric">chars: <span>' + fullContent.length + '</span></div>';
                assistantDiv.appendChild(metricsDiv);

                conversationHistory.push({ role: 'assistant', content: fullContent });

            } else {
                // Non-streaming
                try {
                    const res = await fetch('/api/chat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            messages: conversationHistory,
                            stream: false,
                            maxTokens,
                            temperature,
                        }),
                    });

                    const data = await res.json();
                    const elapsed = Date.now() - startTime;

                    if (data.error) {
                        addMessage('assistant', '❌ ' + data.error);
                    } else {
                        const tokens = data.usage;
                        addMessage('assistant', data.content || '(empty response)', {
                            promptTokens: tokens?.promptTokens,
                            completionTokens: tokens?.completionTokens,
                            duration: elapsed,
                            tokensPerSec: tokens?.completionTokens ? 
                                Math.round(tokens.completionTokens / (elapsed / 1000)) : undefined,
                        });
                        conversationHistory.push({ role: 'assistant', content: data.content });
                    }
                } catch (err) {
                    addMessage('assistant', '❌ Request error: ' + err.message);
                }
            }

            isStreaming = false;
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send';
            inputEl.focus();
        }

        // Preset prompts
        const PRESETS = {
            poem: 'Write a short haiku about quantum computing.',
            code: 'Write a TypeScript function that reverses a linked list. Include types.',
            reason: 'What is 47 * 23? Show your step-by-step reasoning.',
            speed: 'Hi',
        };

        function sendPreset(name) {
            sendMessage(PRESETS[name]);
        }

        // === Automated Tests ===
        async function runAllTests() {
            const panel = document.getElementById('test-panel');
            const results = document.getElementById('test-results');
            panel.style.display = 'block';
            
            const tests = [
                { name: 'Health Check (GET /v1/models)', fn: testHealth },
                { name: 'Basic Chat (non-streaming)', fn: testBasicChat },
                { name: 'Streaming Chat', fn: testStreamingChat },
                { name: 'Multi-turn Conversation', fn: testMultiTurn },
                { name: 'Empty Response Handling', fn: testEmptyResponse },
                { name: 'Long Output (1024 tokens)', fn: testLongOutput },
            ];

            results.innerHTML = tests.map(t => 
                '<div class="test-row"><span class="test-name">' + t.name + '</span>' +
                '<span class="test-result pending" id="test-' + t.name.replace(/[^a-z]/gi, '') + '">pending</span></div>'
            ).join('');

            for (const test of tests) {
                const id = 'test-' + test.name.replace(/[^a-z]/gi, '');
                const el = document.getElementById(id);
                el.className = 'test-result running';
                el.textContent = 'running...';

                try {
                    const result = await test.fn();
                    el.className = 'test-result pass';
                    el.textContent = '✓ ' + result;
                } catch (err) {
                    el.className = 'test-result fail';
                    el.textContent = '✗ ' + err.message;
                }
            }
        }

        async function testHealth() {
            const res = await fetch('/api/health');
            const data = await res.json();
            if (data.status !== 'ok') throw new Error('unhealthy');
            return data.models[0]?.slice(0, 30) + '...';
        }

        async function testBasicChat() {
            const start = Date.now();
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: 'Say the word hello' }],
                    maxTokens: 64,
                    stream: false,
                }),
            });
            const data = await res.json();
            const elapsed = Date.now() - start;
            if (data.error) throw new Error(data.error);
            if (!data.content && data.content !== '') throw new Error('no content');
            return elapsed + 'ms, ' + (data.content?.length ?? 0) + ' chars';
        }

        async function testStreamingChat() {
            const start = Date.now();
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: 'Count from 1 to 5' }],
                    maxTokens: 128,
                    stream: true,
                }),
            });
            const text = await res.text();
            const elapsed = Date.now() - start;
            const events = text.split('\\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]');
            return elapsed + 'ms, ' + events.length + ' events';
        }

        async function testMultiTurn() {
            const start = Date.now();
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'user', content: 'My name is Igor.' },
                        { role: 'assistant', content: 'Hello Igor!' },
                        { role: 'user', content: 'What is my name?' },
                    ],
                    maxTokens: 64,
                    stream: false,
                }),
            });
            const data = await res.json();
            const elapsed = Date.now() - start;
            if (data.error) throw new Error(data.error);
            const hasName = (data.content || '').toLowerCase().includes('igor');
            return elapsed + 'ms, name recalled: ' + hasName;
        }

        async function testEmptyResponse() {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: 'Respond with just OK' }],
                    maxTokens: 16,
                    stream: false,
                }),
            });
            const data = await res.json();
            return (data.content?.length ?? 0) + ' chars';
        }

        async function testLongOutput() {
            const start = Date.now();
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: 'Write a detailed essay about the history of computing. Be thorough.' }],
                    maxTokens: 1024,
                    stream: false,
                }),
            });
            const data = await res.json();
            const elapsed = Date.now() - start;
            if (data.error) throw new Error(data.error);
            const tokens = data.usage?.completionTokens ?? '?';
            return elapsed + 'ms, ' + tokens + ' tokens';
        }
    </script>
</body>
</html>`;
