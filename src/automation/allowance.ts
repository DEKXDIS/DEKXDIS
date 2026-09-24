import { ethers } from 'ethers';
import type { TradeOrder } from '../types/trading';
import { getTradingQuoteToken } from '../types/chains';
import type { Workspace } from './settings';
import { workspaceOrders, working } from './packet';

export interface TradingAllowance {
  limitUsd: string | null; usedUsd: string | null; reservedUsd: string | null; availableUsd: string | null; error?: string;
}
const positive = (value?: number): value is number => Number.isFinite(value) && Number(value) > 0;
/** Dollar arithmetic uses 18 decimal places. Buys round up and receipts round down. */
export function quoteValueUsd(amount: bigint, decimals: number, rate: number, roundUp = false): bigint {
  if (!positive(rate)) throw new Error('USD conversion unavailable');
  const numerator = amount * ethers.parseUnits(rate.toFixed(18), 18), scale = 10n ** BigInt(decimals);
  return (numerator + (roundUp && numerator > 0n ? scale - 1n : 0n)) / scale;
}

/** Recomputed from the main application's order/accounting history; no strategy ledger.
 * Sales restore cash used by this token, up to its configured ceiling. */
export function tradingAllowance(orders: TradeOrder[], w: Workspace, maximum: string): TradingAllowance {
  if (!maximum.trim()) return { limitUsd: null, usedUsd: null, reservedUsd: null, availableUsd: null };
  const limit = ethers.parseUnits(maximum.trim(), 18);
  let used = 0n, reserved = 0n;
  try {
    const quote = getTradingQuoteToken(w.chainId);
    const all = workspaceOrders(orders, w).filter(o => !o.isConditional).sort((a, b) =>
      (a.settlementTimestamp || a.fillTimestamp || a.timestamp) - (b.settlementTimestamp || b.fillTimestamp || b.timestamp) || a.id.localeCompare(b.id));
    for (const order of all) {
      const buying = order.buyToken.toLowerCase() === w.token.address.toLowerCase();
      const decimals = (buying ? order.sellDecimals : order.buyDecimals) ?? quote.decimals;
      const executed = buying ? order.executedSellAmount : order.executedBuyAmount;
      const amount = ethers.parseUnits(executed || '0', decimals);
      if (order.status === 'fulfilled' && executed === undefined) throw new Error('Waiting for confirmed fill amounts to calculate this token’s allowance');
      if (amount > 0n) {
        // Use the same recorded fill conversion as the application's history. Never
        // replace an unknown buy cost with zero or credit an unfilled sell.
        if (!positive(order.executedQuoteUsdPrice)) throw new Error('Waiting for the recorded fill USD conversion to calculate this token’s allowance');
        const value = quoteValueUsd(amount, decimals, order.executedQuoteUsdPrice, buying);
        used = buying ? used + value : used > value ? used - value : 0n;
      }
      if (buying && working(order)) {
        const unfilled = ethers.parseUnits(order.sellAmount, decimals) - amount;
        if (unfilled > 0n) {
          if (!positive(order.quoteUsdPrice)) throw new Error('Waiting for the buy order’s USD conversion to calculate this token’s allowance');
          reserved += quoteValueUsd(unfilled, decimals, order.quoteUsdPrice, true);
        }
      }
    }
    const available = limit - used - reserved;
    return { limitUsd: ethers.formatUnits(limit, 18), usedUsd: ethers.formatUnits(used, 18), reservedUsd: ethers.formatUnits(reserved, 18),
      availableUsd: ethers.formatUnits(available > 0n ? available : 0n, 18) };
  } catch (error) {
    return { limitUsd: ethers.formatUnits(limit, 18), usedUsd: null, reservedUsd: null, availableUsd: null,
      error: error instanceof Error ? error.message : String(error) };
  }
}
export function assertBuyAllowance(orders: TradeOrder[], w: Workspace, maximum: string, amount: bigint, decimals: number, rate: number) {
  const allowance = tradingAllowance(orders, w, maximum);
  if (allowance.error) throw new Error(allowance.error);
  if (allowance.availableUsd !== null && quoteValueUsd(amount, decimals, rate, true) > ethers.parseUnits(allowance.availableUsd, 18)) {
    throw new Error(`This buy exceeds ${w.token.symbol}’s remaining trading allowance ($${Number(allowance.availableUsd).toFixed(2)})`);
  }
}
