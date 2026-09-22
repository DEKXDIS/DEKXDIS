import { getChainConfig } from '../types/chains';
import type { TradeOrder } from '../types/trading';

export type OrderHistoryTab = 'WAITING' | 'FILLED' | 'CANCELLED';

const positive = (value: string | undefined) => Number.isFinite(Number(value)) && Number(value) > 0;

export function historyTokenSide(order: TradeOrder): 'buy' | 'sell' {
  if (order.tradeSide) return order.tradeSide;
  if (['limit', 'strategy_buy'].includes(order.orderCategory || '') || order.type === 'USDT_TO_BNB') return 'buy';
  if (['limit_sell', 'take_profit', 'stop_loss', 'strategy_sell'].includes(order.orderCategory || '') || order.type === 'BNB_TO_USDT') return 'sell';
  if (order.chainId && order.sellToken.toLowerCase() === getChainConfig(order.chainId).nativeToken.wrappedAddress.toLowerCase()) return 'buy';
  return /^(USDT|USDC)(_|$)|^(DAI|WXDAI|FDUSD)$/.test(order.sellSymbol || '') ? 'buy' : 'sell';
}

/** Display pending intent/quote prices without writing them into confirmed execution data. */
export function historyPrice(order: TradeOrder): number | undefined {
  const valid = (value: number | undefined): value is number => Number.isFinite(value) && Number(value) > 0;
  if (order.status === 'fulfilled') return valid(order.executionPrice) ? order.executionPrice : undefined;
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

export function orderAmountUsd(order: TradeOrder, side: 'sell' | 'buy'): number | undefined {
  const amount = Number(order.status === 'fulfilled'
    ? side === 'sell' ? order.executedSellAmount : order.executedBuyAmount
    : side === 'sell' ? order.sellAmount : order.buyAmount);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const quoteSide = historyTokenSide(order) === 'buy' ? 'sell' : 'buy';
  const rate = side === quoteSide ? quoteUsdRate(order) : historyPrice(order);
  return rate === undefined ? undefined : amount * rate;
}
