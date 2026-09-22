import { isTauri } from '@tauri-apps/api/core';
import { version } from '../../package.json';
import { systemLogService } from './systemLogService';

export const UPDATE_API = 'https://haven-update-check-production.up.railway.app';
const KEY = 'haven.daily-update.v1';
const DAY = 24 * 60 * 60 * 1000;
let inFlight: Promise<string | null> | undefined;
let storageFailed = false;
type State = { checkedAt: number; latestVersion?: string; failed?: boolean };

export function isNewerVersion(candidate: string, current = version): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+$/.test(current)) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function checkForUpdates(): Promise<string | null> {
  if (!isTauri() || storageFailed) return Promise.resolve(null);
  if (inFlight) return inFlight;
  inFlight = performCheck().finally(() => { inFlight = undefined; });
  return inFlight;
}

export function startUpdateChecks(onResult: (latest: string | null) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    const startedAt = Date.now();
    const latest = await checkForUpdates();
    if (stopped) return;
    onResult(latest);
    timer = setTimeout(() => { void run(); }, Math.max(0, DAY - (Date.now() - startedAt)));
  };
  void run();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

async function performCheck(): Promise<string | null> {
  let state: State;
  let countCheckIn: boolean;
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? JSON.parse(raw) : { checkedAt: 0 };
    if (!state || !Number.isFinite(state.checkedAt) || state.checkedAt < 0
        || (state.latestVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(state.latestVersion))) throw new Error('Invalid saved update-check state');
    const elapsed = Date.now() - state.checkedAt;
    countCheckIn = elapsed < 0 || elapsed >= DAY;
    // Only the counter is gated by 24 hours; every startup still fetches the current version.
    if (countCheckIn) {
      state = { ...state, checkedAt: Date.now() };
      localStorage.setItem(KEY, JSON.stringify(state));
    }
  } catch (error) {
    storageFailed = true;
    systemLogService.logError('SYSTEM', 'Update check storage failed', String(error));
    return null;
  }
  try {
    const requestId = countCheckIn ? crypto.randomUUID() : undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      let delay = 2000 * 2 ** attempt;
      let retryable = true;
      try {
        const response = await fetch(`${UPDATE_API}/${countCheckIn ? 'check' : 'version'}`, {
          method: countCheckIn ? 'POST' : 'GET',
          ...(countCheckIn ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }) } : {}),
          credentials: 'omit', cache: 'no-store',
          referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(8000), priority: 'low',
        });
        if (!response.ok) {
          retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          const cooldown = response.headers.get('Retry-After');
          if (cooldown) {
            const ms = /^\d+(\.\d+)?$/.test(cooldown) ? Number(cooldown) * 1000 : Date.parse(cooldown) - Date.now();
            if (!Number.isFinite(ms) || ms > 30000) retryable = false;
            else delay = Math.max(delay, ms);
          }
          throw new Error(`Update server HTTP ${response.status}${cooldown ? `; Retry-After: ${cooldown}` : ''}`);
        }
        retryable = false;
        const data = await response.json();
        if (typeof data?.latestVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(data.latestVersion)) throw new Error('Invalid update server version');
        localStorage.setItem(KEY, JSON.stringify({ checkedAt: state.checkedAt, latestVersion: data.latestVersion, failed: false }));
        if (state.failed) systemLogService.logInfo('SYSTEM', 'Update check recovered', 'The update server is available again.');
        if (isNewerVersion(data.latestVersion)) {
          if (state.latestVersion !== data.latestVersion) systemLogService.logInfo('SYSTEM', 'Update available on GitHub', `DEKXDIS ${data.latestVersion} is available. Download or build it from the GitHub repository.`);
          return data.latestVersion;
        }
        return null;
      } catch (error) {
        console.warn(`Update check attempt ${attempt + 1}/3 failed`, error);
        if (!retryable || attempt === 2) throw error;
        if (delay === 30000) systemLogService.logError('SYSTEM', 'Update check repeatedly failed', `${String(error)}; retrying after 30 seconds.`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  } catch (error) {
    systemLogService.logError('SYSTEM', 'Update check failed', `${String(error)}. Will check again at the next app start or in 24 hours while running.`);
    try { localStorage.setItem(KEY, JSON.stringify({ ...state, failed: true })); }
    catch (storageError) { storageFailed = true; systemLogService.logError('SYSTEM', 'Update check storage failed', String(storageError)); }
  }
  return state.latestVersion && isNewerVersion(state.latestVersion) ? state.latestVersion : null;
}
