import { orderQuoteUsdPrice } from './tradingQuote';
import { historyTokenSide } from '../utils/orderHistory';
import { OrderStatusQueryError, isLegacyStatusWarning } from './cowRequests';
import { ethers } from 'ethers';
import { TradeOrder, WalletState, TokenConfig } from '../types/trading';
import { storageService as store } from './storageService';
import { nativeStore } from './nativeStore';
import { orderJournal } from './orderJournal';
import { cowProtocol as cow } from './cowProtocol';
import { web3Service as web3 } from './web3Service';
import { marketDataService as market } from './marketDataService';
import { getChainConfig, getTokensForChain } from '../types/chains';
import { quoteForQuantityUsd } from '../utils/amounts';
import { systemLogService } from './systemLogService';

const active = (o: TradeOrder) => o.status === 'open' || o.status === 'pending';
let tail: Promise<unknown> = Promise.resolve();
let polling = false;
const priceRequests = new Set<string>();
const settlementRequests = new Map<string, number>();
let settlementBusy = false;
const orderTails = new Map<string, Promise<unknown>>();
function orderExclusive<T>(order: TradeOrder, task: () => Promise<T>): Promise<T> {
  const group = order.ocoGroupId || order.parentOrderId ||
    [order, ...ocoPeers(order)].map(o => o.previousOrderId || o.id).sort()[0];
  const key = `${order.ownerAddress?.toLowerCase()}:${order.chainId}:${group}`;
  const prior = orderTails.get(key) || Promise.resolve();
  const next = prior.then(task, task);
  orderTails.set(key, next);
  void next.then(() => { if (orderTails.get(key) === next) orderTails.delete(key); }, () => { if (orderTails.get(key) === next) orderTails.delete(key); });
  return next;
}
async function stopError(stop: TradeOrder, error: unknown) {
  await patchOrder(stop.id, { protectionError: String(error) });
  systemLogService.logError('ORDER', `Stop-loss failed: ${stop.id}`, String(error), stop.chainId);
}
export function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const next = tail.then(task, task);
  tail = next.catch(() => {});
  return next;
}
export async function patchOrder(id: string, patch: Partial<TradeOrder>) {
  store.saveOrders(store.getOrders().map(o => o.id === id ? { ...o, ...patch } : o));
  await store.flush();
}
async function addOrder(order: TradeOrder) { store.addOrder(order); await store.flush(); }
function tokenFor(o: TradeOrder): TokenConfig {
  if (o.sellDecimals === undefined || !o.chainId) throw new Error('Order needs verified token decimals and chain');
  const known = [...store.getCustomTokens(o.chainId), ...getTokensForChain(o.chainId), ...store.getTrackedTokens(o.chainId)].find(t => t.address.toLowerCase() === o.sellToken.toLowerCase());
  return known || { address: o.sellToken, decimals: o.sellDecimals, chainId: o.chainId, symbol: o.sellSymbol, name: o.sellSymbol };
}
const statusRequests = new Map<string, Promise<void>>();
function orderKey(order: TradeOrder) { return `${nativeStore.getWallet()?.address.toLowerCase()}:${order.chainId}:${order.id}`; }
function sync(order: TradeOrder, reportErrors = true): Promise<void> {
  const key = orderKey(order), existing = statusRequests.get(key);
  if (existing) return existing;
  const work = syncStatus(order, reportErrors);
  statusRequests.set(key, work);
  const clear = () => { if (statusRequests.get(key) === work) statusRequests.delete(key); };
  void work.then(clear, clear);
  return work;
}
async function syncStatus(order: TradeOrder, reportErrors: boolean) {
  const owner = nativeStore.getWallet()?.address;
  const result = await cow.getOrderStatus(order.id, order.chainId, order.sellDecimals, order.buyDecimals, { includeSettlement: false, reportErrors });
  if (nativeStore.getWallet()?.address !== owner) return;
  const latest = store.getOrders().find(o => o.id === order.id);
  if (!latest || (latest.status === 'fulfilled' && result.status !== 'fulfilled') ||
      (!active(latest) && active({ ...latest, ...result }))) return;
  const patch: Partial<TradeOrder> = { ...result, protectionError: undefined };
  // Rechecking closed history must not erase its already confirmed quantities.
  for (const [field, decimals] of [['executedSellAmount', latest.sellDecimals], ['executedBuyAmount', latest.buyDecimals]] as const) {
    if (!active(latest) && latest[field] !== undefined && (result[field] === undefined ||
        ethers.parseUnits(latest[field], decimals) > ethers.parseUnits(result[field], decimals))) patch[field] = latest[field];
  }
  if (result.status === 'fulfilled') {
    patch.settlementTimestamp = result.settlementTimestamp || order.settlementTimestamp;
    patch.fillTimestamp = patch.settlementTimestamp || order.fillTimestamp;
    if (!order.executedQuoteUsdPrice && order.quoteTokenAddress) patch.executionPrice = 0;
    if (!order.quoteTokenAddress) {
      const buy = Number(result.executedBuyAmount), sell = Number(result.executedSellAmount);
      if (buy > 0 && sell > 0) patch.executionPrice = historyTokenSide(order) === 'buy' ? sell / buy : buy / sell;
    }
  }
  await patchOrder(order.id, patch);
  if (['cancelled', 'expired'].includes(latest.status) && result.status === 'fulfilled') {
    systemLogService.logInfo('ORDER', `Order fill confirmed: ${order.id}`,
      `Previously ${latest.status}; sold ${patch.executedSellAmount} ${latest.sellSymbol}, received ${patch.executedBuyAmount} ${latest.buySymbol}.`, latest.chainId);
  }
  if (order.previousOrderId && !active({ ...order, ...result })) {
    await patchOrder(order.previousOrderId, { status: result.status === 'fulfilled' ? 'cancelled' : result.status, protectionError: undefined });
  }
}

const usdFillRequests = new Map<string, number>();
function enrichFillUsd(order: TradeOrder, wallet: WalletState) {
  if (!order.quoteTokenAddress || order.status !== 'fulfilled' || order.executedQuoteUsdPrice ||
      !(Number(order.executedBuyAmount) > 0 && Number(order.executedSellAmount) > 0)) return;
  const key = `${wallet.address}:${order.chainId}:${order.id}`;
  if ((usdFillRequests.get(key) || 0) > Date.now()) return;
  usdFillRequests.set(key, Infinity);
  const isBuy = historyTokenSide(order) === 'buy';
  void orderQuoteUsdPrice(order, isBuy ? order.sellToken : order.buyToken).then(async rate => {
    if (nativeStore.getWallet()?.address !== wallet.address) return;
    const latest = store.getOrders().find(o => o.id === order.id);
    if (!latest || latest.status !== 'fulfilled' || latest.executedQuoteUsdPrice) return;
    const buy = Number(latest.executedBuyAmount), sell = Number(latest.executedSellAmount);
    await patchOrder(order.id, { executionPrice: (isBuy ? sell / buy : buy / sell) * rate,
      executedQuoteUsdPrice: rate, executedQuotePriceTimestamp: Date.now() });
  }).catch(error => systemLogService.logError('ORDER', 'Fill USD conversion unavailable', String(error), order.chainId))
    .finally(() => usdFillRequests.set(key, Date.now() + 30000));
}

// Position parents are entries, never the opposite exit. Follow legacy links as
// well as group IDs so a submitted SL and its local trigger belong to one OCO.
function ocoPeers(order: TradeOrder): TradeOrder[] {
  const scoped = store.getOrders().filter(o => o.chainId === order.chainId &&
    o.ownerAddress?.toLowerCase() === order.ownerAddress?.toLowerCase());
  const positionParents = new Set(scoped.filter(o => o.parentOrderId).map(o => o.parentOrderId!));
  const isPositionParent = (o: TradeOrder) => (o.bracket && !o.parentOrderId) || positionParents.has(o.id);
  if (isPositionParent(order)) return [];
  const candidates = scoped.filter(o => !isPositionParent(o));
  const members = new Set([order.id]);
  const pending = [order];
  for (let index = 0; index < pending.length; index++) {
    const member = pending[index];
    for (const o of candidates) {
      if (members.has(o.id)) continue;
      if ((order.parentOrderId && o.parentOrderId === order.parentOrderId) ||
          (order.ocoGroupId && o.ocoGroupId === order.ocoGroupId) ||
          member.connectedOrderId === o.id || member.previousOrderId === o.id || o.connectedOrderId === member.id || o.previousOrderId === member.id) {
        members.add(o.id); pending.push(o);
      }
    }
  }
  return candidates.filter(o => members.has(o.id) && o.id !== order.id);
}

async function reconcileOco(order: TradeOrder, wallet: WalletState) {
  if (nativeStore.getWallet()?.address !== wallet.address) return;
  const filled = store.getOrders().find(o => o.id === order.id);
  if (!filled || filled.status !== 'fulfilled' || filled.isConditional) return;
  for (const peer of ocoPeers(filled).filter(active)) {
    try {
      if (peer.isConditional) await patchOrder(peer.id, { status: 'cancelled', protectionError: undefined });
      else await invalidate(peer, wallet);
    } catch (error) {
      await patchOrder(peer.id, { protectionError: String(error) });
      systemLogService.logError('ORDER', `OCO cancellation failed: ${peer.id}`, String(error), peer.chainId);
    }
  }
  const otherFills = ocoPeers(filled).filter(o => !o.isConditional && o.status === 'fulfilled');
  if (otherFills.length) {
    const message = 'CoW confirmed multiple OCO legs filled before cancellation';
    for (const leg of [filled, ...otherFills]) {
      if (store.getOrders().find(o => o.id === leg.id)?.protectionError === message) continue;
      await patchOrder(leg.id, { protectionError: message });
      systemLogService.logError('ORDER', `OCO orders both filled: ${leg.id}`, message, leg.chainId);
    }
  }
}

// Trade/block timestamps enrich history only; they must never hold up OCO or
// the next order poll. Retry missing timestamps separately at most once/minute.
function enrichSettlement(order: TradeOrder, wallet: WalletState) {
  const key = `${wallet.address}:${order.chainId}:${order.id}`;
  if (settlementBusy || order.status !== 'fulfilled' || order.settlementTimestamp || !cow.normalizeOrderUid(order.id) ||
      (settlementRequests.get(key) || 0) > Date.now()) return;
  // At most one history lookup may occupy the shared CoW read budget.
  settlementBusy = true;
  settlementRequests.set(key, Infinity);
  void cow.getOrderSettlement(order.id, order.chainId).then(async result => {
    if (nativeStore.getWallet()?.address !== wallet.address) return;
    const latest = store.getOrders().find(o => o.id === order.id);
    if (!latest || latest.status !== 'fulfilled') return;
    if (result.settlementTimestamp || result.txHash) await patchOrder(order.id, {
      txHash: result.txHash || latest.txHash,
      settlementTimestamp: result.settlementTimestamp || latest.settlementTimestamp,
      fillTimestamp: result.settlementTimestamp || latest.fillTimestamp,
    });
  }).catch(() => { /* CoW logs query errors; timestamp enrichment retries later. */ })
    .finally(() => { settlementBusy = false; settlementRequests.set(key, Date.now() + 60000); });
}

/** Cancellation and its confirmation use the CoW orderbook exclusively. */
async function invalidate(order: TradeOrder, wallet: WalletState, checkCurrent?: () => void): Promise<'filled' | 'cancelled'> {
  const checkOwner = () => {
    if (nativeStore.getWallet()?.address !== wallet.address) throw new Error('Wallet changed before order cancellation');
  };
  checkOwner();
  checkCurrent?.();
  await sync(order);
  checkOwner();
  checkCurrent?.();
  const remote = store.getOrders().find(o => o.id === order.id)!;
  if (remote.status === 'fulfilled') return 'filled';
  if (remote.status === 'cancelled' || remote.status === 'expired') return 'cancelled';
  // The orderbook accepting the cancellation is the confirmation. It used to require a second
  // status query to observe the cancellation before the order was marked locally, so when status
  // queries were failing on a flaky connection an order the orderbook had already cancelled stayed
  // on screen as waiting for a solver — and the strategy, reading that same list, kept treating it
  // as a live level. The status poll still runs on its own schedule and corrects the record if the
  // order turns out to have filled instead.
  await cow.cancelOrder(order.id, web3.getSigner(wallet.address, order.chainId), order.chainId);
  checkOwner();
  await patchOrder(order.id, { status: 'cancelled', protectionError: undefined });
  return 'cancelled';
}

async function cancelOne(order: TradeOrder, wallet: WalletState, checkCurrent?: () => void) {
  checkCurrent?.();
  if (order.ownerAddress && order.ownerAddress.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('Order belongs to another wallet');
  if (order.isConditional) { await patchOrder(order.id, { status: 'cancelled' }); return; }
  const result = await invalidate(order, wallet, checkCurrent);
  if (result === 'filled') throw new Error('CoW confirmed the order already filled');
  await patchOrder(order.id, { status: 'cancelled', protectionError: undefined });
}

function bracketParent(exit: TradeOrder): TradeOrder | undefined {
  if (!exit.parentOrderId) return undefined;
  return store.getOrders().find(order => order.id === exit.parentOrderId && order.bracket);
}

async function confirmedTokenBalance(parent: TradeOrder, wallet: WalletState): Promise<bigint> {
  if (!parent.chainId) throw new Error('Protected order has no chain ID');
  return web3.executeWithRpcFallback(parent.chainId, async provider => {
    const token = new ethers.Contract(parent.buyToken, ['function balanceOf(address) view returns (uint256)'], provider);
    return BigInt(await token.balanceOf(wallet.address));
  });
}

// The caller already holds the parent/group queue while cancelling its exits.
async function cancelEmptyBracketLocked(parent: TradeOrder, wallet: WalletState): Promise<void> {
  const latestParent = store.getOrders().find(order => order.id === parent.id);
  if (!latestParent?.bracket || latestParent.bracket.isCompleted) return;
  const exits = store.getOrders().filter(order => active(order) &&
    (order.parentOrderId === latestParent.id || order.id === latestParent.bracket?.tpOrderId || order.id === latestParent.bracket?.slOrderId));
  for (const exit of exits.filter(order => !order.isConditional)) await cancelOne(exit, wallet);
  for (const exit of exits.filter(order => order.isConditional)) await cancelOne(exit, wallet);
  await patchOrder(latestParent.id, { bracket: { ...latestParent.bracket, isCompleted: true }, protectionError: undefined });
  systemLogService.logInfo('ORDER', `Protection cancelled: ${latestParent.buySymbol}`,
    'The wallet no longer holds this position token, so its remaining TP and SL orders were cancelled.', latestParent.chainId);
}

type ClosedCheck = { nextAt: number; pending?: Promise<void>; error?: unknown };
const closedChecks = new Map<string, ClosedCheck>();
const remotelyClosed = (order: TradeOrder) => !order.isConditional && !order.submissionError &&
  ['cancelled', 'expired'].includes(order.status) && !!cow.normalizeOrderUid(order.id);

async function checkClosedOrder(order: TradeOrder, wallet: WalletState, retryFailed = false): Promise<void> {
  const key = orderKey(order);
  let check = closedChecks.get(key);
  if (check?.pending) return check.pending;
  if (check?.error && !retryFailed) throw check.error;
  check = { nextAt: Infinity }; closedChecks.set(key, check);
  const state = check;
  const previousError = store.getOrders().find(o => o.id === order.id)?.protectionError;
  state.pending = (async () => {
    for (let attempt = 0; ; attempt++) {
      if (nativeStore.getWallet()?.address !== wallet.address) throw new Error('Wallet changed during order reconciliation');
      try { await sync(order, false); break; }
      catch (error) {
        const retryable = error instanceof OrderStatusQueryError && (error.statusCode === undefined ||
          [404, 408, 429].includes(error.statusCode) || error.statusCode >= 500);
        const delay = Math.max(2000 * 2 ** attempt, error instanceof OrderStatusQueryError ? error.retryAfterMs || 0 : 0);
        if (!retryable || attempt >= 2 || delay > 30000) throw error;
        console.warn(`Order reconciliation retry ${attempt + 1}: ${order.id}; waiting ${delay}ms`, error);
        if (delay === 30000) systemLogService.logError('ORDER', `Order reconciliation delayed: ${order.id}`, String(error), order.chainId);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    if (nativeStore.getWallet()?.address !== wallet.address) throw new Error('Wallet changed during order reconciliation');
    await orderExclusive(order, () => reconcileOco(order, wallet));
    const latest = store.getOrders().find(o => o.id === order.id);
    if (latest) { enrichSettlement(latest, wallet); enrichFillUsd(latest, wallet); }
    if (previousError?.startsWith('Order reconciliation failed:')) systemLogService.logInfo('ORDER', `Order reconciliation recovered: ${order.id}`, 'Order status verified.', order.chainId);
  })().catch(async error => {
    state.error = error;
    if (nativeStore.getWallet()?.address === wallet.address) {
      try { await patchOrder(order.id, { protectionError: `Order reconciliation failed: ${String(error)}` }); }
      finally { systemLogService.logError('ORDER', `Order reconciliation failed: ${order.id}`, String(error), order.chainId); }
    }
    throw error;
  }).finally(() => { state.pending = undefined; state.nextAt = Date.now() + 30000; });
  return state.pending;
}

// Cancellation is an orderbook acknowledgement, not proof that no settlement occurred.
// Revisit closed history at low priority, including records saved by older versions.
function pollClosedOrder(wallet: WalletState) {
  if ([...closedChecks.values()].some(check => check.pending)) return;
  const candidates = store.getOrders().filter(order => remotelyClosed(order) &&
    (!order.ownerAddress || order.ownerAddress.toLowerCase() === wallet.address.toLowerCase()) &&
    !closedChecks.get(orderKey(order))?.error && (closedChecks.get(orderKey(order))?.nextAt || 0) <= Date.now());
  candidates.sort((a, b) => (closedChecks.get(orderKey(a))?.nextAt || 0) - (closedChecks.get(orderKey(b))?.nextAt || 0) || b.timestamp - a.timestamp);
  if (candidates[0]) void checkClosedOrder(candidates[0], wallet).catch(() => { /* Persisted and reported by checkClosedOrder. */ });
}

async function cancelProtectionIfEmpty(exit: TradeOrder, wallet: WalletState): Promise<boolean> {
  const parent = bracketParent(exit);
  // Wait for verified settlement evidence so an RPC lag immediately after an
  // entry fill cannot be mistaken for a manually closed position.
  if (!parent?.settlementTimestamp || parent.bracket?.isCompleted) return false;
  // A position is finished when this position has nothing left, counted from its own fills. Asking
  // the wallet instead was wrong whenever more than one position was held in the same token: the
  // others' tokens kept the balance above zero, so a position that had already sold out was never
  // marked closed and went on occupying a level for good.
  if (positionSoldOut(parent)) { await cancelEmptyBracketLocked(parent, wallet); return true; }
  if (await confirmedTokenBalance(parent, wallet) > 0n) return false;
  await cancelEmptyBracketLocked(parent, wallet);
  return true;
}

/** Every token this entry bought has been sold, judged from the entry's own exits. */
function positionSoldOut(parent: TradeOrder): boolean {
  if (parent.buyDecimals === undefined || !parent.executedBuyAmount) return false;
  if (!parent.bracket?.tpOrderId && !parent.bracket?.slOrderId) return false;
  const exits = store.getOrders().filter(order =>
    order.parentOrderId === parent.id || order.id === parent.bracket?.tpOrderId || order.id === parent.bracket?.slOrderId);
  // With nothing fulfilled there is no sale to account for yet, and every quantity count would be
  // zero — which would read as "sold out" and close a position that is merely still open.
  if (!exits.some(order => order.status === 'fulfilled')) return false;
  let sold = 0n;
  for (const exit of exits) {
    if (exit.status !== 'fulfilled' || !exit.executedSellAmount) continue;
    try { sold += ethers.parseUnits(exit.executedSellAmount, parent.buyDecimals); } catch { return false; }
  }
  try { return sold >= ethers.parseUnits(parent.executedBuyAmount, parent.buyDecimals); } catch { return false; }
}

async function reconcileEmptyBrackets(wallet: WalletState): Promise<void> {
  const parents = store.getOrders().filter(order => order.status === 'fulfilled' && order.bracket &&
    !order.bracket.isCompleted && order.settlementTimestamp &&
    (!order.ownerAddress || order.ownerAddress.toLowerCase() === wallet.address.toLowerCase()));
  const balances = new Map<string, bigint>();
  for (const parent of parents) {
    // The position's own fills settle it without an RPC call; the balance check below only covers a
    // position with no exit recorded at all.
    if (positionSoldOut(parent)) { await orderExclusive(parent, () => cancelEmptyBracketLocked(parent, wallet)); continue; }
    const key = `${parent.chainId}:${parent.buyToken.toLowerCase()}`;
    try {
      if (!balances.has(key)) balances.set(key, await confirmedTokenBalance(parent, wallet));
      if (balances.get(key) === 0n) await orderExclusive(parent, () => cancelEmptyBracketLocked(parent, wallet));
    } catch (error) {
      await patchOrder(parent.id, { protectionError: String(error) });
      systemLogService.logError('ORDER', `Protection balance check failed: ${parent.buySymbol}`, String(error), parent.chainId);
    }
  }
}

export const executionEngine = {
  async reconcileClosedOrders(wallet: WalletState, orderIds: string[], retryFailed = false) {
    for (const id of new Set(orderIds)) {
      if (!nativeStore.isHealthy() || nativeStore.getWallet()?.address !== wallet.address) throw new Error('Wallet changed during order reconciliation');
      const order = store.getOrders().find(candidate => candidate.id === id);
      if (order && (!order.ownerAddress || order.ownerAddress.toLowerCase() === wallet.address.toLowerCase()) && remotelyClosed(order)) {
        await checkClosedOrder(order, wallet, retryFailed);
      }
    }
  },
  exclusive,
  async observePrice(address: string, chainId: number, price: number, timestamp: number) {
    if (!nativeStore.isHealthy() || !Number.isFinite(price) || price <= 0 || Date.now() - timestamp > 30000 || timestamp > Date.now() + 5000) return;
    const stops = store.getOrders().filter(o => active(o) && o.isConditional && !o.triggerTimestamp && o.chainId === chainId && o.sellToken.toLowerCase() === address.toLowerCase() && timestamp >= o.timestamp && price <= (o.triggerPrice || o.limitPrice || 0));
    for (const stop of stops) await patchOrder(stop.id, { triggerTimestamp: timestamp });
    const wallet = nativeStore.getWallet();
    if (wallet) await Promise.all(stops.map(async stop => {
      try { await this.evaluateStop(stop, wallet); } catch (error) { await stopError(stop, error); }
    }));
  },
  async monitorStops(wallet: WalletState) {
    if (!nativeStore.isHealthy() || nativeStore.getWallet()?.address !== wallet.address) return;
      const tokens = new Map<string, TokenConfig>();
      for (const stop of store.getOrders().filter(o => active(o) && o.isConditional && !o.triggerTimestamp)) {
        const token = tokenFor(stop);
        tokens.set(`${token.chainId}:${token.address.toLowerCase()}`, token);
      }
      await Promise.all([...tokens.values()].map(async token => {
        const key = `${wallet.address}:${token.chainId}:${token.address.toLowerCase()}`;
        if (priceRequests.has(key)) return;
        priceRequests.add(key);
        try {
          const price = await market.fetchTokenPrice(token.address, token.chainId, token.binanceSymbol, { maxAgeMs: 1000 });
          if (nativeStore.getWallet()?.address === wallet.address) await this.observePrice(token.address, token.chainId, price.price, price.lastUpdated);
        } catch (error) {
          for (const stop of store.getOrders().filter(o => active(o) && o.isConditional && o.chainId === token.chainId && o.sellToken.toLowerCase() === token.address.toLowerCase())) await stopError(stop, error);
        } finally { priceRequests.delete(key); }
      }));
  },
  async cancel(id: string, wallet: WalletState, checkCurrent?: () => void) {
    const selected = store.getOrders().find(o => o.id === id);
    if (!selected) throw new Error('Order not found');
    return orderExclusive(selected, async () => {
      checkCurrent?.();
      const orders = store.getOrders();
      const target = orders.find(o => o.id === id);
      if (!target) throw new Error('Order not found');
      if (!active(target)) throw new Error('Order is already closed');
      // Revoke real legs first; retain the local stop if revocation fails.
      const group = [target, ...ocoPeers(target)].filter(active);
      for (const o of group.filter(o => !o.isConditional)) await cancelOne(o, wallet, checkCurrent);
      for (const o of group.filter(o => o.isConditional)) await cancelOne(o, wallet, checkCurrent);
      const parents = store.getOrders().filter(o => o.bracket && (o.id === target.parentOrderId || o.bracket.tpOrderId === id || o.bracket.slOrderId === id));
      for (const parent of parents) await patchOrder(parent.id, { bracket: { ...parent.bracket!, isCompleted: true } });
    });
  },
  async tick(wallet: WalletState) {
    if (polling) return;
    polling = true;
    try {
      await store.flush();
      if (!nativeStore.isHealthy() || nativeStore.getWallet()?.address !== wallet.address) return;
      // Service latched stops before unrelated orderbook requests.
      const triggeredStops = Promise.all(store.getOrders().filter(o => active(o) && o.isConditional && o.triggerTimestamp).map(async stop => {
        try { await this.evaluateStop(stop, wallet); } catch (error) { await stopError(stop, error); }
      }));
      // Reconcile/replay the exact signed payload; never manufacture a replacement
      // UID after an ambiguous HTTP failure.
      const submissions = Promise.all(orderJournal.all().filter(record => record.purpose !== 'bridge').map(async record => {
        if (record.rejected) {
          const local = store.getOrders().find(o => cow.normalizeOrderUid(o.id) === record.uid);
          if (local) await patchOrder(local.id, { status: 'cancelled', submissionError: record.error });
          return;
        }
        try { await cow.postSubmission(record); } catch (error) { systemLogService.logError('ORDER', `Submission failed: ${record.uid}`, String(error), record.chainId); }
      }));
      const statusPolls = Promise.all(store.getOrders().filter(o => !o.isConditional && (active(o) ||
        o.status === 'fulfilled')).map(async order => {
        try {
          // Read-only polling must not own the submission lock while waiting
          // for HTTP. Apply the response before checking OCO under that lock.
          if (active(order)) await sync(order);
          if (nativeStore.getWallet()?.address !== wallet.address) return;
          await orderExclusive(order, () => reconcileOco(order, wallet));
          const latest = store.getOrders().find(o => o.id === order.id);
          if (latest) {
            enrichSettlement(latest, wallet); enrichFillUsd(latest, wallet);
            // Protect this confirmed fill without waiting for other orders.
            if (latest.status === 'fulfilled' && latest.bracket && !latest.bracket.isCompleted) {
              await this.activateBracket(latest, wallet);
            }
          }
        } catch (error) {
          if (error instanceof OrderStatusQueryError) {
            if (isLegacyStatusWarning(order.protectionError)) await patchOrder(order.id, { protectionError: undefined });
          } else await patchOrder(order.id, { protectionError: String(error) });
        }
      }));
      pollClosedOrder(wallet);
      await Promise.all([triggeredStops, statusPolls, submissions]);
      await reconcileEmptyBrackets(wallet);
      await Promise.all(store.getOrders().filter(o => active(o) && o.isConditional).map(async stop => {
        try { await this.evaluateStop(stop, wallet); } catch (error) { await stopError(stop, error); }
      }));
      // Complete parent tracking when either exit really fills.
      for (const parent of store.getOrders().filter(o => o.bracket && !o.bracket.isCompleted)) {
        const exits = store.getOrders().filter(o => o.parentOrderId === parent.id || o.id === parent.bracket?.tpOrderId || o.id === parent.bracket?.slOrderId);
        if (exits.some(o => o.status === 'fulfilled') && !exits.some(active)) {
          await patchOrder(parent.id, { bracket: { ...parent.bracket!, isCompleted: true }, protectionError: undefined });
        }
      }
    } finally { polling = false; }
  },
  async activateBracket(parent: TradeOrder, wallet: WalletState): Promise<void> {
    return orderExclusive(parent, () => this.activateBracketLocked(store.getOrders().find(o => o.id === parent.id) || parent, wallet));
  },
  async activateBracketLocked(parent: TradeOrder, wallet: WalletState) {
    if (parent.status !== 'fulfilled' || parent.bracket?.isCompleted) return;
    if (!parent.chainId || parent.buyDecimals === undefined || parent.sellDecimals === undefined) throw new Error('Cannot protect entry without verified decimals');
    if (!parent.executedBuyAmount || Number(parent.executedBuyAmount) <= 0) throw new Error('Waiting for confirmed executed entry quantity');
    const bracket = { ...parent.bracket! };
    let entryPrice = parent.executionPrice;
    if (!bracket.tpEnabled && !bracket.slEnabled) return;
    if (bracket.priceBasis === 'actual-fill') {
      const paid = Number(parent.executedSellAmount), received = Number(parent.executedBuyAmount);
      const rate = parent.executedQuoteUsdPrice || await orderQuoteUsdPrice(parent, parent.sellToken);
      const fillPrice = paid / received * rate;
      if (!Number.isFinite(fillPrice) || fillPrice <= 0) throw new Error('Waiting for confirmed entry fill price');
      if (bracket.tpEnabled) {
        if (!Number.isFinite(bracket.tpPercent) || bracket.tpPercent <= 0) throw new Error('Invalid take-profit percentage');
        bracket.tpPrice = fillPrice * (1 + bracket.tpPercent / 100);
      }
      if (bracket.slEnabled) {
        if (!Number.isFinite(bracket.slPercent) || bracket.slPercent <= 0 || bracket.slPercent >= 100) throw new Error('Invalid stop-loss percentage');
        bracket.slPrice = fillPrice * (1 - bracket.slPercent / 100);
      }
      entryPrice = fillPrice;
      await patchOrder(parent.id, { executionPrice: fillPrice, executedQuoteUsdPrice: rate, executedQuotePriceTimestamp: parent.executedQuotePriceTimestamp || Date.now(), bracket });
    }
    const signer = web3.getSigner(wallet.address, parent.chainId);
    const quantity = parent.executedBuyAmount;
    const stopId = bracket.slOrderId || `sl_${parent.id}`;
    const base: TradeOrder = {
      tradeSide: 'sell', quoteTokenAddress: parent.quoteTokenAddress,
      id: '', timestamp: Date.now(), type: 'TOKEN_SWAP', ownerAddress: wallet.address, chainId: parent.chainId, parentOrderId: parent.id,
      sellToken: parent.buyToken, buyToken: parent.sellToken, sellSymbol: parent.buySymbol, buySymbol: parent.sellSymbol,
      sellDecimals: parent.buyDecimals, buyDecimals: parent.sellDecimals, sellAmount: quantity, buyAmount: '0', executionPrice: 0,
      status: 'pending', feeAmount: '0', validTo: Math.floor(Date.now() / 1000) + 30 * 86400, explorerUrl: '', ocoGroupId: parent.ocoGroupId,
    };
    // Persist stop before trying a possibly slow/rejected TP or approval.
    if (bracket.slEnabled && !store.getOrders().some(o => o.id === stopId)) {
      if (!(Number.isFinite(bracket.slPrice) && bracket.slPrice > 0)) throw new Error('Invalid stop price for entry fill');
      await addOrder({ ...base, id: stopId, status: 'open', orderCategory: 'stop_loss', isConditional: true, triggerPrice: bracket.slPrice, limitPrice: bracket.slPrice, validTo: 0 });
      bracket.slOrderId = stopId;
      await patchOrder(parent.id, { bracket });
    }
    const existingTp = store.getOrders().find(o => o.id === bracket.tpOrderId);
    const existingStop = store.getOrders().find(o => o.id === stopId);
    if (existingTp?.status === 'fulfilled' || existingStop?.triggerTimestamp) return;
    if (existingTp?.submissionError) throw new Error(`Take-profit was rejected: ${existingTp.submissionError}`);
    if (existingTp && !active(existingTp)) {
      // Query CoW again before replacing a closed TP.
      const outcome = await invalidate(existingTp, wallet);
      if (outcome === 'filled') return;
      bracket.tpOrderId = undefined;
      await patchOrder(parent.id, { bracket });
    }
    if (bracket.tpEnabled && !bracket.tpOrderId) {
      if (!(bracket.tpPrice > entryPrice)) throw new Error('Take-profit price must exceed entry fill price');
      await web3.ensureAllowance(wallet.address, parent.buyToken, ethers.parseUnits(quantity, parent.buyDecimals), parent.chainId);
      const quoteUsdPrice = await orderQuoteUsdPrice(parent, parent.sellToken);
      const receive = quoteForQuantityUsd(quantity, bracket.tpPrice, quoteUsdPrice, parent.buyDecimals, parent.sellDecimals);
      if (bracket.takeProfitValidity === 'maximum') base.validTo = 0xffffffff;
      await cow.submitLimitOrder({ sellToken: base.sellToken, buyToken: base.buyToken, sellAmountWei: ethers.parseUnits(quantity, parent.buyDecimals).toString(), buyAmountWei: ethers.parseUnits(receive, parent.sellDecimals).toString(), signer, chainId: parent.chainId, validTo: base.validTo,
        onPrepared: async uid => {
          await addOrder({ ...base, quoteUsdPrice, id: uid, buyAmount: receive, orderCategory: 'take_profit', limitPrice: bracket.tpPrice, connectedOrderId: bracket.slEnabled ? stopId : undefined, explorerUrl: cow.getExplorerUrl(uid) });
          bracket.tpOrderId = uid; bracket.isTriggered = true;
          await patchOrder(parent.id, { bracket, protectionError: undefined });
          if (bracket.slEnabled) await patchOrder(stopId, { connectedOrderId: uid });
        },
      });
    }
  },
  async evaluateStop(stop: TradeOrder, wallet: WalletState): Promise<void> {
    return orderExclusive(stop, () => this.evaluateStopLocked(stop, wallet));
  },
  async evaluateStopLocked(stop: TradeOrder, wallet: WalletState) {
    stop = store.getOrders().find(o => o.id === stop.id) || stop;
    if (!active(stop)) return;
    const sibling = store.getOrders().find(o => o.id === stop.connectedOrderId);
    if (sibling?.status === 'fulfilled' || ocoPeers(stop).some(o => !o.isConditional && o.status === 'fulfilled')) {
      await patchOrder(stop.id, { status: 'cancelled' }); return;
    }
    // Existing triggered exit is reconciled by normal polling, including after restart.
    const exit = store.getOrders().find(o => o.previousOrderId === stop.id && active(o));
    if (exit) return;
    const filledExit = store.getOrders().find(o => o.previousOrderId === stop.id && o.status === 'fulfilled');
    if (filledExit) { await patchOrder(stop.id, { status: 'cancelled' }); return; }
    if (!stop.triggerTimestamp) {
      const token = tokenFor(stop);
      const price = await market.fetchTokenPrice(token.address, token.chainId, token.binanceSymbol);
      if (!Number.isFinite(price.price) || price.price <= 0 || Date.now() - price.lastUpdated > 30000) throw new Error('Fresh stop-monitor price unavailable');
      if (price.price > (stop.triggerPrice || stop.limitPrice || 0)) return;
      await patchOrder(stop.id, { triggerTimestamp: Date.now() });
    }
    if (await cancelProtectionIfEmpty(stop, wallet)) return;
    // Independent prerequisites run together. OCO cancellation follows a fill,
    // never the trigger. Drain both tasks even on failure before releasing lock.
    const [allowanceResult, quoteResult] = await Promise.allSettled([
      web3.ensureAllowance(wallet.address, stop.sellToken, ethers.parseUnits(stop.sellAmount, stop.sellDecimals), stop.chainId!),
      cow.getQuote({ sellToken: stop.sellToken, buyToken: stop.buyToken, amount: stop.sellAmount, kind: 'sell', from: wallet.address, chainId: stop.chainId, sellTokenDecimals: stop.sellDecimals, buyTokenDecimals: stop.buyDecimals, fresh: true })
        .then(quote => ({ quote, receivedAt: Date.now() })),
    ]);
    if (allowanceResult.status === 'rejected') throw allowanceResult.reason;
    if (quoteResult.status === 'rejected') throw quoteResult.reason;
    // An approval transaction can outlast the concurrently requested quote.
    const quote = Date.now() - quoteResult.value.receivedAt <= 5000 ? quoteResult.value.quote :
      await cow.getQuote({ sellToken: stop.sellToken, buyToken: stop.buyToken, amount: stop.sellAmount, kind: 'sell', from: wallet.address, chainId: stop.chainId, sellTokenDecimals: stop.sellDecimals, buyTokenDecimals: stop.buyDecimals, fresh: true });
    const canSubmit = () => nativeStore.getWallet()?.address === wallet.address && nativeStore.isHealthy() &&
      active(store.getOrders().find(o => o.id === stop.id) || { ...stop, status: 'cancelled' }) &&
      !ocoPeers(stop).some(o => !o.isConditional && o.status === 'fulfilled');
    if (!canSubmit()) return;
    await cow.signAndSubmitOrder(quote, web3.getSigner(wallet.address, stop.chainId), stop.chainId,
      async uid => {
        if (!canSubmit()) throw new Error('Stop submission stopped: wallet/order changed or opposite order filled');
        await addOrder({ ...stop, quoteUsdPrice: undefined, executionPrice: 0, id: uid, isConditional: false, status: 'pending', previousOrderId: stop.id, limitPrice: undefined, triggerPrice: undefined, buyAmount: ethers.formatUnits(quote.quote.buyAmount, stop.buyDecimals), validTo: quote.quote.validTo, explorerUrl: cow.getExplorerUrl(uid), protectionError: undefined });
        await patchOrder(stop.id, { protectionError: undefined });
      });
  },
};
