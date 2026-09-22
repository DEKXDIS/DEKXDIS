import { nativeStore } from '../services/nativeStore';
import type { TokenConfig } from '../types/trading';
import type { Json, ModuleEvent, ModuleIdentity, ModuleRequest, NativeScope, RunLimits } from './contracts';

export interface ModuleEffect {
  request: ModuleRequest; eventId: string; status: 'planned' | 'dispatching' | 'result' | 'applied' | 'ambiguous';
  createdAt: number; result?: Json; error?: string; completedAt?: number; dataTime?: number;
}
export interface ModuleRun extends ModuleIdentity, NativeScope {
  priorPackages?: { moduleVersion: string; packageHash: string }[];
  moduleVersion: string; stateSchemaVersion: number; token: TokenConfig; chainId: number;
  configuration: Record<string, Json>; limits: RunLimits; state: Json; view: Record<string, Json>;
  status: 'running' | 'paused' | 'error' | 'completed'; error?: string;
  fundingBlocked?: boolean;
  createdAt: number; updatedAt: number; events: string[]; effects: Record<string, ModuleEffect>;
  scheduled: { id: string; time: number; name: string }[]; requestTimes: number[]; eventTimes: number[];
}
export const MODULE_RUNS_KEY = 'haven_defi_terminal_module_runs_v1';
const listeners = new Set<() => void>();
let writes: Promise<unknown> = Promise.resolve();
let cachedRaw: string | null | undefined;
let cached: ModuleRun[] = [];
function all(): Record<string, ModuleRun> {
  const raw = nativeStore.getItem(MODULE_RUNS_KEY);
  const value = raw ? JSON.parse(raw) : {};
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Module run store is invalid');
  return value;
}
function changed() { listeners.forEach(fn => fn()); }
nativeStore.subscribe(changed);
export const moduleStateStore = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  getSnapshot(): ModuleRun[] {
    const raw = nativeStore.getItem(MODULE_RUNS_KEY);
    if (raw !== cachedRaw) { cachedRaw = raw; cached = Object.values(all()); }
    return cached;
  },
  get(runId: string): ModuleRun | undefined { return all()[runId]; },
  async transaction(walletAddress: string, mutate: (runs: Record<string, ModuleRun>) => void) {
    const operation = writes.catch(() => {}).then(async () => {
      if (!nativeStore.isHealthy() || nativeStore.getWallet()?.address.toLowerCase() !== walletAddress.toLowerCase()) throw new Error('Active wallet or encrypted storage changed');
      const runs = all(); mutate(runs);
      const encoded = JSON.stringify(runs);
      if (encoded.length > 16 * 1024 * 1024) throw new Error('Module history storage limit reached');
      nativeStore.setItem(MODULE_RUNS_KEY, encoded);
      await nativeStore.flush();
      if (nativeStore.getWallet()?.address.toLowerCase() !== walletAddress.toLowerCase()) throw new Error('Active wallet changed during module state commit');
      changed();
    });
    writes = operation;
    return operation;
  },
  async update(run: ModuleRun, mutate: (current: ModuleRun) => void) {
    await this.transaction(run.walletAddress, runs => {
      const current = runs[run.runId];
      if (!current || current.generation !== run.generation || current.packageHash !== run.packageHash) throw new Error('Module run identity changed');
      mutate(current); current.updatedAt = Date.now();
    });
  },
  /** Wallet-switch callers already await storageService.flush after this invalidation. */
  pauseAll(): number {
    const runs = all(); let count = 0;
    for (const run of Object.values(runs)) if (run.status === 'running') { run.status = 'paused'; run.updatedAt = Date.now(); count++; }
    if (count) nativeStore.setItem(MODULE_RUNS_KEY, JSON.stringify(runs));
    return count;
  },
};
export function resultEvent(effect: ModuleEffect): ModuleEvent {
  return { id: `result:${effect.request.id}`, type: effect.error ? 'capability-error' : 'capability-result',
    time: effect.completedAt ?? effect.createdAt, requestId: effect.request.id, data: effect.result, error: effect.error };
}
