import { ethers } from 'ethers';
import type { TradeOrder } from '../types/trading';
import type { Workspace } from './settings';
import type { OrderCommand } from '../services/orderPlacement';
import { historyTokenSide } from '../utils/orderHistory';
import { getTradingQuoteToken } from '../types/chains';

export const RESPONSE_FORMAT = `Return only JSON: {"reason":"brief explanation", "orders":[{"side":"buy", "price":1.23, "amount":"10", "amountUnit":"usd", "takeProfitPrice":1.4, "stopLossPrice":1.1}]}.
An empty orders array means wait. Each order is for the supplied workspace token. side is buy or sell. price, takeProfitPrice and stopLossPrice are positive USD display prices. amount is a positive decimal string, amountUnit is usd or token. A USD amount is converted to the actual trading assets by the application. TP and SL are individually optional; omit either when unwanted. Buy protections are activated by the application after a confirmed fill. A sell is a limit sell by default; use sellKind:"stop" for a conditional stop sell. For a limit sell, stopLossPrice adds its OCO stop; for a stop sell, takeProfitPrice adds its OCO limit. Do not set takeProfitPrice on a limit sell or stopLossPrice on a stop sell: price already specifies that leg. In fixed amount mode, the application uses the user's amount and unit for every order. Follow the user's instructions and supplied settings. No other response fields or actions are supported.`;

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
  const positions = all.filter(o => o.buyToken.toLowerCase() === w.token.address.toLowerCase() && o.executedBuyAmount && Number(o.executedBuyAmount) > 0)
    .map(o => ({ order: o, remaining: ethers.parseUnits(o.executedBuyAmount!, w.token.decimals) }));
  const byId = new Map(positions.map(p => [p.order.id, p]));
  const unattached: TradeOrder[] = [];
  for (const exit of all.filter(o => o.sellToken.toLowerCase() === w.token.address.toLowerCase() && Number(o.executedSellAmount) > 0)) {
    const parent = exit.parentOrderId ? byId.get(exit.parentOrderId) : undefined;
    if (parent) parent.remaining -= ethers.parseUnits(exit.executedSellAmount!, w.token.decimals);
    else unattached.push(exit);
  }
  let next = 0;
  for (const exit of unattached) {
    let amount = ethers.parseUnits(exit.executedSellAmount!, w.token.decimals);
    while (next < positions.length && amount > 0n) {
      const position = positions[next];
      if (position.order.timestamp > exit.timestamp) break;
      if (position.remaining <= 0n) { next++; continue; }
      const used = position.remaining < amount ? position.remaining : amount;
      position.remaining -= used; amount -= used;
      if (position.remaining === 0n) next++;
    }
  }
  const describePosition = (p: typeof positions[number]) => {
    const entry = describeOrder(p.order), amount = ethers.formatUnits(p.remaining > 0n ? p.remaining : 0n, w.token.decimals);
    return { entry, remainingTokenAmount: amount,
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
    openPositions, positionSummary: { remainingTokenAmount, costBasisUsd, costBasisQuote,
      averageEntryPriceUsd: costBasisUsd === null ? null : costBasisUsd / Number(remainingTokenAmount),
      averageEntryPriceQuote: costBasisQuote === null ? null : costBasisQuote / Number(remainingTokenAmount),
      quoteToken: quote.address, quoteSymbol: quote.symbol },
    recentClosedPositions: historyCount ? positions.filter(p => p.remaining <= 0n).slice(-historyCount).map(describePosition) : [],
    recentOrders: historyCount ? all.filter(o => !working(o)).slice(-historyCount).map(describeOrder) : [],
    positionAttribution: 'Confirmed local fills; linked exits first, unlinked sells FIFO. Transfers are reflected only in wallet balances.',
    priceBasis: 'Limit prices are requested prices. Average fill prices use executed amounts. USD fill values use the conversion observed during reconciliation, not an exact settlement-time oracle. Null means unavailable. Position averages weight only the remaining quantities.' };
}

export function parseDecision(text: string): { reason: string; orders: OrderCommand[] } {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(clean);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.orders) || typeof value.reason !== 'string' ||
    Object.keys(value).some(k => k !== 'orders' && k !== 'reason')) throw new Error('Model response must contain reason and orders');
  const fields = new Set(['side', 'price', 'amount', 'amountUnit', 'takeProfitPrice', 'stopLossPrice', 'sellKind']);
  for (const order of value.orders) {
    if (!order || typeof order !== 'object' || Array.isArray(order) || Object.keys(order).some(k => !fields.has(k))) throw new Error('Unsupported model order fields');
    if (!['buy', 'sell'].includes(order.side) || !['usd', 'token'].includes(order.amountUnit) || typeof order.amount !== 'string' ||
      !/^\d+(\.\d+)?$/.test(order.amount) || !Number.isFinite(Number(order.amount)) || Number(order.amount) <= 0) throw new Error('Invalid model order amount or side');
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
