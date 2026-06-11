/**
 * Probe the full native tool-calling loop against vLLM, step by step,
 * printing raw wire content (skip_special_tokens: false throughout).
 */

const MODEL = process.env.MODEL_NAME ?? 'RedHatAI/diffusiongemma-26B-A4B-it-NVFP4';
const VLLM = process.env.VLLM_URL ?? 'http://localhost:8000';

const tools = [{
    type: 'function',
    function: {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: {
            type: 'object',
            properties: {
                city: { type: 'string', description: 'City name' },
                unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
            },
            required: ['city'],
        },
    },
}];

async function post(messages: unknown[], withTools: boolean): Promise<string> {
    const res = await fetch(`${VLLM}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: MODEL,
            messages,
            max_tokens: 1024,
            skip_special_tokens: false,
            ...(withTools ? { tools, tool_choice: 'none' } : {}),
        }),
    });
    const d = await res.json() as any;
    return d.choices?.[0]?.message?.content ?? JSON.stringify(d).slice(0, 300);
}

const followUp = [
    { role: 'user', content: 'What is the weather in Paris right now, in celsius?' },
    {
        role: 'assistant', content: '', tool_calls: [{
            id: 'call_x', type: 'function',
            function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Paris', unit: 'celsius' }) },
        }],
    },
    { role: 'tool', tool_call_id: 'call_x', content: JSON.stringify({ temp_c: 18, condition: 'partly cloudy' }) },
];

console.log('A) follow-up WITH tools+choice none:');
console.log('   ', JSON.stringify(await post(followUp, true)).slice(0, 500));
console.log('B) follow-up WITHOUT tools:');
console.log('   ', JSON.stringify(await post(followUp, false)).slice(0, 500));
