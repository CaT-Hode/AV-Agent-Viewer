export const translationProviders = [
  { id: 'google', label: 'Google', docs: 'https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate' },
  { id: 'baidu', label: '百度', docs: 'https://fanyi-api.baidu.com/doc/21' },
  { id: 'microsoft', label: 'Microsoft Azure', docs: 'https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/translate' },
] as const;
export type TranslationProviderId = typeof translationProviders[number]['id'];
export type TranslationEngine = 'ai' | TranslationProviderId;
export type TranslationProviderStatus = { id: TranslationProviderId; label: string; hasKey: boolean; configured: boolean; appId: string; region: string };
export type TranslationProviderSnapshot = { providers: TranslationProviderStatus[] };
export type TranslationProviderInput = { provider: TranslationProviderId; apiKey?: string; appId?: string; region?: string };
export function isTranslationProvider(value: unknown): value is TranslationProviderId { return translationProviders.some(provider => provider.id === value); }
export function translationEngineLabel(engine: TranslationEngine) { return engine === 'ai' ? 'AI 模型' : translationProviders.find(provider => provider.id === engine)!.label; }
