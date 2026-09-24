import { invoke, isTauri } from '@tauri-apps/api/core';
import type { WalletState } from '../types/trading';

let data: Record<string, string> = {};
let wallet: WalletState | null = null;
let ready = false;
let notice: string | null = null;
let failure: Error | null = null;
let readOnly = false;
let pending: Promise<void> = Promise.resolve();
let saveQueued = false;
const listeners = new Set<(key?: string) => void>();
const accountKey = (key: string) => ['orders', 'chart_markers', 'token_strategies', 'strategy_config', 'tracked_tokens', 'submissions'].some(part => key.includes(part));
function keyFor(key: string) { return accountKey(key) && wallet ? `${wallet.address.toLowerCase()}:${key}` : key; }
/** Batch changes made by a single settings or order action. */
function queueSave(changedKey?: string) {
  if (!ready) throw new Error('Secure local storage is not initialized');
  if (readOnly) { listeners.forEach(fn => fn(changedKey)); return; }
  listeners.forEach(fn => fn(changedKey));
  if (saveQueued) return;
  saveQueued = true;
  const write = () => {
    saveQueued = false;
    const snapshot = { ...data };
    pending = pending.then(() => invoke<void>('vault_save', { data: snapshot })).then(() => { failure = null; }).catch(e => {
      failure = new Error(`Encrypted storage failed: ${String(e)}. Trading is paused.`);
      window.dispatchEvent(new CustomEvent('dekxdis-storage-error', { detail: failure.message }));
    });
  };
  // A microtask is enough to catch every change made by one action, and still lands the write
  // immediately after it for anything that reads storage back.
  if (typeof queueMicrotask === 'function') queueMicrotask(write); else setTimeout(write, 0);
}
export const nativeStore = {
  async initialize() {
    if (!isTauri()) {
      this.openReadOnly('Browser preview: charts and settings are available. Open the Windows desktop build to use your encrypted wallet.');
      return;
    }
    const legacy: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (key.startsWith('haven_')) legacy[key] = localStorage.getItem(key)!;
    }
    const result = await invoke<{ wallet: WalletState; data: Record<string, string>; notice: string | null }>('vault_open', { legacy });
    data = result.data; wallet = result.wallet; notice = result.notice; ready = true; readOnly = false;
    // Explicit clean start approved for this replacement. The native wallet and API-key
    // files are separate and are never part of this deletion.
    if (data.dekxdis_automation_reset_v1 !== 'done') {
      const retired = /(?:^|:)haven_(?:defi_terminal_)?(?:module_|modules_|token_ladders|impulse_ladder|orders(?:$|_)|accounting_orders|submissions|chart_markers)/;
      for (const key of Object.keys(data)) if (retired.test(key)) delete data[key];
      data.dekxdis_automation_reset_v1 = 'done';
      queueSave();
      await this.flush();
    }
    // Remove plaintext only after the native vault is durably written/read.
    Object.keys(legacy).forEach(key => localStorage.removeItem(key));
  },
  getItem(key: string) { return data[keyFor(key)] ?? null; },
  setItem(key: string, value: string) { if (data[keyFor(key)] === value) return; data[keyFor(key)] = value; queueSave(key); },
  removeItem(key: string) { if (!(keyFor(key) in data)) return; delete data[keyFor(key)]; queueSave(key); },
  getWallet() { return wallet; },
  listWallets() { return readOnly ? Promise.resolve([] as WalletState[]) : invoke<WalletState[]>('wallet_list'); },
  async switchWallet(address: string) {
    if (!this.isHealthy()) throw new Error('Secure wallet storage is unavailable');
    await this.flush();
    wallet = await invoke<WalletState>('wallet_switch', { address });
    listeners.forEach(fn => fn());
    return wallet;
  },
  getNotice() { return notice; },
  openReadOnly(message: string) { data = {}; wallet = null; notice = message; ready = true; readOnly = true; },
  isHealthy() { return ready && !readOnly && !failure; },
  async flush() {
    // queueSave schedules its promise in a microtask. Include that promise before
    // returning to a caller about to send a signed order over the network.
    do { await Promise.resolve(); const writing = pending; await writing; if (!saveQueued && writing === pending) break; } while (true);
    if (failure) throw failure;
  },
  subscribe(listener: (key?: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async replaceWallet(input?: string) {
    if (readOnly) throw new Error('The native wallet is unavailable in this preview. Use the Windows desktop build.');
    await this.flush();
    wallet = await invoke<WalletState>('wallet_replace', { input: input ?? null });
    listeners.forEach(fn => fn());
    return wallet;
  },
  exportWallet(address: string) { return invoke<{ privateKey: string; mnemonic?: string }>('wallet_export', { address }); },
  async confirmBackup(address: string, suffix: string) {
    const confirmed = await invoke<WalletState>('wallet_confirm_backup', { address, suffix });
    if (wallet?.address.toLowerCase() !== confirmed.address.toLowerCase()) throw new Error('Wallet changed; back up the active wallet.');
    wallet = confirmed;
    listeners.forEach(fn => fn());
    return confirmed;
  },
};
