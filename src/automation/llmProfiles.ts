import { invoke } from '@tauri-apps/api/core';

export type ApiFormat = 'responses' | 'chat-completions' | 'anthropic' | 'gemini';
export type AuthMode = 'bearer' | 'header' | 'none';
export interface LlmConfig {
  name: string; format: ApiFormat; baseUrl: string; endpoint: string; model: string;
  authMode: AuthMode; authHeader: string; authPrefix: string;
  maxOutputTokens: number | null; timeoutSeconds: number; temperature: number | null;
  reasoningEffort: string; thinkingBudget: number | null; apiVersion: string;
  maxTokenParameter: 'max_tokens' | 'max_completion_tokens'; extraBody: Record<string, unknown>;
}
export interface LlmProfile {
  id: string; config: LlmConfig; credentialId: string | null; headerNames: string[]; revision: number; ready: boolean;
}
export interface LlmProfiles {
  profiles: LlmProfile[];
  credentials: { id: string; label: string; scope: string }[];
  defaultProfileId: string | null;
  legacyModels: Record<string, string>;
}
export interface LlmProfileInput {
  id: string | null; expectedRevision: number | null; saveAsNew: boolean; config: LlmConfig;
  credentialId: string | null; newKey: string | null; headers: Record<string, string> | null; makeDefault: boolean;
}
export interface LlmSession { profileId: string; name: string; model: string }
export const emptyProfiles: LlmProfiles = { profiles: [], credentials: [], defaultProfileId: null, legacyModels: {} };
export const blankLlmConfig: LlmConfig = {
  name: '', format: 'chat-completions', baseUrl: '', endpoint: '/v1/chat/completions', model: '',
  authMode: 'bearer', authHeader: '', authPrefix: '', maxOutputTokens: null, timeoutSeconds: 120,
  temperature: null, reasoningEffort: '', thinkingBudget: null, apiVersion: '', maxTokenParameter: 'max_tokens', extraBody: {},
};
const settingsPrefix = 'dekxdis_automation_settings_v1:';
function legacySettings() {
  const settings: { key: string; value: Record<string, unknown>; model: string }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (!key.startsWith(settingsPrefix)) continue;
    try {
      const value = JSON.parse(localStorage.getItem(key)!);
      if (value && typeof value === 'object' && !Array.isArray(value) && !value.llmProfileId) {
        settings.push({ key, value, model: typeof value.model === 'string' && value.model.trim() ? value.model : 'gpt-6-luna' });
      }
    } catch { /* Preserve unreadable settings instead of replacing them during migration. */ }
  }
  return settings;
}
export function migrateProfileAssignments(list: LlmProfiles) {
  for (const { key, value, model } of legacySettings()) {
    const id = list.legacyModels[model];
    if (!id || !list.profiles.some(p => p.id === id)) continue;
    const { model: _legacyModel, ...settings } = value;
    localStorage.setItem(key, JSON.stringify({ ...settings, llmProfileId: id }));
  }
}
export function profileAssignments(id: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (!key.startsWith(settingsPrefix)) continue;
    try { if (JSON.parse(localStorage.getItem(key)!).llmProfileId === id) result.push(key.slice(settingsPrefix.length)); } catch { /* No assignment available. */ }
  }
  return result;
}
export function credentialScope(config: Pick<LlmConfig, 'baseUrl' | 'authMode' | 'authHeader' | 'authPrefix'>): string | null {
  try {
    return `${new URL(config.baseUrl).origin}|${config.authMode[0].toUpperCase() + config.authMode.slice(1)}|${config.authMode === 'bearer' ? 'authorization' : config.authHeader.toLowerCase()}|${config.authMode === 'bearer' ? 'Bearer ' : config.authPrefix}`;
  } catch { return null; }
}
export const llmProfiles = {
  async list(): Promise<LlmProfiles> {
    const list = await invoke<LlmProfiles>('automation_profiles_list', { legacyModels: [...new Set(legacySettings().map(s => s.model))] });
    // Native profiles and keys have been durably saved before references are migrated.
    migrateProfileAssignments(list);
    return list;
  },
  save: (input: LlmProfileInput) => invoke<{ id: string; list: LlmProfiles }>('automation_profile_save', { input }),
  test: (input: LlmProfileInput) => invoke<string>('automation_profile_test', { input }),
  delete: (id: string) => invoke<LlmProfiles>('automation_profile_delete', { id }),
};
