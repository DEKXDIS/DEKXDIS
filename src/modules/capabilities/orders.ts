import { requireStrategiesEnabled } from '../../services/strategyAvailability';
import { assertTradingPair, tradingQuoteUsdPrice } from '../../services/tradingQuote';
import { ethers } from 'ethers';
import type { TokenConfig, TradeBracketConfig, TradeOrder, WalletState } from '../../types/trading';
import { getChainConfig, getTradingQuoteToken } from '../../types/chains';
import { cowProtocol } from '../../services/cowProtocol';
import { executionEngine, exclusive } from '../../services/executionEngine';
import { nativeStore } from '../../services/nativeStore';
import { storageService as store } from '../../services/storageService';
import { web3Service } from '../../services/web3Service';
import { quantityForUsd, quoteForQuantityUsd } from '../../utils/amounts';
import { getNextOcoTag, recordAllocatedOcoTag } from '../../utils/ocoUtils';
import type { ModuleFunding } from '../contracts';

export interface ModuleOrderScope {
  moduleId: string;
  moduleVersion: string;
  packageHash: string;
  runId: string;
  configurationRevision?: number;
  priorPackages?: { moduleVersion: string; packageHash: string }[];
  wallet: WalletState;
  token: TokenConfig;
  chainId: number;
  /** Supplied by the host, never by package code. Includes installation/run/credential generation. */
  isCurrent(): boolean | Promise<boolean>;
}

export interface ModuleLimitEntry {
  price: number;
  quoteAmount: string;
  protection?: {
    /** Each value is an absolute quote price or a percent from confirmed entry fill. */
    basis: 'fixed' | 'actual-fill';
    takeProfit?: number;
    stopLoss?: number;
    takeProfitValidity?: 'maximum';
  };
}

export interface ModuleEntryAuthorization extends ModuleOrderScope {
  intentId: string;
  /** These limits come from the user's Start authorization, never package state. */
  budget: { maxOrders: number; maxQuoteAmount: string; maxQuotePerOrder: string; maxOpenOrders: number;
    orderExpirySeconds: number; maxSlippageBps: number };
  request: ModuleLimitEntry;
}

interface ConsumedIntent {
  kind?: 'exit';
  configurationRevision?: number;
  key: string;
  runKey: string;
  quoteWei: string;
  maxOrders: number;
  maxQuoteWei: string;
  authorization: string;
  order: TradeOrder;
}

// This wallet-scoped ledger is intentionally independent of module state and visible order history.
// Removing code, clearing history, or changing an intent id must never reset consumed authorization.
const LEDGER_KEY = 'haven_defi_terminal_module_order_intents_v1';
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const intentIdentifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;
const amount = /^\d+(?:\.\d+)?$/;
function intents(): ConsumedIntent[] {
  const records: unknown = JSON.parse(nativeStore.getItem(LEDGER_KEY) || '[]');
  if (!Array.isArray(records) || records.some(record => !record || typeof record.key !== 'string' ||
      typeof record.runKey !== 'string' || !/^\d+$/.test(record.quoteWei) ||
      !Number.isSafeInteger(record.maxOrders) || !/^\d+$/.test(record.maxQuoteWei) ||
      typeof record.authorization !== 'string' || !record.order?.id)) {
    throw new Error('Module order intent ledger is invalid');
  }
  return records;
}

function validateScope(scope: ModuleOrderScope) {
  for (const value of [scope.moduleId, scope.moduleVersion, scope.runId]) {
    if (!identifier.test(value)) throw new Error('Invalid module order identity');
  }
  if (!/^[a-f0-9]{64}$/.test(scope.packageHash)) throw new Error('Invalid module package hash');
  if (!ethers.isAddress(scope.wallet.address) || !ethers.isAddress(scope.token.address)) throw new Error('Invalid module wallet or token address');
  if (scope.token.chainId !== scope.chainId) throw new Error('Module token chain mismatch');
  if (!Number.isInteger(scope.token.decimals) || scope.token.decimals < 0 || scope.token.decimals > 36) throw new Error('Invalid module token decimals');
  getChainConfig(scope.chainId);
}

function runKey(scope: ModuleOrderScope) {
  return [scope.wallet.address.toLowerCase(), scope.chainId, scope.token.address.toLowerCase(), scope.moduleId, scope.runId].join(':');
}

async function current(scope: ModuleOrderScope) {
  return nativeStore.isHealthy() && nativeStore.getWallet()?.address.toLowerCase() === scope.wallet.address.toLowerCase() &&
    await scope.isCurrent() && nativeStore.isHealthy() &&
    nativeStore.getWallet()?.address.toLowerCase() === scope.wallet.address.toLowerCase();
}

function bracketFor(request: ModuleLimitEntry): TradeBracketConfig | undefined {
  const protection = request.protection;
  if (!protection) return undefined;
  if (protection.basis !== 'fixed' && protection.basis !== 'actual-fill') throw new Error('Unsupported protection price basis');
  const tp = protection.takeProfit, sl = protection.stopLoss;
  if (protection.takeProfitValidity !== undefined && (protection.takeProfitValidity !== 'maximum' || tp === undefined)) throw new Error('Invalid take-profit validity');
  if (tp === undefined && sl === undefined) throw new Error('Protection must specify a take-profit or stop-loss');
  for (const value of [tp, sl]) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error('Protection values must be positive');
  if (protection.basis === 'fixed') {
    if (tp !== undefined && tp <= request.price) throw new Error('Fixed take-profit must exceed the entry limit');
    if (sl !== undefined && sl >= request.price) throw new Error('Fixed stop-loss must be below the entry limit');
  } else if (sl !== undefined && sl >= 100) throw new Error('Stop-loss percentage must be between 0 and 100');
  return {
    priceBasis: protection.basis === 'actual-fill' ? 'actual-fill' : undefined,
    ...(protection.takeProfitValidity ? { takeProfitValidity: protection.takeProfitValidity } : {}),
    tpEnabled: tp !== undefined, tpPercent: protection.basis === 'actual-fill' ? tp || 0 : 0,
    tpPrice: protection.basis === 'fixed' ? tp || 0 : 0,
    slEnabled: sl !== undefined, slPercent: protection.basis === 'actual-fill' ? sl || 0 : 0,
    slPrice: protection.basis === 'fixed' ? sl || 0 : 0,
  };
}

export class ModuleFundingError extends Error {
  constructor(public readonly funding: ModuleFunding) { super(funding.message); }
}

// Coalesce simultaneous observations, but never reuse a completed balance read.
const fundingReads = new Map<string, Promise<{ balance: bigint; quoteUsdPrice: number }>>();
async function fundingSnapshot(scope: ModuleOrderScope, quoteAmountUsd: string): Promise<ModuleFunding> {
  if (!amount.test(quoteAmountUsd) || quoteAmountUsd.length > 80 || Number(quoteAmountUsd) <= 0 || !Number.isFinite(Number(quoteAmountUsd))) {
    throw new Error('Funding check requires a positive USD amount');
  }
  const quote = getTradingQuoteToken(scope.chainId);
  const readKey = `${scope.wallet.address.toLowerCase()}:${scope.chainId}`;
  let read = fundingReads.get(readKey);
  if (!read) {
    read = (async () => {
      const quoteUsdPrice = await tradingQuoteUsdPrice(scope.chainId);
      const balance = await web3Service.getTokenBalanceWei(scope.wallet.address, quote.address, scope.chainId);
      return { balance, quoteUsdPrice };
    })();
    fundingReads.set(readKey, read);
    const clear = () => { if (fundingReads.get(readKey) === read) fundingReads.delete(readKey); };
    void read.then(clear, clear);
  }
  const { balance, quoteUsdPrice } = await read;
  if (!await current(scope)) throw new Error('Module stopped or changed during funding check');
  const spend = ethers.parseUnits(quantityForUsd(quoteAmountUsd, quoteUsdPrice, quote.decimals), quote.decimals);
  if (spend <= 0n) throw new Error('Funding amount is below token precision');
  const history = store.getOrders();
  const orders = [...history, ...intents().filter(record => !history.some(order => order.id === record.order.id)).map(record => record.order)];
  const reserved = orders.filter(order => (order.status === 'open' || order.status === 'pending') &&
    order.chainId === scope.chainId && (!order.ownerAddress || order.ownerAddress.toLowerCase() === scope.wallet.address.toLowerCase()) &&
    order.sellToken.toLowerCase() === quote.address.toLowerCase())
    .reduce((total, order) => total + ethers.parseUnits(order.sellAmount, quote.decimals), 0n);
  const available = balance > reserved ? balance - reserved : 0n;
  const format = (value: bigint) => (Number(ethers.formatUnits(value, quote.decimals)) * quoteUsdPrice).toFixed(2);
  const affordable = available / spend;
  return { status: available >= spend ? 'ready' : 'insufficient-funds',
    affordableOrders: Number(affordable > 20n ? 20n : affordable), chainId: scope.chainId,
    tokenAddress: quote.address, symbol: quote.symbol, decimals: quote.decimals, quoteUsdPrice,
    balance: ethers.formatUnits(balance, quote.decimals), reserved: ethers.formatUnits(reserved, quote.decimals),
    available: ethers.formatUnits(available, quote.decimals), required: ethers.formatUnits(spend, quote.decimals),
    balanceUsd: format(balance), reservedUsd: format(reserved), availableUsd: format(available), requiredUsd: quoteAmountUsd,
    message: `Insufficient unreserved quote balance for module: USD ${format(balance)} of ${quote.symbol} in wallet, ${format(reserved)} reserved by open orders, ${format(available)} available; this buy needs USD ${quoteAmountUsd}.` };
}

/** Read-only preflight; final authorization and exact reservation checks still run at submission. */
export async function observeModuleFunding(scope: ModuleOrderScope, quoteAmountUsd: string): Promise<ModuleFunding> {
  requireStrategiesEnabled(); validateScope(scope); assertTradingPair(scope.token.address, scope.chainId);
  if (!await current(scope)) throw new Error('Module stopped or changed before funding check');
  return fundingSnapshot(scope, quoteAmountUsd);
}

/** Package evaluation/data/HTTP completes before calling this serialized privileged boundary. */
export async function executeLimitEntry(input: ModuleEntryAuthorization, onOrderPlaced: (order: TradeOrder) => void = () => {}): Promise<TradeOrder | null> {
  requireStrategiesEnabled();
  // Capture the authorization before yielding; a caller cannot mutate a queued request or budget.
  const scope: ModuleEntryAuthorization = { ...input, wallet: { ...input.wallet }, token: { ...input.token },
    budget: { ...input.budget }, request: { ...input.request, protection: input.request.protection && { ...input.request.protection } } };
  validateScope(scope);
  if (!intentIdentifier.test(scope.intentId)) throw new Error('Invalid module order intent id');
  const request = scope.request;
  if (!Number.isFinite(request.price) || request.price <= 0) throw new Error('Module buy price must be positive');
  if (!amount.test(request.quoteAmount) || !amount.test(scope.budget.maxQuoteAmount) || !amount.test(scope.budget.maxQuotePerOrder)) throw new Error('Module quote amounts must be decimal strings');
  for (const [key, min, max] of [['maxOrders', 0, Number.MAX_SAFE_INTEGER], ['maxOpenOrders', 0, Number.MAX_SAFE_INTEGER],
    ['orderExpirySeconds', 60, 2592000], ['maxSlippageBps', 1, 500]] as const) {
    if (!Number.isSafeInteger(scope.budget[key]) || scope.budget[key] < min || scope.budget[key] > max) throw new Error(`Invalid module order budget: ${key}`);
  }
  const chain = getChainConfig(scope.chainId);
  assertTradingPair(scope.token.address, scope.chainId);
  const quoteToken = getTradingQuoteToken(scope.chainId);
  const budgetSpend = ethers.parseUnits(request.quoteAmount, chain.usdtToken.decimals);
  if (budgetSpend <= 0n) throw new Error('Module order amount must be positive');
  const quantity = quantityForUsd(request.quoteAmount, request.price, scope.token.decimals);
  const buyWei = ethers.parseUnits(quantity, scope.token.decimals);
  if (buyWei <= 0n) throw new Error('Module order quantity is below token precision');
  const requestedQuote = ethers.parseUnits(request.quoteAmount, 18) * 10n ** BigInt(scope.token.decimals) * 10000n;
  const pricedQuantity = buyWei * ethers.parseUnits(request.price.toFixed(18), 18) * BigInt(10000 + scope.budget.maxSlippageBps);
  if (requestedQuote > pricedQuantity) throw new Error('Token rounding exceeds the authorized slippage limit');
  const bracket = bracketFor(request);
  const run = runKey(scope);
  const revision = scope.configurationRevision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid module configuration revision');
  const key = `${run}:${scope.intentId}`;
  const authorization = JSON.stringify([scope.budget.maxOpenOrders, scope.budget.orderExpirySeconds, scope.budget.maxSlippageBps]);
  return exclusive(async () => {
    if (!await current(scope)) return null;
    const records = intents();
    const consumed = records.find(record => record.key === key);
    if (consumed) return null;
    const prior = records.filter(record => record.runKey === run && record.kind !== 'exit');
    if (prior.some(record => (record.configurationRevision ?? 1) > revision ||
      ((record.configurationRevision ?? 1) === revision && (record.authorization !== authorization ||
      record.order.moduleHash !== scope.packageHash || record.order.moduleVersion !== scope.moduleVersion)))) {
      throw new Error('Module run identity or authorization changed; start a new run');
    }
    let funding: ModuleFunding;
    try { funding = await fundingSnapshot(scope, request.quoteAmount); }
    catch (error) { if (!await current(scope)) return null; throw error; }
    const quoteUsdPrice = funding.quoteUsdPrice;
    const quoteAmount = funding.required;
    const spend = ethers.parseUnits(quoteAmount, quoteToken.decimals);
    if (!await current(scope)) return null;
    if (funding.status === 'insufficient-funds') throw new ModuleFundingError(funding);
    // Includes native installation/run validation immediately before requesting allowance.
    if (!await current(scope)) return null;
    await web3Service.ensureAllowance(scope.wallet.address, quoteToken.address, spend, scope.chainId);
    if (!await current(scope)) return null;
    const userOrderId = getNextOcoTag(store.getOrders());
    const order: TradeOrder = {
      id: '', timestamp: Date.now(), ownerAddress: scope.wallet.address, signalKey: key, strategyId: scope.moduleId,
      moduleId: scope.moduleId, moduleVersion: scope.moduleVersion, moduleHash: scope.packageHash,
      moduleRunId: scope.runId, moduleIntentId: scope.intentId,
      tradeSide: 'buy', quoteTokenAddress: quoteToken.address, quoteUsdPrice,
      type: 'TOKEN_SWAP', orderCategory: 'limit', ocoGroupId: userOrderId, limitPrice: request.price,
      sellToken: quoteToken.address, buyToken: scope.token.address, sellSymbol: quoteToken.symbol, buySymbol: scope.token.symbol,
      sellAmount: quoteAmount, buyAmount: quantity, executionPrice: request.price, status: 'pending', feeAmount: '0',
      validTo: Math.floor(Date.now() / 1000) + scope.budget.orderExpirySeconds, explorerUrl: '',
      sellDecimals: quoteToken.decimals, buyDecimals: scope.token.decimals, chainId: scope.chainId, bracket,
    };
    await cowProtocol.submitLimitOrder({ sellToken: order.sellToken, buyToken: order.buyToken, sellAmountWei: spend.toString(),
      buyAmountWei: buyWei.toString(), signer: web3Service.getSigner(scope.wallet.address, scope.chainId),
      chainId: scope.chainId, validTo: order.validTo,
      onPrepared: async uid => {
        if (!await current(scope)) throw new Error('Module stopped or changed before submission');
        order.id = uid; order.explorerUrl = cowProtocol.getExplorerUrl(uid);
        // Consume authorization before the existing CoW journal may send the signed payload.
        // Retain the full prepared order so recovery can restore it after an interrupted history write.
        nativeStore.setItem(LEDGER_KEY, JSON.stringify([...records, { key, runKey: run, quoteWei: budgetSpend.toString(),
          maxOrders: scope.budget.maxOrders, maxQuoteWei: '0', configurationRevision: revision, authorization, order } satisfies ConsumedIntent]));
        store.addOrder(order); recordAllocatedOcoTag(userOrderId);
        await nativeStore.flush();
      },
    });
    onOrderPlaced(order);
    return order;
  });
}

function mergedOrders(records = intents()): TradeOrder[] {
  const history = store.getOrders();
  return [...history, ...records.filter(record => !history.some(order => order.id === record.order.id)).map(record => record.order)];
}

function remainingPosition(parent: TradeOrder, orders: TradeOrder[]): bigint {
  if (parent.buyDecimals === undefined || !parent.executedBuyAmount) throw new Error('Position is missing confirmed quantity or decimals');
  const received = ethers.parseUnits(parent.executedBuyAmount, parent.buyDecimals);
  let sold = 0n;
  for (const exit of orders.filter(order => order.parentOrderId === parent.id)) {
    if (exit.chainId !== parent.chainId || exit.ownerAddress?.toLowerCase() !== parent.ownerAddress?.toLowerCase() ||
        exit.sellToken.toLowerCase() !== parent.buyToken.toLowerCase()) throw new Error('Position exit identity mismatch');
    if (exit.status === 'fulfilled' && !exit.executedSellAmount) throw new Error('Position exit is missing confirmed sold quantity');
    if (exit.executedSellAmount) sold += ethers.parseUnits(exit.executedSellAmount, parent.buyDecimals);
  }
  if (sold > received) throw new Error('Position sold quantity exceeds confirmed entry');
  return received - sold;
}

export interface ModuleLimitExit { parentOrderId: string; price: number; quantity?: string; }
export interface ModuleExitAuthorization extends ModuleOrderScope {
  intentId: string; orderExpirySeconds: number; request: ModuleLimitExit;
}

export class ModulePositionChangedError extends Error {
  constructor() { super('Confirmed sales changed the remaining position; checking orders again'); }
}

/**
 * The orders this run owns, as the program currently knows them.
 *
 * This is read, never waited on. Reconciling against the order book is a network round trip that
 * the execution engine already performs on its own schedule, so making a strategy wait for it here
 * put an order-book request in the middle of every cycle and charged the strategy for it. Statuses
 * this returns are therefore read-only statuses: the next cycle sees whatever the engine has
 * learned since.
 */
export async function refreshModuleOrders(scope: ModuleOrderScope) {
  validateScope(scope);
  if (!await current(scope)) throw new Error('Module stopped or changed before reading its orders');
  // Restore locally known unresolved orders only. No provider call, no signing, no replay.
  await recoverModuleOrderIntents(scope.wallet);
  if (!await current(scope)) throw new Error('Module stopped or changed while reading its orders');
}

/** Generic immediate limit sell of confirmed inventory acquired by this module run. */
export async function executeLimitExit(input: ModuleExitAuthorization): Promise<TradeOrder> {
  requireStrategiesEnabled();
  const scope = { ...input, wallet: { ...input.wallet }, token: { ...input.token }, request: { ...input.request } };
  validateScope(scope);
  if (!intentIdentifier.test(scope.intentId) || !scope.request.parentOrderId ||
      !Number.isFinite(scope.request.price) || scope.request.price <= 0) throw new Error('Invalid module exit request');
  if (!Number.isSafeInteger(scope.orderExpirySeconds) || scope.orderExpirySeconds < 60 || scope.orderExpirySeconds > 2592000) throw new Error('Invalid exit expiry');
  assertTradingPair(scope.token.address, scope.chainId);
  await refreshModuleOrders(scope);
  return exclusive(async () => {
    if (!await current(scope)) throw new Error('Module stopped or changed before sell');
    const records = intents(), orders = mergedOrders(records), run = runKey(scope), key = `${run}:${scope.intentId}`;
    const consumed = records.find(record => record.key === key);
    if (consumed) {
      if (consumed.kind !== 'exit' || consumed.order.parentOrderId !== scope.request.parentOrderId || consumed.order.limitPrice !== scope.request.price ||
          scope.request.quantity !== undefined && consumed.order.sellAmount !== scope.request.quantity) throw new Error('Module changed a consumed sell intent');
      return orders.find(order => order.id === consumed.order.id) || consumed.order;
    }
    const parent = orders.find(order => order.id === scope.request.parentOrderId);
    if (!parent || parent.parentOrderId || !strategyOrder(parent, scope, orders) || parent.status !== 'fulfilled') throw new Error('Module may sell only its own confirmed entry position');
    const quote = getTradingQuoteToken(scope.chainId);
    if (parent.sellToken.toLowerCase() !== quote.address.toLowerCase() || parent.buyDecimals !== scope.token.decimals) throw new Error('Position trading asset or decimals mismatch');
    if (parent.bracket && !parent.bracket.isCompleted) throw new Error('Cancel attached protection before requesting an independent sell');
    if (orders.some(order => order.parentOrderId === parent.id && ['pending', 'open'].includes(order.status))) throw new Error('Position already has a pending sell');
    const remaining = remainingPosition(parent, orders);
    if (remaining === 0n) throw new ModulePositionChangedError();
    const quantity = scope.request.quantity === undefined ? ethers.formatUnits(remaining, scope.token.decimals) : scope.request.quantity;
    if (!amount.test(quantity) || quantity.length > 80) throw new Error('Sell quantity must be a token amount');
    const spend = ethers.parseUnits(quantity, scope.token.decimals);
    if (spend <= 0n || spend > remaining) throw new Error('Sell exceeds remaining position quantity');
    const balance = await web3Service.getTokenBalanceWei(scope.wallet.address, scope.token.address, scope.chainId);
    const currentOrders = mergedOrders();
    if (remainingPosition(parent, currentOrders) !== remaining) throw new ModulePositionChangedError();
    const reserved = currentOrders.filter(order => order.chainId === scope.chainId && ['pending', 'open'].includes(order.status) &&
      (!order.ownerAddress || order.ownerAddress.toLowerCase() === scope.wallet.address.toLowerCase()) && order.sellToken.toLowerCase() === scope.token.address.toLowerCase())
      .reduce((sum, order) => sum + ethers.parseUnits(order.sellAmount, scope.token.decimals), 0n);
    if (spend + reserved > balance) throw new Error('Insufficient unreserved token balance for module sell');
    const quoteUsdPrice = await tradingQuoteUsdPrice(scope.chainId);
    const receive = quoteForQuantityUsd(quantity, scope.request.price, quoteUsdPrice, scope.token.decimals, quote.decimals);
    if (!await current(scope)) throw new Error('Module stopped or changed before sell allowance');
    await web3Service.ensureAllowance(scope.wallet.address, scope.token.address, spend, scope.chainId);
    if (!await current(scope)) throw new Error('Module stopped or changed before sell signing');
    if (remainingPosition(parent, mergedOrders()) !== remaining) throw new ModulePositionChangedError();
    const order: TradeOrder = {
      id: '', timestamp: Date.now(), ownerAddress: scope.wallet.address, signalKey: key, strategyId: scope.moduleId,
      moduleId: scope.moduleId, moduleVersion: scope.moduleVersion, moduleHash: scope.packageHash,
      moduleRunId: scope.runId, moduleIntentId: scope.intentId, parentOrderId: parent.id,
      tradeSide: 'sell', quoteTokenAddress: quote.address, quoteUsdPrice, type: 'TOKEN_SWAP', orderCategory: 'limit_sell',
      ocoGroupId: parent.ocoGroupId, limitPrice: scope.request.price, sellToken: scope.token.address, buyToken: quote.address,
      sellSymbol: scope.token.symbol, buySymbol: quote.symbol, sellAmount: quantity, buyAmount: receive,
      sellDecimals: scope.token.decimals, buyDecimals: quote.decimals, executionPrice: scope.request.price,
      status: 'pending', feeAmount: '0', validTo: Math.floor(Date.now() / 1000) + scope.orderExpirySeconds, explorerUrl: '', chainId: scope.chainId,
    };
    await cowProtocol.submitLimitOrder({ sellToken: order.sellToken, buyToken: order.buyToken, sellAmountWei: spend.toString(),
      buyAmountWei: ethers.parseUnits(receive, quote.decimals).toString(), signer: web3Service.getSigner(scope.wallet.address, scope.chainId),
      chainId: scope.chainId, validTo: order.validTo, onPrepared: async uid => {
        if (!await current(scope)) throw new Error('Module stopped or changed before sell submission');
        order.id = uid; order.explorerUrl = cowProtocol.getExplorerUrl(uid);
        const updated = records.map(record => ({ ...record, order: orders.find(item => item.id === record.order.id) || record.order }));
        nativeStore.setItem(LEDGER_KEY, JSON.stringify([...updated, { kind: 'exit', key, runKey: run, quoteWei: '0', maxOrders: 0,
          maxQuoteWei: '0', configurationRevision: scope.configurationRevision ?? 1, authorization: JSON.stringify(scope.request), order } satisfies ConsumedIntent]));
        store.addOrder(order); await nativeStore.flush();
      } });
    return order;
  });
}

/**
 * Orders this strategy placed on this workspace's token, whenever it placed them.
 *
 * Belonging to the current run alone was too narrow to be useful: after starting a fresh run — which
 * every module update forces — the strategy could not see the orders already working on its own
 * chart. It reported an empty grid, counted no levels, and so was never in a position to move or
 * cancel anything, while the orders sat there live and invisible to it. What matters is that the
 * order is this strategy's own work on this token: a manual trade carries no module identity and is
 * still never visible, and is still never touchable.
 */
function strategyOrder(order: TradeOrder, scope: ModuleOrderScope, orders: TradeOrder[], seen = new Set<string>()): boolean {
  if (seen.size >= 8 || seen.has(order.id) || order.chainId !== scope.chainId ||
      order.ownerAddress?.toLowerCase() !== scope.wallet.address.toLowerCase() ||
      order.buyToken.toLowerCase() !== scope.token.address.toLowerCase()) return false;
  seen.add(order.id);
  const knownPackage = [{ moduleVersion: scope.moduleVersion, packageHash: scope.packageHash }, ...(scope.priorPackages ?? [])]
    .some(p => p.moduleVersion === order.moduleVersion && p.packageHash === order.moduleHash);
  if (order.moduleId === scope.moduleId && knownPackage) return true;
  const parent = orders.find(candidate => candidate.id === (order.parentOrderId || order.previousOrderId));
  return !!parent && strategyOrder(parent, scope, orders, seen);
}

export function observeModuleOrders(scope: ModuleOrderScope) {
  validateScope(scope);
  if (!nativeStore.isHealthy() || nativeStore.getWallet()?.address.toLowerCase() !== scope.wallet.address.toLowerCase()) throw new Error('Module wallet is unavailable');
  const orders = mergedOrders();
  return orders.filter(order => strategyOrder(order, scope, orders)).map(order => ({
    id: order.id, parentOrderId: order.parentOrderId, intentId: order.moduleIntentId, timestamp: order.timestamp,
    status: order.status, category: order.orderCategory, limitPrice: order.limitPrice,
    takeProfitPrice: order.bracket?.tpPrice,
    remainingQuantity: !order.parentOrderId && order.status === 'fulfilled' && !order.bracket ? ethers.formatUnits(remainingPosition(order, orders), order.buyDecimals) : undefined,
    positionClosed: order.bracket?.isCompleted === true || (!order.parentOrderId && order.status === 'fulfilled' && !order.bracket && remainingPosition(order, orders) === 0n),
    executedBuyAmount: order.executedBuyAmount, executedSellAmount: order.executedSellAmount,
    executionPrice: order.status === 'fulfilled' ? order.executionPrice : undefined,
    settlementTimestamp: order.settlementTimestamp, protectionError: order.protectionError,
  }));
}

/** Cancellation always uses the existing CoW confirmation and OCO handling. */
export async function cancelModuleOrder(scope: ModuleOrderScope, orderId: string) {
  validateScope(scope);
  if (!await current(scope)) throw new Error('Module stopped or changed before cancellation');
  const orders = store.getOrders();
  const order = orders.find(candidate => candidate.id === orderId);
  if (!order || !strategyOrder(order, scope, orders)) throw new Error('Module may cancel only its own orders');
  await executionEngine.cancel(orderId, scope.wallet);
  const latest = store.getOrders().find(candidate => candidate.id === orderId);
  return { id: orderId, status: latest?.status };
}

/** Restore unresolved base-owned parents before CoW's existing UID recovery/status monitor runs. */
export async function recoverModuleOrderIntents(wallet: WalletState): Promise<number> {
  return exclusive(async () => {
    if (!nativeStore.isHealthy() || nativeStore.getWallet()?.address.toLowerCase() !== wallet.address.toLowerCase()) return 0;
    const records = intents(), orders = store.getOrders();
    let restored = 0, changed = false;
    for (const record of records) {
      if (record.order.ownerAddress?.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('Module intent ledger wallet mismatch');
      const live = orders.find(order => order.id === record.order.id);
      if (live) {
        // Remember confirmed closure, so clearing terminal history does not resurrect it.
        if (JSON.stringify(record.order) !== JSON.stringify(live)) { record.order = live; changed = true; }
      } else if (['pending', 'open'].includes(record.order.status) ||
        (record.order.status === 'fulfilled' && record.order.bracket && !record.order.bracket.isCompleted)) {
        // No signing or replay here. The ordinary engine owns polling, exact-journal replay and protection.
        orders.push(record.order); restored++;
      }
    }
    if (changed) nativeStore.setItem(LEDGER_KEY, JSON.stringify(records));
    if (restored) store.saveOrders(orders);
    if (changed || restored) await nativeStore.flush();
    return restored;
  });
}
