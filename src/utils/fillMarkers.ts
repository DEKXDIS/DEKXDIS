import { getChainConfig } from '../types/chains';
import type { ChartMarker, TradeOrder } from '../types/trading';
import { buildFilledExitPnls } from './orderHistory';

const positive = (value: string | undefined) => Number.isFinite(Number(value)) && Number(value) > 0;

/** Execution-only markers. Missing settlement evidence or cost basis is never estimated. */
export function buildFillMarkers(orders: TradeOrder[], tokenAddress: string, quoteAddress: string,
  chainId: number, intervalSeconds: number): ChartMarker[] {
  const token = tokenAddress.toLowerCase(), quotes = [quoteAddress.toLowerCase(), getChainConfig(chainId).usdtToken.address.toLowerCase()];
  const scoped = orders.filter(o => o.chainId === chainId && o.status === 'fulfilled' && !o.isConditional &&
    positive(o.executedSellAmount) && positive(o.executedBuyAmount));
  const exitPnls = buildFilledExitPnls(scoped);
  return scoped.slice().sort((a, b) => (a.settlementTimestamp || 0) - (b.settlementTimestamp || 0)).flatMap(o => {
    const isBuy = o.buyToken.toLowerCase() === token && quotes.includes(o.sellToken.toLowerCase());
    const isSell = o.sellToken.toLowerCase() === token && quotes.includes(o.buyToken.toLowerCase());
    if (!isBuy && !isSell) return [];
    let text = 'B', color = '#22c55e';
    if (isSell) {
      text = 'S · P&L unavailable'; color = '#ef4444';
      const profit = exitPnls.get(o.id);
      if (profit !== undefined) {
        text = `S ${profit >= 0 ? '+' : '-'}$${Math.abs(profit).toFixed(2)}`;
        color = profit >= 0 ? '#22c55e' : '#ef4444';
      }
    }
    if (!o.settlementTimestamp || !Number.isFinite(o.settlementTimestamp)) return [];
    return [{ id: `fill:${o.id}`, orderId: o.id, tokenAddress, chainId,
      time: Math.floor(o.settlementTimestamp / 1000 / intervalSeconds) * intervalSeconds,
      position: 'aboveBar' as const, shape: 'circle' as const, color, text, size: 1 }];
  });
}
