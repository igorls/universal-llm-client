/**
 * Ollama Cloud Model Sweep
 *
 * Tests basic chat against every cloud model on the local Ollama instance.
 * Validates: response parsing, content extraction, usage tracking.
 *
 * Run: bun run smoke-test-cloud-sweep.ts
 */

import { AIModel, AIModelApiType } from './src/index.js';

const OLLAMA_URL = 'http://localhost:11434';
const PROMPT = 'What is 2+2? Reply with just the number.';

const CLOUD_MODELS = [
    'deepseek-v3.2:cloud',
    'gpt-oss:120b-cloud',
    'gpt-oss:20b-cloud',
    'qwen3-coder-next:cloud',
    'qwen3-vl:235b-cloud',
    'qwen3-vl:235b-instruct-cloud',
    'kimi-k2.5:cloud',
    'minimax-m2.5:cloud',
    'glm-5:cloud',
    'glm-4.7:cloud',
    'qwen3.5:cloud',
];

interface Result {
    model: string;
    status: '✅' | '❌';
    content: string;
    thinking: string;
    provider: string;
    tokens: string;
    latency: string;
    error?: string;
}

async function testModel(modelName: string): Promise<Result> {
    const start = Date.now();
    try {
        const model = new AIModel({
            model: modelName,
            timeout: 60000, // cloud models may be slower
            providers: [{ type: AIModelApiType.Ollama, url: OLLAMA_URL }],
        });

        const response = await model.chat([
            { role: 'user', content: PROMPT },
        ], { temperature: 0 });

        const latency = Date.now() - start;
        const content = typeof response.message.content === 'string'
            ? response.message.content
            : JSON.stringify(response.message.content);

        return {
            model: modelName,
            status: content.trim() ? '✅' : '❌',
            content: content.slice(0, 80).replace(/\n/g, '\\n'),
            thinking: response.reasoning ? response.reasoning.slice(0, 40).replace(/\n/g, '\\n') + '...' : '-',
            provider: response.provider || 'unknown',
            tokens: response.usage
                ? `${response.usage.inputTokens}→${response.usage.outputTokens}`
                : '-',
            latency: `${latency}ms`,
        };
    } catch (error) {
        return {
            model: modelName,
            status: '❌',
            content: '-',
            thinking: '-',
            provider: '-',
            tokens: '-',
            latency: `${Date.now() - start}ms`,
            error: error instanceof Error ? error.message.slice(0, 80) : String(error),
        };
    }
}

async function main() {
    console.log(`\n🌐 Ollama Cloud Model Sweep`);
    console.log(`   Testing ${CLOUD_MODELS.length} cloud models`);
    console.log(`   Prompt: "${PROMPT}"\n`);

    const results: Result[] = [];

    for (const modelName of CLOUD_MODELS) {
        process.stdout.write(`  Testing ${modelName.padEnd(35)}... `);
        const result = await testModel(modelName);
        results.push(result);
        console.log(`${result.status} ${result.latency.padStart(8)} | ${result.content.slice(0, 50)}`);
    }

    // Summary table
    console.log(`\n${'='.repeat(100)}`);
    console.log('  RESULTS');
    console.log(`${'='.repeat(100)}`);
    console.log(`  ${'Model'.padEnd(35)} ${'Status'.padEnd(8)} ${'Latency'.padEnd(10)} ${'Tokens'.padEnd(12)} Content`);
    console.log(`  ${'─'.repeat(95)}`);

    for (const r of results) {
        if (r.error) {
            console.log(`  ${r.model.padEnd(35)} ${r.status.padEnd(8)} ${r.latency.padStart(8)}   ${'─'.padEnd(12)} ERROR: ${r.error}`);
        } else {
            console.log(`  ${r.model.padEnd(35)} ${r.status.padEnd(8)} ${r.latency.padStart(8)}   ${r.tokens.padEnd(12)} ${r.content.slice(0, 50)}`);
        }
    }

    // Models that used thinking-as-content (deepseek pattern)
    const thinkingModels = results.filter(r => r.thinking !== '-');
    if (thinkingModels.length > 0) {
        console.log(`\n  ⚠️  Models with reasoning content:`);
        for (const r of thinkingModels) {
            console.log(`     ${r.model}: ${r.thinking}`);
        }
    }

    const passed = results.filter(r => r.status === '✅').length;
    const failed = results.filter(r => r.status === '❌').length;
    console.log(`\n  ${passed}/${results.length} passed, ${failed} failed\n`);

    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
