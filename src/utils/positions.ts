import { ethers } from 'ethers';
import type { TradeOrder } from '../types/trading';

type Scope = { owner: string; chainId: number; token: { address: string; decimals: number } };
const filledAt = (o: TradeOrder) => o.settlementTimestamp || o.fillTimestamp || o.timestamp;
const working = (o: TradeOrder) => o.status === 'open' || o.status === 'pending';

/** A disposable view of confirmed buys, actual sales, and pending exit reservations.
 * Linked sales use their buy first; other sales consume earlier buys FIFO. */
export function positionLots(orders: TradeOrder[], scope: Scope) {
  const token = scope.token.address.toLowerCase();
  const all = orders.filter(o => o.ownerAddress?.toLowerCase() === scope.owner.toLowerCase() && o.chainId === scope.chainId &&
    (o.buyToken.toLowerCase() === token || o.sellToken.toLowerCase() === token));
  const quantity = (amount?: string) => ethers.parseUnits(amount || '0', scope.token.decimals);
  const lots = all.filter(o => !o.isConditional && o.buyToken.toLowerCase() === token && quantity(o.executedBuyAmount) > 0n)
    .sort((a, b) => filledAt(a) - filledAt(b) || a.id.localeCompare(b.id))
    .map(order => ({ order, bought: quantity(order.executedBuyAmount), remaining: quantity(order.executedBuyAmount), reserved: 0n, available: 0n }));
  const byId = new Map(lots.map(lot => [lot.order.id, lot]));
  const sales = all.filter(o => !o.isConditional && o.sellToken.toLowerCase() === token && quantity(o.executedSellAmount) > 0n)
    .sort((a, b) => filledAt(a) - filledAt(b));
  // Account for linked exits before assigning unrelated sales to the remaining lots.
  const unlinked: TradeOrder[] = [];
  for (const sale of sales) {
    const parent = sale.parentOrderId ? byId.get(sale.parentOrderId) : undefined;
    if (parent) parent.remaining = parent.remaining > quantity(sale.executedSellAmount) ? parent.remaining - quantity(sale.executedSellAmount) : 0n;
    else unlinked.push(sale);
  }
  for (const sale of unlinked) {
    let amount = quantity(sale.executedSellAmount);
    for (const lot of lots) {
      if (filledAt(lot.order) > filledAt(sale)) break;
      const used = amount < lot.remaining ? amount : lot.remaining;
      lot.remaining -= used; amount -= used;
      if (amount === 0n) break;
    }
  }
  const exits = new Map<string, { amount: bigint; parentId?: string }>();
  for (const order of all.filter(o => working(o) && o.sellToken.toLowerCase() === token)) {
    const amount = quantity(order.sellAmount) - quantity(order.executedSellAmount);
    const key = order.ocoGroupId || order.id;
    if (amount > (exits.get(key)?.amount || 0n)) exits.set(key, { amount, parentId: order.parentOrderId });
  }
  for (const exit of [...exits.values()].sort((a, b) => Number(!!b.parentId) - Number(!!a.parentId))) {
    let amount = exit.amount;
    const candidates = exit.parentId ? [byId.get(exit.parentId)].filter(lot => lot !== undefined) : lots;
    for (const lot of candidates) {
      const available = lot.remaining - lot.reserved;
      const reserve = amount < available ? amount : available;
      lot.reserved += reserve; amount -= reserve;
      if (amount === 0n) break;
    }
  }
  for (const lot of lots) {
    const bracket = lot.order.bracket;
    // The engine may still be preparing protection for a newly filled buy.
    if (bracket && !bracket.isCompleted && (bracket.tpEnabled || bracket.slEnabled)) lot.reserved = lot.remaining;
    lot.available = lot.remaining - lot.reserved;
  }
  return lots;
}
