import { marketFetch } from './marketRequests';
import { fetchAlphaTokenList } from './alphaTokenList';
import { candleJson, requestCandleHistory } from './candleRequests';
import { CandlestickData, Time } from 'lightweight-charts';
import { TokenConfig, MarketPrice } from '../types/trading';
import { getChainConfig, DEFAULT_CHAIN_ID } from '../types/chains';
import { VolumeData } from '../utils/indicators';
import { systemLogService } from './systemLogService';
import { volume24hUsd } from '../utils/marketVolume';

const alphaTokenCache = new Map<string, TokenConfig>();
const alphaTokensByChainCache = new Map<number, TokenConfig[]>();
let pendingFetchPromise: Promise<Map<number, TokenConfig[]>> | null = null;

export const marketDataService = {
  /**
   * Returns a cached Binance Alpha token by contract address and chainId if known.
   */
  getAlphaTokenByAddress(address: string, chainId: number = DEFAULT_CHAIN_ID): TokenConfig | undefined {
    return alphaTokenCache.get(`${chainId}_${address.toLowerCase()}`);
  },

  /**
   * Returns in-memory cached Binance Alpha tokens for a specific chain synchronously.
   */
  getCachedAlphaTokens(chainId: number = DEFAULT_CHAIN_ID): TokenConfig[] {
    return alphaTokensByChainCache.get(chainId) || [];
  },

  /**
   * Returns all cached Alpha tokens grouped by chain ID.
   */
  getAllChainsAlphaTokens(): Map<number, TokenConfig[]> {
    return alphaTokensByChainCache;
  },

  /**
   * Fetches all tokens listed across all chains on the Binance Alpha platform in one call,
   * categorizes them into their respective chains, and updates the multi-chain cache.
   */
  async fetchAllBinanceAlphaTokens(forceRefresh: boolean = false): Promise<Map<number, TokenConfig[]>> {
    if (!forceRefresh && alphaTokensByChainCache.size > 0) {
      return alphaTokensByChainCache;
    }

    if (pendingFetchPromise) {
      return pendingFetchPromise;
    }

    pendingFetchPromise = (async () => {
      try {
        const items = await fetchAlphaTokenList(forceRefresh);

        const tempByChain = new Map<number, TokenConfig[]>();

        for (const item of items) {
          if (!item.contractAddress) continue;
          const rawChain = item.chainId;
          const itemChainId = typeof rawChain === 'number' ? rawChain : parseInt(String(rawChain), 10);
          if (isNaN(itemChainId)) continue;

          const cleanSymbol = (item.symbol || item.name || 'ALPHA').trim();
          const alphaId = item.alphaId || undefined;
          const binanceSymbol = alphaId ? `${alphaId}USDT` : undefined;

          const tok: TokenConfig = {
            symbol: cleanSymbol,
            name: item.name || cleanSymbol,
            address: item.contractAddress.toLowerCase(),
            decimals: Number(item.decimals) || 18,
            chainId: itemChainId,
            logoUrl: item.iconUrl || undefined,
            isAlpha: true,
            alphaId,
            binanceSymbol,
          };

          alphaTokenCache.set(`${itemChainId}_${tok.address.toLowerCase()}`, tok);

          if (!tempByChain.has(itemChainId)) {
            tempByChain.set(itemChainId, []);
          }
          tempByChain.get(itemChainId)!.push(tok);
        }

        for (const [cId, tokens] of tempByChain.entries()) {
          alphaTokensByChainCache.set(cId, tokens);
        }

        return alphaTokensByChainCache;
      } finally {
        pendingFetchPromise = null;
      }
    })();

    return pendingFetchPromise;
  },

  /**
   * Fetches tokens listed on the Binance Alpha platform for the given chain ID.
   * Strips alpha prefixes to display clean symbol names, and maps alphaId for Klines/Ticker.
   */
  async fetchBinanceAlphaTokens(chainId: number = DEFAULT_CHAIN_ID, forceRefresh: boolean = false): Promise<TokenConfig[]> {
    if (!forceRefresh && alphaTokensByChainCache.has(chainId)) {
      return alphaTokensByChainCache.get(chainId) || [];
    }

    const allChains = await this.fetchAllBinanceAlphaTokens(forceRefresh);
    return allChains.get(chainId) || [];
  },

  /**
   * Fetches the live USD spot price for the chain's native gas asset (e.g. BNB for BSC, ETH for Ethereum/Arbitrum/Base, xDAI for Gnosis).
   * Queries Binance Spot ticker directly for maximum speed and accuracy, falling back to on-chain DEX pools if unavailable.
   */
  async fetchNativeTokenPrice(chainId: number = DEFAULT_CHAIN_ID): Promise<number> {
    const chainConfig = getChainConfig(chainId);
    let tickerSymbol = 'BNBUSDT';

    if (chainId === 56) {
      tickerSymbol = 'BNBUSDT';
    } else if (chainId === 1 || chainId === 42161 || chainId === 8453) {
      tickerSymbol = 'ETHUSDT';
    } else {
      tickerSymbol = `${chainConfig.nativeToken.symbol.toUpperCase()}USDT`;
    }

    try {
      const res = await marketFetch(`https://api.binance.com/api/v3/ticker/price?symbol=${tickerSymbol}`);
      if (res.ok) {
        const data = await res.json();
        const price = parseFloat(data.price);
        if (!isNaN(price) && price > 0) {
          return price;
        }
      }
    } catch (err: any) {
      console.warn(`Primary Binance ticker failed for ${tickerSymbol}, attempting DEX pool fallback:`, err?.message || err);
    }

    // Fallback: Query wrapped native token on DEX via GeckoTerminal
    try {
      const wrappedAddr = chainConfig.nativeToken.wrappedAddress;
      const res = await this.fetchTokenPrice(wrappedAddr, chainId);
      if (res.price > 0) {
        return res.price;
      }
    } catch (err: any) {
      const msg = `Failed to fetch native token price for ${chainConfig.nativeToken.symbol} on ${chainConfig.name}: ${err?.message || err}`;
      systemLogService.logError('MARKET_DATA', `Native Price Fetch Error (${chainConfig.name})`, msg, chainId);
      throw new Error(msg);
    }

    const errorMsg = `Unable to determine price for ${chainConfig.nativeToken.symbol} on ${chainConfig.name}`;
    systemLogService.logError('MARKET_DATA', `Native Price Unavailable (${chainConfig.name})`, errorMsg, chainId);
    throw new Error(errorMsg);
  },

  /**
   * Fetches the live 24h market price, high, low, volume, and percentage change.
   * Path 1: If Binance Alpha token, queries Binance Alpha ticker API.
   * Path 2: If Binance Spot token, queries Binance spot 24hr ticker API.
   * Path 3: Otherwise, queries GeckoTerminal on-chain DEX pool price.
   * ZERO SILENT FALLBACKS: Throws an explicit error if data is unavailable.
   */
  async fetchTokenPrice(
    tokenAddress: string,
    chainId: number = DEFAULT_CHAIN_ID,
    binanceSymbol?: string,
    requestOptions: { maxAgeMs?: number } = {}
  ): Promise<MarketPrice> {
    const chainConfig = getChainConfig(chainId);
    const cleanAddr = tokenAddress.toLowerCase();
    const alphaMatch = this.getAlphaTokenByAddress(cleanAddr, chainId);
    const effectiveBinanceSymbol = binanceSymbol || alphaMatch?.binanceSymbol;

    try {
    // Path 1: Binance Alpha Ticker
    if (effectiveBinanceSymbol && effectiveBinanceSymbol.startsWith('ALPHA_')) {
      const res = await marketFetch(`https://www.binance.com/bapi/defi/v1/public/alpha-trade/ticker?symbol=${effectiveBinanceSymbol}`, requestOptions);
      if (!res.ok) {
        throw new Error(`Binance Alpha ticker API returned HTTP ${res.status} for ${effectiveBinanceSymbol}`);
      }
      const json = await res.json();
      if (!json.data || !json.data.lastPrice) {
        throw new Error(`Invalid data returned from Binance Alpha ticker for ${effectiveBinanceSymbol}`);
      }
      const d = json.data;
      const price = parseFloat(d.lastPrice);
      return {
        price,
        change24h: parseFloat(d.priceChangePercent),
        high24h: parseFloat(d.highPrice || '0'),
        low24h: parseFloat(d.lowPrice || '0'),
        volume24h: volume24hUsd(d.quoteVolume, d.volume, price),
        lastUpdated: Date.now(),
        symbol: effectiveBinanceSymbol.replace('USDT', ''),
      };
    }

    // Path 2: Standard Binance Spot Ticker (e.g. BNBUSDT, ETHUSDT)
    if (effectiveBinanceSymbol && !effectiveBinanceSymbol.startsWith('ALPHA_')) {
      const res = await marketFetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${effectiveBinanceSymbol}`, requestOptions);
      if (!res.ok) {
        throw new Error(`Binance spot ticker API returned HTTP ${res.status} for ${effectiveBinanceSymbol}`);
      }
      const data = await res.json();
      return {
        price: parseFloat(data.lastPrice),
        change24h: parseFloat(data.priceChangePercent),
        high24h: parseFloat(data.highPrice || '0'),
        low24h: parseFloat(data.lowPrice || '0'),
        volume24h: volume24hUsd(data.quoteVolume, data.volume, parseFloat(data.lastPrice)),
        lastUpdated: Date.now(),
        symbol: effectiveBinanceSymbol.replace('USDT', ''),
      };
    }

    } catch { /* Continue with the same contract on its on-chain DEX source. */ }

    // Path 3: On-Chain DEX query via GeckoTerminal
    const networkId = chainConfig.networkId;
    const poolsUrl = `https://api.geckoterminal.com/api/v2/networks/${networkId}/tokens/${cleanAddr}/pools`;

    const poolRes = await marketFetch(poolsUrl, requestOptions);
    if (!poolRes.ok) {
      throw new Error(`GeckoTerminal API returned HTTP ${poolRes.status} for token ${tokenAddress} on ${chainConfig.name}`);
    }

    const poolJson = await poolRes.json();
    if (!poolJson.data || !Array.isArray(poolJson.data) || poolJson.data.length === 0) {
      throw new Error(`No active DEX liquidity pool found for token contract ${tokenAddress} on ${chainConfig.name}`);
    }

    const topPool = poolJson.data[0];
    const attrs = topPool.attributes;
    const isBase = topPool.relationships?.base_token?.data?.id?.toLowerCase() === `${networkId}_${cleanAddr}`;
    const isQuote = topPool.relationships?.quote_token?.data?.id?.toLowerCase() === `${networkId}_${cleanAddr}`;
    if (!isBase && !isQuote) throw new Error('Pool token identity could not be verified');
    const priceUsd = parseFloat(isBase ? attrs.base_token_price_usd : attrs.quote_token_price_usd);

    if (!priceUsd || isNaN(priceUsd) || priceUsd <= 0) {
      throw new Error(`Invalid price data returned from DEX pool for token ${tokenAddress}`);
    }

    const change24h = parseFloat(attrs.price_change_percentage?.h24);
    const volume24h = volume24hUsd(attrs.volume_usd?.h24, undefined, priceUsd);
    const high24h = parseFloat(attrs.price_high_24h || '0');
    const low24h = parseFloat(attrs.price_low_24h || '0');

    return {
      price: priceUsd,
      change24h,
      high24h,
      low24h,
      volume24h,
      lastUpdated: Date.now(),
      symbol: topPool.attributes.name || 'TOKEN',
    };
  },

  /**
   * Fetches historical OHLCV candlestick data and volume.
   * Path 1: If Binance Alpha token, queries official Binance Alpha Klines API.
   * Path 2: If Binance Spot token, queries multi-batch Binance Spot Klines.
   * Path 3: Otherwise, fetches on-chain DEX pool OHLCV candles from GeckoTerminal API.
   * ZERO SILENT FALLBACKS: Throws an explicit error if candles cannot be retrieved.
   */
  async fetchCandles(
    token: TokenConfig,
    interval: string = '15m',
    chainId: number = DEFAULT_CHAIN_ID,
    limit: number = 300,
    options: { forceRefresh?: boolean } = {}
  ): Promise<{ candles: CandlestickData<Time>[]; volume: VolumeData[] }> {
    const count = Math.max(500, limit);
    const key = `${chainId}:${token.address.toLowerCase()}:${interval}:${count}`;
    const history = await requestCandleHistory(key, `${token.symbol} / ${interval}`, chainId, async attempt => {
      const result = await this.fetchCandleHistory(token, interval, chainId, count, attempt);
      let previousTime = -Infinity;
      if (!result.candles.length || result.candles.some(candle => {
        const time = Number(candle.time);
        const invalid = ![time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) ||
          time <= previousTime || candle.low <= 0 || candle.high < Math.max(candle.open, candle.close) ||
          candle.low > Math.min(candle.open, candle.close);
        previousTime = time;
        return invalid;
      })) throw new Error(`Invalid or unordered chart history for ${token.symbol} (${interval})`);
      return result;
    }, options.forceRefresh);
    // Live chart updates mutate their candles. Other callers must own independent bar objects.
    return { candles: history.candles.map(candle => ({ ...candle })), volume: history.volume.map(bar => ({ ...bar })) };
  },

  async fetchCandleHistory(
    token: TokenConfig, interval: string, chainId: number, limit: number,
    options: Parameters<typeof candleJson>[1]
  ): Promise<{ candles: CandlestickData<Time>[]; volume: VolumeData[] }> {
    // Normalize the initial history window so charts and ladder monitors share
    // the same cached/in-flight candle request for a token and timeframe.
    limit = Math.max(500, limit);
    const cleanAddr = token.address.toLowerCase();
    const alphaMatch = this.getAlphaTokenByAddress(cleanAddr, chainId);
    const alphaId = token.alphaId || alphaMatch?.alphaId;
    const isAlpha = token.isAlpha || !!alphaMatch;
    const alphaSymbol = token.binanceSymbol?.startsWith('ALPHA_')
      ? token.binanceSymbol
      : alphaId
      ? `${alphaId}USDT`
      : alphaMatch?.binanceSymbol;

    if (alphaSymbol || isAlpha) {
      const sym = alphaSymbol || (alphaId ? `${alphaId}USDT` : undefined);
      if (sym) {
        const url = `https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines?symbol=${sym}&interval=${interval}&limit=${Math.min(limit, 1000)}&token=${cleanAddr}&currency=usd`;
        const json = await candleJson(url, options);
        if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
          throw new Error(`No candle data returned from Binance Alpha klines for ${sym}`);
        }
        const candles: CandlestickData<Time>[] = [];
        const volume: VolumeData[] = [];
        const seenTimes = new Set<number>();

        for (const k of json.data) {
          if (!Array.isArray(k) || k.length < 6) throw new Error(`Invalid Binance Alpha candle for ${sym}`);
          const t = Math.floor(Number(k[0]) / 1000) as Time;
          const timeNum = t as number;
          if (seenTimes.has(timeNum)) continue;
          seenTimes.add(timeNum);

          const open = parseFloat(k[1]);
          const high = parseFloat(k[2]);
          const low = parseFloat(k[3]);
          const close = parseFloat(k[4]);
          const vol = parseFloat(k[5] || '0');

          candles.push({ time: t, open, high, low, close });
          volume.push({
            time: t,
            value: vol,
            color: close >= open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)',
          });
        }

        if (candles.length === 0) {
          throw new Error(`No valid candle bars could be parsed for ${token.symbol}`);
        }
        return { candles, volume };
      }
    }

    // Path 2: Standard Binance Spot Klines
    if (token.binanceSymbol && !token.binanceSymbol.startsWith('ALPHA_')) {
      const symbol = token.binanceSymbol;
      const targetCount = limit;
      const allRawKlines: any[] = [];
      let currentEndTime: number | undefined = undefined;
      let remaining = targetCount;

      while (remaining > 0) {
        const batchLimit = Math.min(1000, remaining);
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${batchLimit}${currentEndTime ? `&endTime=${currentEndTime}` : ''}`;
        const data: any[] = await candleJson(url, options);
        if (!Array.isArray(data) || data.length === 0) break;

        allRawKlines.unshift(...data);
        remaining -= data.length;

        if (data.length < batchLimit || remaining <= 0) break;
        const oldestOpenTime = data[0][0];
        currentEndTime = oldestOpenTime - 1;
      }

      if (allRawKlines.length === 0) {
        throw new Error(`No candle data returned from Binance spot klines for ${symbol}`);
      }

      const seenTimes = new Set<number>();
      const candles: CandlestickData<Time>[] = [];
      const volume: VolumeData[] = [];

      allRawKlines.sort((a, b) => a[0] - b[0]);

      for (const k of allRawKlines) {
        if (!Array.isArray(k) || k.length < 6) throw new Error(`Invalid Binance candle for ${symbol}`);
        const t = Math.floor(k[0] / 1000) as Time;
        const timeNum = t as number;
        if (seenTimes.has(timeNum)) continue;
        seenTimes.add(timeNum);

        const open = parseFloat(k[1]);
        const high = parseFloat(k[2]);
        const low = parseFloat(k[3]);
        const close = parseFloat(k[4]);
        const vol = parseFloat(k[5]);

        candles.push({ time: t, open, high, low, close });
        volume.push({
          time: t,
          value: vol,
          color: close >= open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)',
        });
      }

      return { candles, volume };
    }

    // Path 3: On-Chain DEX Pool OHLCV via GeckoTerminal
    const chainConfig = getChainConfig(chainId);
    const networkId = chainConfig.networkId;
    const poolsUrl = `https://api.geckoterminal.com/api/v2/networks/${networkId}/tokens/${cleanAddr}/pools`;

    const poolJson = await candleJson(poolsUrl, options);
    if (!poolJson?.data || !Array.isArray(poolJson.data) || poolJson.data.length === 0) {
      throw new Error(`No active DEX liquidity pool found for token ${token.symbol} (${token.address}) on ${chainConfig.name}`);
    }

    const poolAddress = poolJson.data[0].attributes?.address;
    if (!poolAddress) {
      throw new Error(`DEX pool address missing for ${token.symbol}`);
    }

    // Map interval string to GeckoTerminal timeframe & aggregate
    let timeframe = 'minute';
    let aggregate = 15;

    switch (interval) {
      case '1m':
        timeframe = 'minute';
        aggregate = 1;
        break;
      case '5m':
        timeframe = 'minute';
        aggregate = 5;
        break;
      case '15m':
        timeframe = 'minute';
        aggregate = 15;
        break;
      case '1h':
        timeframe = 'hour';
        aggregate = 1;
        break;
      case '4h':
        timeframe = 'hour';
        aggregate = 4;
        break;
      case '1d':
        timeframe = 'day';
        aggregate = 1;
        break;
      default:
        timeframe = 'minute';
        aggregate = 15;
        break;
    }

    const ohlcvUrl = `https://api.geckoterminal.com/api/v2/networks/${networkId}/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${Math.min(limit, 1000)}&token=${cleanAddr}&currency=usd`;

    const ohlcvJson = await candleJson(ohlcvUrl, options);
    const rawList = ohlcvJson?.data?.attributes?.ohlcv_list;

    if (!rawList || !Array.isArray(rawList) || rawList.length === 0) {
      throw new Error(`No historical candle bars available for DEX pool ${poolAddress}`);
    }

    // Sort ascending by epoch timestamp
    const sorted = [...rawList].sort((a, b) => a[0] - b[0]);
    const candles: CandlestickData<Time>[] = [];
    const volume: VolumeData[] = [];
    const seenTimes = new Set<number>();

    for (const item of sorted) {
      if (!Array.isArray(item) || item.length < 6) throw new Error(`Invalid DEX candle for ${token.symbol}`);
      const t = Number(item[0]) as Time;
      const timeNum = t as number;
      if (seenTimes.has(timeNum)) continue;
      seenTimes.add(timeNum);

      const open = parseFloat(item[1]);
      const high = parseFloat(item[2]);
      const low = parseFloat(item[3]);
      const close = parseFloat(item[4]);
      const vol = parseFloat(item[5] || '0');

      candles.push({ time: t, open, high, low, close });
      volume.push({
        time: t,
        value: vol,
        color: close >= open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)',
      });
    }

    if (candles.length === 0) {
      throw new Error(`No valid candle bars could be parsed for token ${token.symbol}`);
    }

    return { candles, volume };
  },
};
