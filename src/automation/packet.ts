import { ethers } from 'ethers';
import type { TradeOrder } from '../types/trading';
import type { Workspace } from './settings';
import type { OrderCommand } from '../services/orderPlacement';
import { historyTokenSide } from '../utils/orderHistory';
import { getTradingQuoteToken } from '../types/chains';
import { positionLots } from '../utils/positions';

export const RESPONSE_FORMAT = `Return only JSON: {"reason":"brief explanation", "orders":[{"side":"buy", "price":1.23, "amount":"10", "amountUnit":"usd", "takeProfitPrice":1.4, "stopLossPrice":1.1}]}.
To sell a bought position, use {"side":"sell","price":1.4,"positionId":"the entry.id from openPositions"}. The application sells that buy's actual remaining available token quantity, not the original USD spending amount. Omit amount and amountUnit for position sells. If positionId is omitted, the oldest available buy is selected. Each sell closes one available bought position; submit separate sells for multiple positions. Positions reserved for TP, SL or an existing sell cannot be sold again. Pending sells do not count as sold until they fill.
An empty orders array means wait. Each order is for the supplied workspace token. side is buy or sell. price, takeProfitPrice and stopLossPrice are positive USD display prices; actual settlement is in tokens. Buy amount is a positive decimal string, amountUnit is usd or token. In fixed amount mode the application uses the user's amount and unit for buys only. TP and SL are individually optional. Buy protections activate after a confirmed fill. A position sell is a limit sell by default; sellKind:"stop" creates a conditional stop. For a limit sell, stopLossPrice adds its OCO stop; for a stop sell, takeProfitPrice adds its OCO limit. Do not set takeProfitPrice on a limit sell or stopLossPrice on a stop sell: price already specifies that leg. Follow the user's instructions and supplied settings. No other response fields or actions are supported.`;

export function workspaceOrders(orders: TradeOrder[], w: Workspace) {
  return orders.filter(o => o.ownerAddress?.toLowerCase() === w.owner.toLowerCase() && o.chainId === w.chainId &&
    (o.buyToken.toLowerCase() === w.token.address.toLowerCase() || o.sellToken.toLowerCase() === w.token.address.toLowerCase()));
}
export const working = (o: TradeOrder) => o.status === 'open' || o.status === 'pending';
export const openBuyCount = (orders: TradeOrder[], w: Workspace) => workspaceOrders(orders, w)
  .filter(o => working(o) && o.buyToken.toLowerCase() === w.token.address.toLowerCase()).length;
export function describeOrder(o: TradeOrder) {
  const side = historyTokenSide(o), sold = Number(o.executedSellAmount), received = Number(o.executedBuyAmount);
  const averageFillPriceQuote = sold > 0 && received > 0 && Number.isFinite(sold) && Number.isFinite(received)
    ? side === 'buy' ? sold / received : received / sold : null;
  const fillRate = Number(o.executedQuoteUsdPrice);
  const averageFillPriceUsd = averageFillPriceQuote !== null && Number.isFinite(fillRate) && fillRate > 0 ? averageFillPriceQuote * fillRate : null;
  return { id: o.id, side, status: o.status, category: o.orderCategory, createdAt: o.timestamp,
    limitPriceUsd: o.limitPrice, averageFillPriceQuote, averageFillPriceUsd,
    quoteToken: side === 'buy' ? o.sellToken : o.buyToken, quoteSymbol: side === 'buy' ? o.sellSymbol : o.buySymbol,
    fillQuoteUsdConversion: Number.isFinite(fillRate) && fillRate > 0 ? fillRate : null,
    fillQuoteUsdConversionObservedAt: o.executedQuotePriceTimestamp ?? null,
    filledAt: o.settlementTimestamp || o.fillTimestamp || null,
    sellToken: o.sellToken, buyToken: o.buyToken, sellAmount: o.sellAmount, buyAmount: o.buyAmount,
    executedBuyAmount: o.executedBuyAmount ?? null, executedSellAmount: o.executedSellAmount ?? null,
    parentOrderId: o.parentOrderId, ocoGroupId: o.ocoGroupId, conditional: !!o.isConditional,
    takeProfitPrice: o.bracket?.tpEnabled ? o.bracket.tpPrice : undefined,
    stopLossPrice: o.bracket?.slEnabled ? o.bracket.slPrice : undefined,
    source: o.automationRequestId ? 'automation' : 'manual' };
}

/** Build a view of the main order history, not a second ledger. Manual sells use FIFO
 * for attribution; current wallet balance is supplied separately, including transfers. */
export function tradePacket(orders: TradeOrder[], w: Workspace, historyCount: number) {
  const all = workspaceOrders(orders, w).sort((a, b) => a.timestamp - b.timestamp);
  const positions = positionLots(all, w);
  const describePosition = (p: typeof positions[number]) => {
    const entry = describeOrder(p.order), amount = ethers.formatUnits(p.remaining > 0n ? p.remaining : 0n, w.token.decimals);
    return { entry, boughtTokenAmount: ethers.formatUnits(p.bought, w.token.decimals), remainingTokenAmount: amount,
      reservedTokenAmount: ethers.formatUnits(p.reserved, w.token.decimals), availableTokenAmount: ethers.formatUnits(p.available, w.token.decimals),
      purchaseCostUsd: entry.averageFillPriceUsd === null ? null : Number(ethers.formatUnits(p.bought, w.token.decimals)) * entry.averageFillPriceUsd,
      remainingCostUsd: entry.averageFillPriceUsd === null ? null : Number(amount) * entry.averageFillPriceUsd,
      remainingCostQuote: entry.averageFillPriceQuote === null ? null : Number(amount) * entry.averageFillPriceQuote };
  };
  const openPositions = positions.filter(p => p.remaining > 0n).map(describePosition);
  const remainingTokenAmount = ethers.formatUnits(positions.reduce((sum, p) => sum + (p.remaining > 0n ? p.remaining : 0n), 0n), w.token.decimals);
  const quote = getTradingQuoteToken(w.chainId);
  const costBasisUsd = openPositions.length && openPositions.every(p => p.remainingCostUsd !== null)
    ? openPositions.reduce((sum, p) => sum + p.remainingCostUsd!, 0) : null;
  const costBasisQuote = openPositions.length && openPositions.every(p => p.remainingCostQuote !== null && p.entry.quoteToken.toLowerCase() === quote.address.toLowerCase())
    ? openPositions.reduce((sum, p) => sum + p.remainingCostQuote!, 0) : null;
  return { openBuyCount: openBuyCount(all, w), openOrders: all.filter(working).map(describeOrder),
    openPositions, positionSummary: { unsoldBuyCount: openPositions.length, availableBuyCount: positions.filter(p => p.available > 0n).length,
      availableTokenAmount: ethers.formatUnits(positions.reduce((sum, p) => sum + p.available, 0n), w.token.decimals),
      reservedTokenAmount: ethers.formatUnits(positions.reduce((sum, p) => sum + p.reserved, 0n), w.token.decimals),
      remainingTokenAmount, costBasisUsd, costBasisQuote,
      averageEntryPriceUsd: costBasisUsd === null ? null : costBasisUsd / Number(remainingTokenAmount),
      averageEntryPriceQuote: costBasisQuote === null ? null : costBasisQuote / Number(remainingTokenAmount),
      quoteToken: quote.address, quoteSymbol: quote.symbol },
    recentClosedPositions: historyCount ? positions.filter(p => p.remaining <= 0n).slice(-historyCount).map(describePosition) : [],
    recentOrders: historyCount ? all.filter(o => !working(o)).slice(-historyCount).map(describeOrder) : [],
    positionAttribution: 'Confirmed local fills; linked exits first, other sells FIFO by fill time. Each buy stays in unsoldBuyCount until its remaining tokens are sold. Pending exits only reserve tokens. Transfers are reflected only in wallet balances.',
    priceBasis: 'Limit prices are requested prices. Average fill prices use executed amounts. USD fill values use the conversion observed during reconciliation, not an exact settlement-time oracle. Null means unavailable. Position averages weight only the remaining quantities.' };
}

export function parseDecision(text: string): { reason: string; orders: OrderCommand[] } {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(clean);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.orders) || typeof value.reason !== 'string' ||
    Object.keys(value).some(k => k !== 'orders' && k !== 'reason')) throw new Error('Model response must contain reason and orders');
  const fields = new Set(['side', 'price', 'amount', 'amountUnit', 'takeProfitPrice', 'stopLossPrice', 'sellKind', 'positionId']);
  for (const order of value.orders) {
    if (!order || typeof order !== 'object' || Array.isArray(order) || Object.keys(order).some(k => !fields.has(k))) throw new Error('Unsupported model order fields');
    if (!['buy', 'sell'].includes(order.side)) throw new Error('Invalid model order side');
    if (order.side === 'buy' || order.amount !== undefined || order.amountUnit !== undefined) {
      if (!['usd', 'token'].includes(order.amountUnit) || typeof order.amount !== 'string' ||
        !/^\d+(\.\d+)?$/.test(order.amount) || !Number.isFinite(Number(order.amount)) || Number(order.amount) <= 0) throw new Error('Invalid model order amount');
    }
    if (order.positionId !== undefined && (order.side !== 'sell' || typeof order.positionId !== 'string' || !order.positionId.trim())) throw new Error('Invalid position ID');
    for (const field of ['price', 'takeProfitPrice', 'stopLossPrice']) {
      if (field !== 'price' && order[field] === undefined) continue;
      if (typeof order[field] !== 'number' || !Number.isFinite(order[field]) || order[field] <= 0) throw new Error('Invalid model order price');
    }
    if (order.sellKind !== undefined && !['stop', 'limit'].includes(order.sellKind)) throw new Error('Invalid sell type');
    if (order.side === 'buy' && (order.sellKind !== undefined || order.takeProfitPrice <= order.price || order.stopLossPrice >= order.price)) throw new Error('Invalid buy protection prices');
    if (order.side === 'sell' && (order.sellKind === 'stop' ? order.stopLossPrice !== undefined || order.takeProfitPrice <= order.price
      : order.takeProfitPrice !== undefined || order.stopLossPrice >= order.price)) throw new Error('Invalid connected sell prices');
  }
  return { reason: value.reason.slice(0, 600), orders: value.orders };
}
