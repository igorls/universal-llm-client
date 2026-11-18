/** Published limits for exact model IDs on the public OpenAI API. */
const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
    ['gpt-6.2-astra', 1_050_000],
    ['gpt-6.2-sol', 1_050_000],
    ['gpt-6.1-terra', 1_050_000],
    ['gpt-6-luna', 1_050_000],
]);

export function publishedOpenAIContextWindow(model: string, baseUrl: string): number | undefined {
    return isPublicOpenAI(baseUrl) ? CONTEXT_WINDOWS.get(model) : undefined;
}

export function isPublicOpenAI(baseUrl: string): boolean {
    try {
        return new URL(baseUrl).origin === 'https://api.openai.com';
    } catch {
        return false;
    }
}

export function isGPT62ReasoningModel(model: string): boolean {
    return model === 'gpt-6.2-astra' || model === 'gpt-6.2-sol';
}
