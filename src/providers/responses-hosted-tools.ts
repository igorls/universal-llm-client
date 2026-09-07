import { LLMProviderError } from '../errors.js';

export type HostedTool =
    | { readonly type: 'web_search'; readonly filters?: { readonly allowed_domains: readonly string[] } }
    | { readonly type: 'image_generation'; readonly quality: 'low' | 'medium' | 'high'; readonly size: '1024x1024' | '1536x1024' | '1024x1536'; readonly output_format: 'png' };

export interface HostedToolResult {
    readonly text: string;
    readonly sources: readonly { readonly url: string; readonly title: string }[];
    readonly images: readonly { readonly base64: string; readonly size?: string; readonly revisedPrompt?: string }[];
}

/** Requires a completed response AND a completed hosted call; text alone is not success. */
export async function collectHostedResult(
    events: AsyncIterable<{ data: string }>, requested: HostedTool['type'], toError: (payload: Record<string, unknown>) => Error,
): Promise<HostedToolResult> {
    const items = new Map<string, Record<string, unknown>>();
    let completed = false;
    for await (const event of events) {
        if (event.data === '[DONE]') continue;
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(event.data) as Record<string, unknown>; } catch { continue; }
        const response = payload['response'] as Record<string, unknown> | undefined;
        if (['error', 'response.failed', 'response.incomplete'].includes(String(payload['type']))) {
            throw toError(payload);
        }
        if (payload['type'] === 'response.output_item.done') {
            const item = payload['item'] as Record<string, unknown> | undefined;
            if (item) items.set(String(item['id'] ?? payload['output_index'] ?? items.size), item);
        }
        if (payload['type'] === 'response.completed') {
            completed = response?.['status'] === 'completed';
            // The final snapshot is authoritative and avoids double-counting done events.
            if (Array.isArray(response?.['output']) && response['output'].length > 0) {
                items.clear();
                for (const [index, item] of response['output'].entries()) items.set(String(index), item);
            }
        }
    }
    if (!completed) throw new LLMProviderError('openai-responses', `Hosted ${requested} stream ended before completion`);
    const sources = new Map<string, { url: string; title: string }>();
    const images: { base64: string; size?: string; revisedPrompt?: string }[] = [];
    const text: string[] = [];
    let called = false;
    const addSource = (value: Record<string, unknown>) => {
        if (typeof value['url'] !== 'string') return;
        try {
            const url = new URL(value['url']);
            if (!['https:', 'http:'].includes(url.protocol)) return;
            sources.set(url.href, { url: url.href, title: typeof value['title'] === 'string' ? value['title'] : url.hostname });
        } catch { /* Ignore malformed external citations. */ }
    };
    for (const item of items.values()) {
        if (item['type'] === `${requested}_call` && item['status'] === 'completed') called = true;
        if (item['type'] === 'image_generation_call' && item['status'] === 'completed' && typeof item['result'] === 'string') {
            images.push({ base64: item['result'], ...(typeof item['size'] === 'string' ? { size: item['size'] } : {}), ...(typeof item['revised_prompt'] === 'string' ? { revisedPrompt: item['revised_prompt'] } : {}) });
        }
        if (item['type'] === 'web_search_call') {
            const action = item['action'] as { sources?: Record<string, unknown>[] } | undefined;
            for (const source of action?.sources ?? []) addSource(source);
        }
        if (item['type'] === 'message' && Array.isArray(item['content'])) {
            for (const part of item['content'] as Record<string, unknown>[]) {
                if (typeof part['text'] === 'string') text.push(part['text']);
                if (Array.isArray(part['annotations'])) for (const annotation of part['annotations']) addSource(annotation);
            }
        }
    }
    if (!called || (requested === 'image_generation' && images.length === 0) || (requested === 'web_search' && sources.size === 0)) {
        throw new LLMProviderError('openai-responses', `Hosted ${requested} returned no completed ${requested === 'web_search' ? 'source-backed search' : 'image'}`);
    }
    return { text: text.join('\n'), sources: [...sources.values()], images };
}
