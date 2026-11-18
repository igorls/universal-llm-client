interface PublishedModelInfo {
    readonly contextLength: number;
    readonly capabilities: readonly string[];
}

const multimodalChat: PublishedModelInfo = {
    contextLength: 1_050_000,
    capabilities: ['completion', 'vision', 'tools'],
};

/** Published model cards for exact IDs on the public OpenAI API. */
const MODEL_CATALOG: ReadonlyMap<string, PublishedModelInfo> = new Map([
    ['gpt-6.2-astra', multimodalChat],
    ['gpt-6.2-sol', multimodalChat],
    ['gpt-6.1-terra', multimodalChat],
    ['gpt-6-luna', multimodalChat],
]);

export function publishedOpenAIModelInfo(model: string, baseUrl: string): PublishedModelInfo | undefined {
    return isPublicOpenAI(baseUrl) ? MODEL_CATALOG.get(model) : undefined;
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
