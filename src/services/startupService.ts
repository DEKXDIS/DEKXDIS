import { invoke, isTauri } from '@tauri-apps/api/core';

export const startupService = {
  async state(): Promise<{ enabled: boolean }> {
    return isTauri() ? invoke('startup_state') : { enabled: false };
  },
  async setEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    if (!isTauri()) throw new Error('Windows startup settings are available in the desktop application.');
    return invoke('set_startup_enabled', { enabled });
  },
  async confirmExit(): Promise<void> { await invoke('confirm_app_exit'); },
};
