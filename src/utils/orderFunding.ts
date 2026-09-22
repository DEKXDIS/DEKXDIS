import { ethers } from 'ethers';
import type { Balances, TradeOrder } from '../types/trading';

export interface OrderFundingSnapshot {
  ownerAddress: string;
  chainId: number;
  balances: Balances;
}

export interface OrderFundingStatus {
  state: 'sufficient' | 'insufficient' | 'unavailable';
  details: string;
}

/** Read-only funding display: never change the signed order or use USD/rounded amounts. */
export function orderFundingStatus(order: TradeOrder, snapshot?: OrderFundingSnapshot): OrderFundingStatus | undefined {
  if (!['open', 'pending'].includes(order.status) || order.isConditional || order.id.startsWith('sl_')) return;
  const unavailable = (reason: string): OrderFundingStatus => ({ state: 'unavailable', details: reason });
  if (!snapshot || !order.ownerAddress || snapshot.ownerAddress.toLowerCase() !== order.ownerAddress.toLowerCase() ||
      snapshot.chainId !== order.chainId) return unavailable('A balance check for this order’s wallet and chain is not available.');
  if (snapshot.balances.error) return unavailable(snapshot.balances.error);
  const balance = snapshot.balances.tokenBalances?.[order.sellToken.toLowerCase()];
  if (balance === undefined) return unavailable(`The ${order.sellSymbol} balance has not been checked.`);
  const decimals = order.sellDecimals;
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    return unavailable(`Verified ${order.sellSymbol} decimals are unavailable.`);
  }
  try {
    const units = (amount: string) => {
      if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error('Invalid token amount');
      return ethers.parseUnits(amount, decimals);
    };
    const available = units(balance);
    const remaining = units(order.sellAmount) + units(order.feeAmount) - units(order.executedSellAmount ?? '0');
    if (remaining <= 0n) return unavailable('The remaining sell quantity needs an updated order status.');
    return {
      state: available < remaining ? 'insufficient' : 'sufficient',
      details: `Available: ${balance} ${order.sellSymbol}. Required: ${ethers.formatUnits(remaining, decimals)} ${order.sellSymbol}.`,
    };
  } catch (error) {
    return unavailable(`Unable to compare ${order.sellSymbol} balance with the order quantity: ${String(error)}`);
  }
}
