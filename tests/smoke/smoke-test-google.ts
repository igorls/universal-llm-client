/**
 * Smoke Test — Google AI Studio Integration
 *
 * Tests the Google provider against real Gemini API.
 * Requires GOOGLE_API_KEY in .env
 *
 * Run: bun run smoke-test-google.ts
 */

import { AIModel, AIModelApiType, ConsoleAuditor, createTimeTool } from './src/index.js';

const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_KEY) {
    console.error('❌ GOOGLE_API_KEY not set in .env');
    process.exit(1);
}

const MODEL = 'gemini-3.1-flash-lite-preview';

const passed: string[] = [];
const failed: string[] = [];

function log(label: string, msg: string) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${label}`);
    console.log(`${'='.repeat(60)}`);
    console.log(msg);
}

async function test(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        passed.push(name);
        console.log(`  ✅ ${name}`);
    } catch (error) {
        failed.push(name);
        console.error(`  ❌ ${name}: ${error instanceof Error ? error.message : error}`);
    }
}

// ============================================================================
// Tests
// ============================================================================

async function main() {
    console.log(`\n🧪 Universal LLM Client v3.0.0 — Google AI Smoke Test`);
    console.log(`   Model: ${MODEL}\n`);

    // ---- 1) Basic Chat ----
    log('1. Basic Chat', 'Testing Google Gemini chat...');
    await test('basic chat', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ type: AIModelApiType.Google, apiKey: GOOGLE_KEY }],
        });

        const response = await model.chat([
            { role: 'user', content: 'Reply with exactly: HELLO_GEMINI' },
        ], { temperature: 0 });

        console.log(`    Provider: ${response.provider}`);
        console.log(`    Response: ${response.message.content?.slice(0, 200)}`);
        console.log(`    Usage: ${JSON.stringify(response.usage)}`);

        if (!response.message.content) throw new Error('No content');
        if (response.provider !== 'google') throw new Error(`Wrong provider: ${response.provider}`);
    });

    // ---- 2) System Prompt ----
    log('2. System Prompt', 'Testing system instruction handling...');
    await test('system prompt', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ type: AIModelApiType.Google, apiKey: GOOGLE_KEY }],
        });

        const response = await model.chat([
            { role: 'system', content: 'You are a pirate. Every response must start with "Arrr!"' },
            { role: 'user', content: 'Greet me.' },
        ], { temperature: 0.3 });

        console.log(`    Response: ${response.message.content?.slice(0, 200)}`);
        if (!response.message.content) throw new Error('No content');
    });

    // ---- 3) Streaming ----
    log('3. Streaming', 'Testing streaming response...');
    await test('streaming', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ type: AIModelApiType.Google, apiKey: GOOGLE_KEY }],
        });

        let chunks = 0;
        let text = '';

        const stream = model.chatStream([
            { role: 'user', content: 'Count from 1 to 5, one number per line, nothing else.' },
        ], { temperature: 0 });

        for await (const event of stream) {
            if (event.type === 'text') {
                text += event.content;
                chunks++;
            }
        }

        console.log(`    Chunks: ${chunks}`);
        console.log(`    Text: ${text.slice(0, 200)}`);
        if (chunks === 0) throw new Error('No chunks received');
    });

    // ---- 4) Tool Calling ----
    log('4. Tool Calling', 'Testing Gemini tool calling...');
    await test('tool calling', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ type: AIModelApiType.Google, apiKey: GOOGLE_KEY }],
        });

        const timeTool = createTimeTool();
        model.registerTool(
            timeTool.name,
            timeTool.description,
            timeTool.parameters,
            timeTool.handler,
        );

        const response = await model.chatWithTools([
            { role: 'user', content: 'What is the current time? Use the get_current_time tool.' },
        ], { temperature: 0, maxIterations: 3 });

        console.log(`    Response: ${response.message.content?.slice(0, 300)}`);
        console.log(`    Tool trace: ${JSON.stringify(response.toolTrace?.map(t => t.name))}`);

        if (!response.message.content) throw new Error('No content');
    });

    // ---- 5) Multi-turn Conversation ----
    log('5. Multi-turn', 'Testing conversation context...');
    await test('multi-turn', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ type: AIModelApiType.Google, apiKey: GOOGLE_KEY }],
        });

        const response = await model.chat([
            { role: 'user', content: 'My name is Igor.' },
            { role: 'assistant', content: 'Nice to meet you, Igor!' },
            { role: 'user', content: 'What is my name? Reply with just the name.' },
        ], { temperature: 0 });

        console.log(`    Response: ${response.message.content?.slice(0, 200)}`);
        if (!response.message.content?.toLowerCase().includes('igor')) {
            throw new Error(`Expected "Igor", got: ${response.message.content}`);
        }
    });

    // ---- 6) Auditor ----
    log('6. Auditor', 'Testing ConsoleAuditor with Google...');
    await test('auditor', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ type: AIModelApiType.Google, apiKey: GOOGLE_KEY }],
            auditor: new ConsoleAuditor('[GEMINI]'),
        });

        const response = await model.chat([
            { role: 'user', content: 'Reply: OK' },
        ], { temperature: 0 });

        console.log(`    Auditor logged above ↑`);
        if (!response.message.content) throw new Error('No content');
    });

    // ---- 7) Cross-Provider Failover ----
    log('7. Cross-Provider Failover', 'Testing Google → Ollama failover...');
    await test('cross-provider failover', async () => {
        const model = new AIModel({
            model: 'qwen3:4b',
            retries: 0,
            providers: [
                // Google will fail because model name 'qwen3:4b' doesn't exist there
                { type: AIModelApiType.Google, apiKey: GOOGLE_KEY, priority: 0 },
                // Ollama has it
                { type: AIModelApiType.Ollama, url: 'http://localhost:11434', priority: 1 },
            ],
        });

        const response = await model.chat([
            { role: 'user', content: 'Reply with: FAILOVER_OK' },
        ], { temperature: 0 });

        console.log(`    Provider: ${response.provider}`);
        console.log(`    Response: ${response.message.content?.slice(0, 200)}`);
        if (!response.message.content) throw new Error('No content');
        if (response.provider !== 'ollama') throw new Error(`Expected ollama failover, got: ${response.provider}`);
    });

    // ============================================================================
    // Summary
    // ============================================================================

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  RESULTS: ${passed.length} passed, ${failed.length} failed`);
    console.log(`${'='.repeat(60)}`);

    if (failed.length > 0) {
        console.log(`\n  Failed tests:`);
        for (const name of failed) console.log(`    ❌ ${name}`);
        process.exit(1);
    } else {
        console.log(`\n  🎉 All Google AI smoke tests passed!`);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
