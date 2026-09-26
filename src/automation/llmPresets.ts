import { blankLlmConfig, type LlmConfig } from './llmProfiles';

export interface LlmPreset { id: string; provider: string; label: string; config: LlmConfig }
const preset = (provider: string, label: string, model: string, connection: Partial<LlmConfig>): LlmPreset => ({
  id: `${provider}:${model}`, provider, label, config: { ...blankLlmConfig, ...connection, name: `${provider} · ${label}`, model },
});
const openai: Partial<LlmConfig> = { format: 'responses', baseUrl: 'https://api.openai.com', endpoint: '/v1/responses' };
const anthropic: Partial<LlmConfig> = { format: 'anthropic', baseUrl: 'https://api.anthropic.com', endpoint: '/v1/messages',
  authMode: 'header', authHeader: 'x-api-key', apiVersion: '2023-06-01', maxOutputTokens: 8192 };
const google: Partial<LlmConfig> = { format: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com',
  endpoint: '/v1beta/models/{model}:generateContent', authMode: 'header', authHeader: 'x-goog-api-key' };
const openrouter: Partial<LlmConfig> = { baseUrl: 'https://openrouter.ai', endpoint: '/api/v1/chat/completions' };

// Editable starting points. Saved profiles retain their chosen model IDs when this catalog changes.
// Provider model/vision docs checked 2026-09-25. Preview models are labelled explicitly.
export const llmPresets: LlmPreset[] = [
  preset('OpenAI', 'GPT-6 Astra', 'gpt-6-astra', openai),
  preset('OpenAI', 'GPT-6 Sol', 'gpt-6-sol', openai),
  preset('OpenAI', 'GPT-6 Luna', 'gpt-6-luna', openai),
  preset('Anthropic', 'Claude Fable 5.1', 'claude-fable-5-1', anthropic),
  preset('Anthropic', 'Claude Opus 5.5', 'claude-opus-5-5', anthropic),
  preset('Anthropic', 'Claude Sonnet 5', 'claude-sonnet-5', anthropic),
  preset('Anthropic', 'Claude Haiku 4.5', 'claude-haiku-4-5-20251001', anthropic),
  preset('Google', 'Gemini 3.8 Flash', 'gemini-3.8-flash', google),
  preset('Google', 'Gemini 3.1 Pro (preview)', 'gemini-3.1-pro-preview', google),
  preset('DeepSeek', 'DeepSeek Flash', 'deepseek-flash', { baseUrl: 'https://api.deepseek.com', endpoint: '/chat/completions' }),
  preset('Meta / OpenRouter', 'Llama 4 Maverick', 'meta-llama/llama-4-maverick', openrouter),
  preset('Meta / OpenRouter', 'Llama 4 Scout', 'meta-llama/llama-4-scout', openrouter),
  preset('xAI', 'Grok 4.7', 'grok-4.7', { format: 'responses', baseUrl: 'https://api.x.ai', endpoint: '/v1/responses' }),
  preset('Mistral', 'Mistral Large 3', 'mistral-large-2512', { baseUrl: 'https://api.mistral.ai', endpoint: '/v1/chat/completions' }),
  preset('Mistral', 'Mistral Medium 3.1', 'mistral-medium-2508', { baseUrl: 'https://api.mistral.ai', endpoint: '/v1/chat/completions' }),
  preset('Mistral', 'Mistral Small 3.2', 'mistral-small-2506', { baseUrl: 'https://api.mistral.ai', endpoint: '/v1/chat/completions' }),
];
