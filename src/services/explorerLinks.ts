import { invoke, isTauri } from '@tauri-apps/api/core';
import { systemLogService } from './systemLogService';

export async function openExplorerLink(url: string): Promise<void> {
  try {
    if (isTauri()) await invoke('open_explorer_url', { url });
    else window.open(url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    systemLogService.logError('SYSTEM', 'Unable to open explorer', String(error));
  }
}
