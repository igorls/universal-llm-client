/** Published limits for exact model IDs on the public OpenAI API. */
const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
    ['gpt-6.2-astra', 1_050_000],
    ['gpt-6.2-sol', 1_050_000],
    ['gpt-6.1-terra', 1_050_000],
    ['gpt-6-luna', 1_050_000],
]);

export function publishedOpenAIContextWindow(model: string, baseUrl: string): number | undefined {
    try {
        return new URL(baseUrl).origin === 'https://api.openai.com' ? CONTEXT_WINDOWS.get(model) : undefined;
    } catch {
        return undefined;
    }
}
