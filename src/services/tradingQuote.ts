import { getChainConfig, getTradingQuoteToken, getTokensForChain } from '../types/chains';
import { marketDataService } from './marketDataService';
import type { TradeOrder } from '../types/trading';

/** Prices are USD conversions; amounts sent to CoW always remain token units. */
export async function tokenUsdPrice(address: string, chainId: number): Promise<number> {
  const token = getTokensForChain(chainId).find(t => t.address.toLowerCase() === address.toLowerCase());
  const data = await marketDataService.fetchTokenPrice(address, chainId, token?.binanceSymbol, { maxAgeMs: 4000 });
  if (!Number.isFinite(data.price) || data.price <= 0 || !Number.isFinite(data.lastUpdated) ||
      Date.now() - data.lastUpdated > 30000 || data.lastUpdated > Date.now() + 1000) {
    throw new Error('Fresh token USD conversion price unavailable');
  }
  return data.price;
}

export async function tradingQuoteUsdPrice(chainId: number): Promise<number> {
  return tokenUsdPrice(getTradingQuoteToken(chainId).address, chainId);
}

export function assertTradingPair(tokenAddress: string, chainId: number) {
  if (tokenAddress.toLowerCase() === getTradingQuoteToken(chainId).address.toLowerCase()) {
    throw new Error('Select a different token: the trading asset and wrapped native asset are the same');
  }
}

/** Existing stablecoin orders retain their original pair and legacy USD basis. */
export async function orderQuoteUsdPrice(order: TradeOrder, address: string): Promise<number> {
  if (!order.quoteTokenAddress && address.toLowerCase() === getChainConfig(order.chainId!).usdtToken.address.toLowerCase()) return 1;
  return tokenUsdPrice(address, order.chainId!);
}
