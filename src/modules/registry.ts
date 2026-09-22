import { requireStrategiesEnabled } from '../services/strategyAvailability';
import { STRATEGIES_ENABLED } from '../config/releaseFeatures';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { InstalledModule, RegistrySnapshot, SecretStatus } from './contracts';

const empty: RegistrySnapshot = { modules: [], selectedModuleId: null, inboxPath: '', diagnostics: [] };
let snapshot = empty;
const listeners = new Set<() => void>();
let refresh: Promise<RegistrySnapshot> | null = null;
let watching: Promise<() => void> | null = null;
let revision = 0;
function publish(next: RegistrySnapshot, authoritative = false) {
  if (authoritative) revision++;
  if (JSON.stringify(next) !== JSON.stringify(snapshot)) { snapshot = next; listeners.forEach(fn => fn()); }
  return snapshot;
}
export const moduleRegistry = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  getSnapshot: () => snapshot,
  get(moduleId: string) { return snapshot.modules.find(m => m.moduleId === moduleId); },
  async refresh(scan = false, force = false) {
    if (!STRATEGIES_ENABLED || !isTauri()) return publish(empty);
    if (!watching) watching = listen<RegistrySnapshot>('dekxdis-modules-changed', event => { publish(event.payload, true); })
      .catch(error => { watching = null; throw error; });
    await watching;
    if (force) {
      // A post-mutation read must begin after any older read; it cannot reuse that response.
      revision++;
      if (refresh) await refresh.catch(() => {});
    }
    if (refresh) return refresh;
    const startedRevision = revision;
    const operation = invoke<RegistrySnapshot>(scan ? 'modules_scan_inbox' : 'modules_list')
      .then(next => startedRevision === revision ? publish(next) : snapshot)
      .finally(() => { if (refresh === operation) refresh = null; });
    refresh = operation;
    return refresh;
  },
  async install(envelope: string) {
    requireStrategiesEnabled();
    if (!isTauri()) throw new Error('Install modules in the Windows desktop app');
    if (new TextEncoder().encode(envelope).length > 2 * 1024 * 1024) throw new Error('Module exceeds the 2 MiB package limit');
    const installed = await invoke<InstalledModule>('modules_install', { envelope });
    await this.refresh(false, true); return installed;
  },
  async select(moduleId: string | null) {
    requireStrategiesEnabled();
    const selected = await invoke<RegistrySnapshot>('modules_select', { moduleId });
    publish(selected, true);
  },
  secretStatus(moduleId: string) { return invoke<SecretStatus>('modules_secret_status', { moduleId }); },
};
