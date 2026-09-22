import type { CandlestickData } from 'lightweight-charts';
import type { TradeOrder, ImpulseLadderSettings } from '../types/trading';

export function evaluationCandles(candles: CandlestickData[], settings: ImpulseLadderSettings, now = Date.now()): CandlestickData[] {
  if (settings.evaluationMode !== 'close') return candles;
  const seconds: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
  const duration = seconds[settings.timeframe || '15m'];
  if (!duration) throw new Error('Unsupported ladder timeframe');
  return candles.filter(c => typeof c.time === 'number' && c.time + duration <= Math.floor(now / 1000));
}
export function ladderCancellationTargets(orders: TradeOrder[], tokenAddress: string, chainId: number): string[] {
  const ladderParents = orders.filter(order =>
    (!!order.signalKey || order.id.startsWith('ladder_')) &&
    order.buyToken.toLowerCase() === tokenAddress.toLowerCase() &&
    (order.chainId || chainId) === chainId
  );
  const parentIds = new Set(ladderParents.map(order => order.id));
  const relatedStopIds = new Set(orders.filter(order => order.parentOrderId && parentIds.has(order.parentOrderId)).map(order => order.id));
  const onePerGroup = new Map<string, TradeOrder>();
  for (const order of orders.filter(order =>
    (order.status === 'open' || order.status === 'pending') &&
    (parentIds.has(order.id) || (order.parentOrderId ? parentIds.has(order.parentOrderId) : false) ||
      (order.previousOrderId ? relatedStopIds.has(order.previousOrderId) : false)))) {
    const group = order.ocoGroupId || order.parentOrderId || order.previousOrderId || order.id;
    if (!onePerGroup.has(group)) onePerGroup.set(group, order);
  }
  return [...onePerGroup.values()].map(order => order.id);
}
// Legacy display/cancellation helpers remain for existing orders. Runtime entries use the module host.
export { executeLimitEntry } from '../modules/capabilities/orders';

