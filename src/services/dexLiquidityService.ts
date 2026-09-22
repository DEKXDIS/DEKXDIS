import { getChainConfig } from '../types/chains';
import { systemLogService } from './systemLogService';

export interface PoolInfo {
  name: string;
  dexId: string;
  reserveUsd: number;
  volume24h: number;
  baseTokenPriceUsd: number | null;
  poolAddress: string;
}

export interface TokenLiquidityReport {
  tokenAddress: string;
  chainId: number;
  totalReserveUsd: number;
  totalVolume24h: number;
  primaryPool: PoolInfo | null;
  allPools: PoolInfo[];
  hasLiquidity: boolean;
}

export const dexLiquidityService = {
  /**
   * Fetches live on-chain DEX pool reserves and volume for a token on the specified chain.
   * Throws explicit errors if HTTP requests fail or network issues occur.
   */
  async fetchTokenLiquidity(
    tokenAddress: string,
    chainId: number
  ): Promise<TokenLiquidityReport> {
    const cleanAddr = tokenAddress.toLowerCase().trim();
    const chainConfig = getChainConfig(chainId);
    const networkId = chainConfig.networkId; // 'bsc', 'eth', 'base', 'arbitrum', 'gnosis'

    const url = `https://api.geckoterminal.com/api/v2/networks/${networkId}/tokens/${cleanAddr}/pools?page=1`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
        },
      });
    } catch (netErr: any) {
      const msg = `Network error fetching DEX liquidity on ${chainConfig.name}: ${netErr?.message || netErr}`;
      systemLogService.logWarning('NETWORK', `DEX Liquidity Network Warning (${chainConfig.shortName})`, msg, chainId);
      throw new Error(msg);
    }

    if (!res.ok) {
      const msg = `Failed to fetch DEX liquidity on ${chainConfig.name} (HTTP ${res.status}: ${res.statusText || 'API Error'})`;
      systemLogService.logWarning('NETWORK', `DEX Liquidity Query Warning (${chainConfig.shortName})`, msg, chainId);
      throw new Error(`Error [HTTP ${res.status}]: ${msg}. Please try again.`);
    }

    const json = await res.json();
    const rawPools = Array.isArray(json.data) ? json.data : [];

    const pools: PoolInfo[] = rawPools.map((p: any) => {
      const attr = p.attributes || {};
      const reserve = parseFloat(attr.reserve_in_usd || '0');
      const vol24h = parseFloat(attr.volume_usd?.h24 || '0');
      const price = attr.base_token_price_usd ? parseFloat(attr.base_token_price_usd) : null;
      const dex = attr.dex_id || 'DEX';
      const name = attr.name || 'Unknown Pair';
      const poolAddr = attr.address || '';

      return {
        name,
        dexId: dex,
        reserveUsd: isNaN(reserve) ? 0 : reserve,
        volume24h: isNaN(vol24h) ? 0 : vol24h,
        baseTokenPriceUsd: price,
        poolAddress: poolAddr,
      };
    });

    // Sort by reserve USD descending
    pools.sort((a, b) => b.reserveUsd - a.reserveUsd);

    const totalReserveUsd = pools.reduce((sum, p) => sum + p.reserveUsd, 0);
    const totalVolume24h = pools.reduce((sum, p) => sum + p.volume24h, 0);
    const primaryPool = pools.length > 0 ? pools[0] : null;

    return {
      tokenAddress: cleanAddr,
      chainId,
      totalReserveUsd,
      totalVolume24h,
      primaryPool,
      allPools: pools,
      hasLiquidity: totalReserveUsd > 0 || pools.length > 0,
    };
  },
};
