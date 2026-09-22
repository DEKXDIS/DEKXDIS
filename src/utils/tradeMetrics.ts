import { buildFilledExitPnls, historyTokenSide, quoteUsdRate } from './orderHistory';
import type { TradeOrder, TokenConfig } from '../types/trading';
import { getChainConfig } from '../types/chains';

function tradedToken(order: TradeOrder): string | undefined {
  if (!order.chainId || order.sellToken.toLowerCase() === order.buyToken.toLowerCase()) return undefined;
  const chain = getChainConfig(order.chainId);
  const quotes = [chain.usdtToken.address.toLowerCase(), chain.nativeToken.wrappedAddress.toLowerCase()];
  const sellIsQuote = quotes.includes(order.sellToken.toLowerCase());
  const buyIsQuote = quotes.includes(order.buyToken.toLowerCase());
  if (!sellIsQuote && !buyIsQuote) return undefined;
  return (sellIsQuote && buyIsQuote
    ? historyTokenSide(order) === 'buy' ? order.buyToken : order.sellToken
    : sellIsQuote ? order.buyToken : order.sellToken).toLowerCase();
}

/** Moving-average holdings metrics, with realized PnL from recorded linked exits.
 * Sales without a recorded exit PnL are excluded from the realized total. */
export function calculateTradeMetrics(orders: TradeOrder[], token: Pick<TokenConfig, 'address' | 'chainId'>, price: number) {
  const address = token.address.toLowerCase();
  let quantity = 0, cost = 0, volume = 0, bought = 0, spent = 0, buys = 0, sells = 0, missingFills = 0;
  const inventories = new Map<string, { quantity: number; cost: number }>();
  const issues: string[] = [];
  const scoped = orders.filter(o => o.chainId === token.chainId && tradedToken(o) === address)
    .sort((a, b) => (a.settlementTimestamp || a.fillTimestamp || a.timestamp) - (b.settlementTimestamp || b.fillTimestamp || b.timestamp));
  for (const order of scoped) {
    if (order.status !== 'fulfilled' || order.isConditional) continue;
    const sell = Number(order.executedSellAmount), buy = Number(order.executedBuyAmount);
    if (!(sell > 0 && buy > 0 && Number.isFinite(sell) && Number.isFinite(buy))) { missingFills++; issues.push(`${order.id}: missing executed amounts`); continue; }
    const rate = quoteUsdRate(order);
    if (rate === undefined) { missingFills++; issues.push(`${order.id}: missing fill USD conversion`); continue; }
    const owner = order.ownerAddress?.toLowerCase() || '';
    const inventory = inventories.get(owner) || { quantity: 0, cost: 0 };
    if (order.buyToken.toLowerCase() === address) {
      inventory.quantity += buy; inventory.cost += sell * rate; bought += buy; spent += sell * rate; volume += sell * rate; buys++;
    } else {
      const covered = Math.min(inventory.quantity, sell);
      const removedCost = inventory.quantity > 0 ? inventory.cost * covered / inventory.quantity : 0;
      inventory.quantity = Math.max(0, inventory.quantity - covered); inventory.cost = Math.max(0, inventory.cost - removedCost);
      volume += buy * rate; sells++;
    }
    inventories.set(owner, inventory);
  }
  for (const inventory of inventories.values()) { quantity += inventory.quantity; cost += inventory.cost; }
  const unrealized = issues.length ? null : quantity === 0 ? 0 : Number.isFinite(price) && price > 0 ? quantity * price - cost : null;
  return { volume, buys, sells, totalTrades: buys + sells, averageBuyPrice: bought > 0 ? spent / bought : 0,
    quantity, cost, realized: calculateOverallRealizedPnl(scoped).realized, unrealized, pnlPercent: unrealized !== null && cost > 0 ? unrealized / cost * 100 : 0, missingFills, issues };
}

/** Sum the individual confirmed exit PnLs used by order history, including losses.
 * Manual/unmatched sales without a PnL do not invalidate the recorded results. */
export function calculateOverallRealizedPnl(orders: TradeOrder[]) {
  let realized = 0;
  for (const pnl of buildFilledExitPnls(orders).values()) realized += pnl;
  return { realized, issues: [] as string[] };
}
