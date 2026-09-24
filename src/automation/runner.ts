import { invoke } from '@tauri-apps/api/core';
import { ethers } from 'ethers';
import { getStrategiesEnabled } from '../config/releaseFeatures';
import { getTradingQuoteToken } from '../types/chains';
import type { WalletState } from '../types/trading';
import { nativeStore } from '../services/nativeStore';
import { storageService } from '../services/storageService';
import { placeOrder, reservedAmount } from '../services/orderPlacement';
import { web3Service } from '../services/web3Service';
import { assertTradingPair } from '../services/tradingQuote';
import { systemLogService } from '../services/systemLogService';
import { captureWorkspace } from './chartCapture';
import { openBuyCount, parseDecision, RESPONSE_FORMAT, tradePacket, workspaceOrders } from './packet';
import { workspaceKey, validateSettings, type Workspace, type AutomationSettings } from './settings';

export interface ActiveWorkspace extends Workspace { tokenAddress: string; running: boolean }
export interface RunStatus { running: boolean; busy: boolean; message: string; checkedAt?: number; nextAt?: number }
type Run = { workspace: Workspace; wallet: WalletState; settings: AutomationSettings; abort: AbortController;
  status: RunStatus; timer?: ReturnType<typeof setTimeout>; lastError?: string };
const runs = new Map<string, Run>();
const listeners = new Map<string, Set<() => void>>();
const activeListeners = new Set<() => void>();
let active: ActiveWorkspace[] = [];
const stopped: RunStatus = { running: false, busy: false, message: 'Stopped' };
function publishActive() {
  active = [...runs.values()].filter(r => r.status.running).map(r => ({ ...r.workspace, tokenAddress: r.workspace.token.address, running: true }));
  activeListeners.forEach(fn => fn());
}
function update(key: string, run: Run, changes: Partial<RunStatus>) {
  run.status = { ...run.status, ...changes }; listeners.get(key)?.forEach(fn => fn());
}
function check(run: Run) {
  run.abort.signal.throwIfAborted();
  if (!getStrategiesEnabled() || !nativeStore.isHealthy() || nativeStore.getWallet()?.address.toLowerCase() !== run.workspace.owner.toLowerCase()) {
    throw new Error('Automation wallet or local storage is unavailable');
  }
}
function checkTrade(run: Run, side: 'buy' | 'sell') {
  check(run);
  const all = storageService.getOrders();
  if (side === 'buy' && run.settings.maxOpenBuys > 0 && openBuyCount(all, run.workspace) >= run.settings.maxOpenBuys) {
    throw new Error('Maximum open buys reached; filled buys and exits do not count');
  }
  const latest = workspaceOrders(storageService.getAccountingOrders(all), run.workspace).filter(o => o.automationRequestId)
    .reduce((time, o) => Math.max(time, o.timestamp), 0);
  if (Date.now() < latest + run.settings.tradeIntervalSeconds * 1000) throw new Error('Waiting for the configured time between trades');
}
async function cycle(key: string, run: Run) {
  update(key, run, { busy: true, nextAt: undefined, message: 'Capturing chart' });
  try {
    check(run);
    const chart = await captureWorkspace(run.workspace, run.abort.signal);
    check(run);
    update(key, run, { message: 'Reading balances' });
    const quote = getTradingQuoteToken(run.workspace.chainId);
    const assets = [run.workspace.token, quote];
    const balances = await Promise.all(assets.map(async asset => {
      const raw = await web3Service.getTokenBalanceWei(run.workspace.owner, asset.address, run.workspace.chainId);
      const reserved = reservedAmount(storageService.getOrders(), run.workspace.owner, run.workspace.chainId, asset.address, asset.decimals);
      return { asset: asset.address, symbol: asset.symbol, amount: ethers.formatUnits(raw, asset.decimals),
        unreservedAmount: ethers.formatUnits(raw > reserved ? raw - reserved : 0n, asset.decimals), observedAt: Date.now() };
    }));
    check(run);
    const { image, orders, ...chartInfo } = chart;
    const packet = { workspace: run.workspace, chart: chartInfo, balances, settings: run.settings,
      ...tradePacket(storageService.getAccountingOrders(orders), run.workspace, run.settings.historyCount) };
    update(key, run, { message: 'Waiting for model' });
    const response = await invoke<string>('automation_decide', { model: run.settings.model,
      instructions: `${run.settings.prompt}\n\nResponse format:\n${RESPONSE_FORMAT}`, packet, image });
    check(run);
    const decision = parseDecision(response);
    const cycleId = crypto.randomUUID();
    let placed = 0;
    for (const [index, proposed] of decision.orders.entries()) {
      checkTrade(run, proposed.side);
      const command = run.settings.amountMode === 'fixed'
        ? { ...proposed, amount: run.settings.amount, amountUnit: run.settings.amountUnit } : proposed;
      update(key, run, { message: `Placing ${command.side} order` });
      await placeOrder({ wallet: run.wallet, token: run.workspace.token, chainId: run.workspace.chainId,
        requestId: `${cycleId}:${index}`, checkCurrent: () => checkTrade(run, command.side) }, command);
      placed++;
    }
    run.lastError = undefined;
    update(key, run, { checkedAt: Date.now(), message: `${placed ? `${placed} order${placed === 1 ? '' : 's'} placed. ` : ''}${decision.reason || 'No order requested'}` });
    // chart, packet, image and full response die with this call. Only the short status remains.
  } catch (error) {
    if (!run.abort.signal.aborted) {
      const message = error instanceof Error ? error.message : String(error);
      update(key, run, { message, checkedAt: Date.now() });
      if (message !== run.lastError) systemLogService.logWarning('STRATEGY', `Automation: ${run.workspace.token.symbol}`, message, run.workspace.chainId);
      run.lastError = message;
    }
  } finally {
    update(key, run, { busy: false });
    if (!run.abort.signal.aborted) {
      update(key, run, { nextAt: Date.now() + run.settings.intervalSeconds * 1000 });
      run.timer = setTimeout(() => void cycle(key, run), run.settings.intervalSeconds * 1000);
    }
  }
}
export const automation = {
  activeWorkspaces: () => active,
  subscribe(listener: () => void) { activeListeners.add(listener); return () => { activeListeners.delete(listener); }; },
  status: (key: string) => runs.get(key)?.status || stopped,
  subscribeWorkspace(key: string, listener: () => void) {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(listener);
    return () => { const set = listeners.get(key); set?.delete(listener); if (!set?.size) listeners.delete(key); };
  },
  start(workspace: Workspace, settings: AutomationSettings) {
    validateSettings(settings);
    assertTradingPair(workspace.token.address, workspace.chainId);
    const key = workspaceKey(workspace.owner, workspace.chainId, workspace.token.address);
    if (runs.get(key)?.status.busy) throw new Error('The previous request is finishing. Its result will be discarded.');
    if (runs.get(key)?.status.running) return;
    const wallet = nativeStore.getWallet();
    if (!wallet || wallet.needsBackup) throw new Error('Select and back up your wallet first');
    const run: Run = { workspace: { ...workspace, token: { ...workspace.token } }, wallet: { ...wallet }, settings: { ...settings },
      abort: new AbortController(), status: { running: true, busy: false, message: 'Starting' } };
    check(run); runs.set(key, run); publishActive(); void cycle(key, run);
  },
  stop(key: string) {
    const run = runs.get(key); if (!run) return;
    run.abort.abort(); clearTimeout(run.timer);
    update(key, run, { running: false, nextAt: undefined, message: 'Stopped' }); publishActive();
  },
  stopAll() { for (const key of runs.keys()) this.stop(key); },
};
nativeStore.subscribe(() => {
  for (const [key, run] of runs) if (run.status.running &&
    (!nativeStore.isHealthy() || nativeStore.getWallet()?.address.toLowerCase() !== run.workspace.owner.toLowerCase())) automation.stop(key);
});
