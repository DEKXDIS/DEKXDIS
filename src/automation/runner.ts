import { invoke } from '@tauri-apps/api/core';
import { ethers } from 'ethers';
import { getStrategiesEnabled } from '../config/releaseFeatures';
import { getTradingQuoteToken } from '../types/chains';
import type { WalletState } from '../types/trading';
import { nativeStore } from '../services/nativeStore';
import { storageService } from '../services/storageService';
import { placeOrder, reservedAmount } from '../services/orderPlacement';
import { executionEngine } from '../services/executionEngine';
import { web3Service } from '../services/web3Service';
import { assertTradingPair } from '../services/tradingQuote';
import { systemLogService } from '../services/systemLogService';
import { captureWorkspace } from './chartCapture';
import { openBuyCount, parseDecision, RESPONSE_FORMAT, tradePacket, workspaceOrders } from './packet';
import { workspaceKey, validateSettings, type Workspace, type AutomationSettings } from './settings';
import { assertBuyAllowance, tradingAllowance } from './allowance';
import { readLatestResponse, saveLatestResponse, type LatestResponse } from './latestResponse';
import type { LlmSession } from './llmProfiles';

export interface ActiveWorkspace extends Workspace { tokenAddress: string; running: boolean }
export interface RunStatus extends LatestResponse { running: boolean; busy: boolean; message: string; checkedAt?: number; nextAt?: number; llmName?: string; modelId?: string }
type Run = { workspace: Workspace; wallet: WalletState; settings: AutomationSettings; abort: AbortController; sessionId: string;
  status: RunStatus; timer?: ReturnType<typeof setTimeout>; lastError?: string };
const runs = new Map<string, Run>();
const listeners = new Map<string, Set<() => void>>();
const activeListeners = new Set<() => void>();
let active: ActiveWorkspace[] = [];
const stopped: RunStatus = { running: false, busy: false, message: 'Stopped' };
const idleStatuses = new Map<string, RunStatus>();
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
    const history = storageService.getAccountingOrders(orders);
    const packet = { workspace: run.workspace, chart: chartInfo, balances, settings: run.settings,
      tradingAllowance: tradingAllowance(history, run.workspace, run.settings.maxFundsUsd),
      ...tradePacket(history, run.workspace, run.settings.historyCount, chart.nativePriceSnapshot) };
    update(key, run, { message: 'Waiting for model' });
    const response = await invoke<string>('automation_decide', { sessionId: run.sessionId,
      instructions: `${run.settings.prompt}\n\nResponse format:\n${RESPONSE_FORMAT}`, packet, image });
    check(run);
    const latestResponse = { lastResponse: response, respondedAt: Date.now() };
    update(key, run, latestResponse);
    saveLatestResponse(key, latestResponse);
    const decision = parseDecision(response);
    const cycleId = crypto.randomUUID();
    // Only orders actually supplied to this decision may be cancelled. Re-read the
    // main store before each action; the chart packet is not an execution ledger.
    const suppliedIds = new Set(packet.openOrders.map(order => order.id));
    for (const id of decision.cancelOrderIds) {
      if (!suppliedIds.has(id)) throw new Error('Cancellation must reference an open order from this workspace packet');
    }
    let cancelled = 0, placed = 0;
    for (const id of decision.cancelOrderIds) {
      check(run);
      const order = workspaceOrders(storageService.getOrders(), run.workspace).find(order => order.id === id);
      if (!order) throw new Error('Order to cancel is no longer available in this workspace');
      if (order.status === 'fulfilled') throw new Error('Order filled before cancellation; reassessing on the next check');
      // Cancelling one OCO leg may already have cancelled another requested leg.
      if (order.status === 'cancelled' || order.status === 'expired') continue;
      update(key, run, { message: 'Cancelling order' });
      await executionEngine.cancel(id, run.wallet, () => check(run));
      cancelled++;
      systemLogService.logInfo('STRATEGY', `Automation cancelled order: ${run.workspace.token.symbol}`, `Order: ${id}`, run.workspace.chainId);
      check(run);
    }
    for (const [index, proposed] of decision.orders.entries()) {
      checkTrade(run, proposed.side);
      const command = proposed.side === 'buy' && run.settings.amountMode === 'fixed'
        ? { ...proposed, amount: run.settings.amount, amountUnit: run.settings.amountUnit } : proposed;
      update(key, run, { message: `Placing ${command.side} order` });
      await placeOrder({ wallet: run.wallet, token: run.workspace.token, chainId: run.workspace.chainId,
        requestId: `${cycleId}:${index}`, sellFromPosition: command.side === 'sell', checkCurrent: () => checkTrade(run, command.side),
        checkBuyAmount: (amount, decimals, rate) => {
          check(run);
          assertBuyAllowance(storageService.getAccountingOrders(), run.workspace, run.settings.maxFundsUsd, amount, decimals, rate);
        } }, command);
      placed++;
    }
    run.lastError = undefined;
    update(key, run, { checkedAt: Date.now(), message: `${cancelled ? `${cancelled} cancellation${cancelled === 1 ? '' : 's'} completed. ` : ''}${placed ? `${placed} order${placed === 1 ? '' : 's'} placed. ` : ''}${decision.reason || 'No action requested'}` });
    // Input packet and image die with this call. The single displayed response is replaced next cycle.
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
  status: (key: string) => {
    if (runs.has(key)) return runs.get(key)!.status;
    if (!idleStatuses.has(key)) idleStatuses.set(key, { ...stopped, ...readLatestResponse(key) });
    return idleStatuses.get(key)!;
  },
  subscribeWorkspace(key: string, listener: () => void) {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(listener);
    return () => { const set = listeners.get(key); set?.delete(listener); if (!set?.size) listeners.delete(key); };
  },
  async start(workspace: Workspace, settings: AutomationSettings) {
    validateSettings(settings);
    assertTradingPair(workspace.token.address, workspace.chainId);
    const key = workspaceKey(workspace.owner, workspace.chainId, workspace.token.address);
    if (runs.get(key)?.status.busy) throw new Error('The previous request is finishing. Its result will be discarded.');
    if (runs.get(key)?.status.running) return;
    const wallet = nativeStore.getWallet();
    if (!wallet || wallet.needsBackup) throw new Error('Select and back up your wallet first');
    const run: Run = { workspace: { ...workspace, token: { ...workspace.token } }, wallet: { ...wallet }, settings: { ...settings },
      abort: new AbortController(), sessionId: crypto.randomUUID(),
      status: { ...this.status(key), running: true, busy: true, nextAt: undefined, llmName: undefined, modelId: undefined, message: 'Opening LLM configuration' } };
    check(run); runs.set(key, run); publishActive(); update(key, run, {});
    try {
      const selected = await invoke<LlmSession>('automation_session_open', { profileId: settings.llmProfileId, sessionId: run.sessionId });
      check(run);
      update(key, run, { llmName: selected.name, modelId: selected.model });
      void cycle(key, run);
    } catch (error) {
      const wasStopped = run.abort.signal.aborted;
      run.abort.abort();
      void invoke('automation_session_close', { sessionId: run.sessionId }).catch(() => {});
      update(key, run, { running: false, busy: false, message: wasStopped ? 'Stopped' : String(error instanceof Error ? error.message : error) });
      publishActive();
      if (!wasStopped) throw error;
    }
  },
  stop(key: string) {
    const run = runs.get(key); if (!run) return;
    run.abort.abort(); clearTimeout(run.timer);
    void invoke('automation_session_close', { sessionId: run.sessionId }).catch(() => {});
    update(key, run, { running: false, nextAt: undefined, message: 'Stopped' }); publishActive();
  },
  stopAll() { for (const key of runs.keys()) this.stop(key); },
};
nativeStore.subscribe(() => {
  for (const [key, run] of runs) if (run.status.running &&
    (!nativeStore.isHealthy() || nativeStore.getWallet()?.address.toLowerCase() !== run.workspace.owner.toLowerCase())) automation.stop(key);
});
