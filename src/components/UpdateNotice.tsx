import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { startUpdateChecks } from '../services/updateService';
import { systemLogService } from '../services/systemLogService';

export function UpdateNotice() {
  const [latest, setLatest] = useState<string | null>(null);
  useEffect(() => startUpdateChecks(setLatest), []);
  if (!latest) return null;
  return <button className="px-3 py-1.5 rounded-lg border border-emerald-500 text-xs text-emerald-300"
    title={`DEKXDIS ${latest}. Download or build the update from GitHub.`}
    onClick={() => { void invoke('open_dekxdis_repository').catch(error => systemLogService.logError('SYSTEM', 'Unable to open GitHub', String(error))); }}>
    Update available on GitHub ↗
  </button>;
}
