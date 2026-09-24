import { getChainConfig } from '../types/chains';
import type { TradeOrder } from '../types/trading';

export type OrderHistoryTab = 'WAITING' | 'FILLED' | 'CANCELLED';
export type NativeUsdSnapshot = { chainId: number; price: number; timestamp: number };

const positive = (value: string | undefined) => Number.isFinite(Number(value)) && Number(value) > 0;

/** Filled rows use fill evidence, never the time the order was placed. */
export function orderHistoryTime(order: TradeOrder): number | undefined {
  const times = order.status === 'fulfilled' ? [order.settlementTimestamp, order.fillTimestamp] : [order.timestamp];
  return times.find((time): time is number => Number.isFinite(time) && Number(time) > 0);
}

/** Correct the old standalone-sell label for display without rewriting signed orders. */
export function displayOrderCategory(order: TradeOrder, orders: TradeOrder[]): TradeOrder['orderCategory'] {
  if (order.orderCategory !== 'take_profit' || !order.quoteTokenAddress || order.connectedOrderId) return order.orderCategory;
  const related = orders.filter(o => o.chainId === order.chainId && o.ownerAddress?.toLowerCase() === order.ownerAddress?.toLowerCase());
  const parent = related.find(o => o.id === order.parentOrderId);
  if (parent?.bracket?.tpEnabled || related.some(o => o.isConditional &&
    (o.connectedOrderId === order.id || (!!order.ocoGroupId && o.ocoGroupId === order.ocoGroupId)))) return order.orderCategory;
  if (order.automationRequestId || (parent && !parent.bracket) || (!order.parentOrderId && order.tradeSide === 'sell')) return 'limit_sell';
  return order.orderCategory;
}

/** A signed token ratio has a moving USD value. Local stop triggers stay in USD. */
export function orderLimitPriceUsd(order: TradeOrder, native?: NativeUsdSnapshot): number | undefined {
  if (order.isConditional) {
    const trigger = order.triggerPrice || order.limitPrice;
    return Number.isFinite(trigger) && Number(trigger) > 0 ? trigger : undefined;
  }
  const rate = currentQuoteUsdRate(order, native);
  const sell = Number(order.sellAmount), buy = Number(order.buyAmount);
  if (rate === undefined || !positive(order.sellAmount) || !positive(order.buyAmount)) return undefined;
  const price = (historyTokenSide(order) === 'buy' ? sell / buy : buy / sell) * rate;
  return Number.isFinite(price) && price > 0 ? price : undefined;
}

function currentQuoteUsdRate(order: TradeOrder, native?: NativeUsdSnapshot): number | undefined {
  if (!order.chainId) return undefined;
  const chain = getChainConfig(order.chainId);
  const quote = (historyTokenSide(order) === 'buy' ? order.sellToken : order.buyToken).toLowerCase();
  if (!order.quoteTokenAddress && quote === chain.usdtToken.address.toLowerCase()) return 1;
  if (quote !== chain.nativeToken.wrappedAddress.toLowerCase() || native?.chainId !== order.chainId ||
    !Number.isFinite(native.price) || native.price <= 0 || !Number.isFinite(native.timestamp) ||
    Date.now() - native.timestamp >= 30000 || native.timestamp > Date.now() + 1000) return undefined;
  return native.price;
}

export function historyTokenSide(order: TradeOrder): 'buy' | 'sell' {
  if (order.tradeSide) return order.tradeSide;
  if (['limit', 'strategy_buy'].includes(order.orderCategory || '') || order.type === 'USDT_TO_BNB') return 'buy';
  if (['limit_sell', 'take_profit', 'stop_loss', 'strategy_sell'].includes(order.orderCategory || '') || order.type === 'BNB_TO_USDT') return 'sell';
  if (order.chainId && order.sellToken.toLowerCase() === getChainConfig(order.chainId).nativeToken.wrappedAddress.toLowerCase()) return 'buy';
  return /^(USDT|USDC)(_|$)|^(DAI|WXDAI|FDUSD)$/.test(order.sellSymbol || '') ? 'buy' : 'sell';
}

/** Display pending intent/quote prices without writing them into confirmed execution data. */
export function historyPrice(order: TradeOrder, native?: NativeUsdSnapshot): number | undefined {
  const valid = (value: number | undefined): value is number => Number.isFinite(value) && Number(value) > 0;
  if (order.status === 'fulfilled') return valid(order.executionPrice) ? order.executionPrice : undefined;
  if (order.status === 'open' || order.status === 'pending') return orderLimitPriceUsd(order, native);
  if (order.isConditional && valid(order.triggerPrice)) return order.triggerPrice;
  if (valid(order.limitPrice)) return order.limitPrice;
  if (valid(order.executionPrice)) return order.executionPrice;
  // Submitted market stops have no limit/trigger field; their persisted quote has both amounts.
  const sell = Number(order.sellAmount), buy = Number(order.buyAmount);
  if (!(valid(sell) && valid(buy))) return undefined;
  const price = historyTokenSide(order) === 'buy' ? sell / buy : buy / sell;
  const rate = quoteUsdRate(order);
  return valid(price) && rate !== undefined ? price * rate : undefined;
}

export function orderHistoryTab(order: TradeOrder): OrderHistoryTab {
  if (order.status === 'fulfilled') return 'FILLED';
  if (order.status === 'cancelled' || order.status === 'expired') return 'CANCELLED';
  return 'WAITING';
}

/** User-visible IDs are the allocated AA1-ZZ9 tags, never CoW/internal UIDs. */
export function userOrderId(order: TradeOrder): string | undefined {
  const candidate = order.externalOrderId || order.ocoGroupId;
  return candidate && /^[A-Z]{2}[1-9]$/i.test(candidate) ? candidate.toUpperCase() : undefined;
}

/**
 * Calculates realized exit PnL only from confirmed executed amounts. Parent cost
 * is allocated once across linked exits in settlement order, including partials.
 */
export function buildFilledExitPnls(orders: TradeOrder[]): Map<string, number> {
  const fulfilled = orders.filter(order => order.status === 'fulfilled' && !order.isConditional &&
    positive(order.executedSellAmount) && positive(order.executedBuyAmount));
  const usedParentQuantity = new Map<string, number>();
  const pnlByOrder = new Map<string, number>();

  for (const exit of fulfilled.slice().sort((a, b) =>
    (a.settlementTimestamp || a.fillTimestamp || a.timestamp) - (b.settlementTimestamp || b.fillTimestamp || b.timestamp))) {
    const parent = fulfilled.find(candidate => candidate.id === exit.parentOrderId &&
      candidate.buyToken.toLowerCase() === exit.sellToken.toLowerCase() &&
      candidate.sellToken.toLowerCase() === exit.buyToken.toLowerCase() &&
      candidate.chainId === exit.chainId &&
      candidate.ownerAddress?.toLowerCase() === exit.ownerAddress?.toLowerCase());
    if (!parent) continue;

    const exitQuantity = Number(exit.executedSellAmount);
    const parentQuantity = Number(parent.executedBuyAmount);
    const allocated = usedParentQuantity.get(parent.id) || 0;
    if (allocated + exitQuantity > parentQuantity * (1 + 1e-12)) continue;
    usedParentQuantity.set(parent.id, allocated + exitQuantity);
    const parentRate = quoteUsdRate(parent), exitRate = quoteUsdRate(exit);
    if (parentRate === undefined || exitRate === undefined) continue;
    const allocatedCost = Number(parent.executedSellAmount) * parentRate * exitQuantity / parentQuantity;
    pnlByOrder.set(exit.id, Number(exit.executedBuyAmount) * exitRate - allocatedCost);
  }

  return pnlByOrder;
}

/** Legacy stablecoin history keeps its old USD basis; new fills require an observed conversion. */
export function quoteUsdRate(order: TradeOrder): number | undefined {
  const rate = order.status === 'fulfilled' ? order.executedQuoteUsdPrice : order.quoteUsdPrice;
  if (Number.isFinite(rate) && Number(rate) > 0) return rate;
  if (order.quoteTokenAddress) return undefined;
  const quoteAddress = historyTokenSide(order) === 'buy' ? order.sellToken : order.buyToken;
  if (order.chainId && quoteAddress.toLowerCase() === getChainConfig(order.chainId).usdtToken.address.toLowerCase()) return 1;
  const symbol = historyTokenSide(order) === 'buy' ? order.sellSymbol : order.buySymbol;
  return /^(USDT|USDC)(_|$)|^(DAI|WXDAI|FDUSD)$/.test(symbol || '') ? 1 : undefined;
}

export function orderAmountUsd(order: TradeOrder, side: 'sell' | 'buy', native?: NativeUsdSnapshot): number | undefined {
  const amount = Number(order.status === 'fulfilled'
    ? side === 'sell' ? order.executedSellAmount : order.executedBuyAmount
    : side === 'sell' ? order.sellAmount : order.buyAmount);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const quoteSide = historyTokenSide(order) === 'buy' ? 'sell' : 'buy';
  const rate = side === quoteSide ? (order.status === 'open' || order.status === 'pending' ? currentQuoteUsdRate(order, native) : quoteUsdRate(order)) : historyPrice(order, native);
  return rate === undefined ? undefined : amount * rate;
}
