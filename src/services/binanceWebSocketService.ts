import { CandlestickData, Time } from 'lightweight-charts';
import { TokenConfig } from '../types/trading';
import { marketDataService } from './marketDataService';
import { volume24hUsd } from '../utils/marketVolume';

export interface WebSocketPriceUpdate {
  symbol: string;
  price: number;
  high24h?: number;
  low24h?: number;
  volume24h?: number;
  change24h?: number;
  timestamp: number;
}

export type KlineCallback = (candle: CandlestickData<Time>, isFinal: boolean, volume?: number) => void;
export type PriceCallback = (update: WebSocketPriceUpdate) => void;

interface StreamSubscription {
  id: string;
  streamName: string;
  type: 'kline' | 'ticker';
  isAlpha: boolean;
  refCount: number;
  klineCallbacks: Set<KlineCallback>;
  priceCallbacks: Set<PriceCallback>;
}

class BinanceWebSocketService {
  private spotWs: WebSocket | null = null;
  private alphaWs: WebSocket | null = null;

  private spotReconnectTimer: any = null;
  private alphaReconnectTimer: any = null;

  private subscriptions: Map<string, StreamSubscription> = new Map();
  private pendingAlphaSubs: Set<string> = new Set();
  private isAlphaWsReady: boolean = false;
  private subRequestId: number = 1;

  // Cache latest prices by token identifier: `${chainId}_${address.toLowerCase()}` -> number
  private latestPriceCache: Map<string, number> = new Map();

  /**
   * Helper to identify if a token is a Binance Alpha token
   */
  public isTokenAlpha(token: TokenConfig, chainId?: number): boolean {
    if (token.isAlpha || !!token.alphaId) return true;
    if (token.binanceSymbol?.startsWith('ALPHA_')) return true;
    const cleanAddr = token.address.toLowerCase();
    const alphaMatch = marketDataService.getAlphaTokenByAddress(cleanAddr, chainId || token.chainId);
    return !!alphaMatch;
  }

  /**
   * Resolves the proper stream symbol identifier for Binance Spot or Binance Alpha
   */
  public getStreamSymbol(token: TokenConfig, chainId?: number): { streamSymbol: string; isAlpha: boolean } | null {
    const isAlpha = this.isTokenAlpha(token, chainId);

    if (isAlpha) {
      const cleanAddr = token.address.toLowerCase();
      const alphaMatch = marketDataService.getAlphaTokenByAddress(cleanAddr, chainId || token.chainId);
      const alphaId = token.alphaId || alphaMatch?.alphaId;
      const binanceSym = token.binanceSymbol || alphaMatch?.binanceSymbol;

      if (alphaId) {
        return { streamSymbol: `${alphaId.toLowerCase()}usdt`, isAlpha: true };
      }
      if (binanceSym?.startsWith('ALPHA_')) {
        return { streamSymbol: binanceSym.toLowerCase(), isAlpha: true };
      }
      return null;
    }

    // Standard Binance Spot
    if (token.binanceSymbol && !token.binanceSymbol.startsWith('ALPHA_')) {
      return { streamSymbol: token.binanceSymbol.toLowerCase(), isAlpha: false };
    }

    return null;
  }

  /**
   * Synchronously retrieve the latest known price from WebSocket cache if present.
   */
  public getLatestCachedPrice(tokenAddress: string, chainId: number): number | undefined {
    return this.latestPriceCache.get(`${chainId}_${tokenAddress.toLowerCase()}`);
  }

  /**
   * Subscribes to real-time OHLCV klines for a given token and interval.
   * Works for both Binance Spot and Binance Alpha tokens.
   */
  public subscribeKline(
    token: TokenConfig,
    interval: string,
    callback: KlineCallback,
    chainId?: number
  ): () => void {
    const resolved = this.getStreamSymbol(token, chainId);
    if (!resolved) {
      return () => {};
    }

    const { streamSymbol, isAlpha } = resolved;
    const streamName = `${streamSymbol}@kline_${interval}`;
    const subKey = `kline_${streamName}`;

    let sub = this.subscriptions.get(subKey);
    if (!sub) {
      sub = {
        id: subKey,
        streamName,
        type: 'kline',
        isAlpha,
        refCount: 0,
        klineCallbacks: new Set(),
        priceCallbacks: new Set(),
      };
      this.subscriptions.set(subKey, sub);
    }

    sub.refCount++;
    sub.klineCallbacks.add(callback);

    if (sub.refCount === 1) {
      this.activateSubscription(sub);
    }

    return () => {
      const existing = this.subscriptions.get(subKey);
      if (!existing) return;
      existing.klineCallbacks.delete(callback);
      existing.refCount--;

      if (existing.refCount <= 0) {
        this.deactivateSubscription(existing);
        this.subscriptions.delete(subKey);
      }
    };
  }

  /**
   * Subscribes to real-time price updates for a given token.
   * Dispatches immediately on tick, and updates the internal cache.
   */
  public subscribePrice(
    token: TokenConfig,
    callback: PriceCallback,
    chainId?: number
  ): () => void {
    const effectiveChainId = chainId || token.chainId;
    const cacheKey = `${effectiveChainId}_${token.address.toLowerCase()}`;

    const resolved = this.getStreamSymbol(token, effectiveChainId);
    if (!resolved) {
      return () => {};
    }

    const { streamSymbol, isAlpha } = resolved;
    const streamName = `${streamSymbol}@ticker`;
    const subKey = `ticker_${streamName}`;

    let sub = this.subscriptions.get(subKey);
    if (!sub) {
      sub = {
        id: subKey,
        streamName,
        type: 'ticker',
        isAlpha,
        refCount: 0,
        klineCallbacks: new Set(),
        priceCallbacks: new Set(),
      };
      this.subscriptions.set(subKey, sub);
    }

    sub.refCount++;
    const wrappedCallback: PriceCallback = (update) => {
      this.latestPriceCache.set(cacheKey, update.price);
      callback(update);
    };

    sub.priceCallbacks.add(wrappedCallback);

    if (sub.refCount === 1) {
      this.activateSubscription(sub);
    }

    return () => {
      const existing = this.subscriptions.get(subKey);
      if (!existing) return;
      existing.priceCallbacks.delete(wrappedCallback);
      existing.refCount--;

      if (existing.refCount <= 0) {
        this.deactivateSubscription(existing);
        this.subscriptions.delete(subKey);
      }
    };
  }

  // =========================================================================
  // Internal WebSocket Connection & Dispatch Management
  // =========================================================================

  private activateSubscription(sub: StreamSubscription) {
    if (sub.isAlpha) {
      this.ensureAlphaConnection();
      if (this.alphaWs && this.isAlphaWsReady && this.alphaWs.readyState === WebSocket.OPEN) {
        this.sendAlphaSubscribe([sub.streamName]);
      } else {
        this.pendingAlphaSubs.add(sub.streamName);
      }
    } else {
      this.ensureSpotConnection();
      if (this.spotWs && this.spotWs.readyState === WebSocket.OPEN) {
        this.sendSpotSubscribe([sub.streamName]);
      }
    }
  }

  private deactivateSubscription(sub: StreamSubscription) {
    if (sub.isAlpha) {
      if (this.alphaWs && this.alphaWs.readyState === WebSocket.OPEN) {
        this.sendAlphaUnsubscribe([sub.streamName]);
      }
      this.pendingAlphaSubs.delete(sub.streamName);
    } else {
      if (this.spotWs && this.spotWs.readyState === WebSocket.OPEN) {
        this.sendSpotUnsubscribe([sub.streamName]);
      }
    }
  }

  // --- Binance Spot Stream (wss://stream.binance.com:9443/ws) ---
  private ensureSpotConnection() {
    if (this.spotWs && (this.spotWs.readyState === WebSocket.OPEN || this.spotWs.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.spotWs = new WebSocket('wss://stream.binance.com:9443/ws');

      this.spotWs.onopen = () => {
        const spotSubs = Array.from(this.subscriptions.values())
          .filter((s) => !s.isAlpha)
          .map((s) => s.streamName);

        if (spotSubs.length > 0) {
          this.sendSpotSubscribe(spotSubs);
        }
      };

      this.spotWs.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          this.handleSpotMessage(data);
        } catch (err) {
          // ignore malformed frame
        }
      };

      this.spotWs.onerror = (err) => {
        console.debug('Binance Spot WS notice:', err);
      };

      this.spotWs.onclose = () => {
        this.spotWs = null;
        const hasSpot = Array.from(this.subscriptions.values()).some((s) => !s.isAlpha);
        if (hasSpot) {
          if (this.spotReconnectTimer) clearTimeout(this.spotReconnectTimer);
          this.spotReconnectTimer = setTimeout(() => this.ensureSpotConnection(), 3000);
        }
      };
    } catch (e) {
      console.warn('Failed to initiate Binance Spot WS:', e);
    }
  }

  private sendSpotSubscribe(streams: string[]) {
    if (!this.spotWs || this.spotWs.readyState !== WebSocket.OPEN || streams.length === 0) return;
    this.spotWs.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: streams,
        id: this.subRequestId++,
      })
    );
  }

  private sendSpotUnsubscribe(streams: string[]) {
    if (!this.spotWs || this.spotWs.readyState !== WebSocket.OPEN || streams.length === 0) return;
    this.spotWs.send(
      JSON.stringify({
        method: 'UNSUBSCRIBE',
        params: streams,
        id: this.subRequestId++,
      })
    );
  }

  private handleSpotMessage(msg: any) {
    // 1. Kline stream event (e: "kline")
    if (msg.e === 'kline' && msg.k) {
      const k = msg.k;
      const streamKey = `kline_${msg.s.toLowerCase()}@kline_${k.i}`;
      const sub = this.subscriptions.get(streamKey);
      if (sub) {
        const candle: CandlestickData<Time> = {
          time: Math.floor(k.t / 1000) as Time,
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
        };
        const isFinal = Boolean(k.x);
        sub.klineCallbacks.forEach((cb) => cb(candle, isFinal, Number(k.v || 0)));
      }
      return;
    }

    // 2. 24hr Ticker event (e: "24hrTicker")
    if (msg.e === '24hrTicker') {
      const streamKey = `ticker_${msg.s.toLowerCase()}@ticker`;
      const sub = this.subscriptions.get(streamKey);
      if (sub) {
        const update: WebSocketPriceUpdate = {
          symbol: msg.s,
          price: parseFloat(msg.c),
          high24h: parseFloat(msg.h),
          low24h: parseFloat(msg.l),
          volume24h: volume24hUsd(msg.q, msg.v, parseFloat(msg.c)),
          change24h: parseFloat(msg.P),
          timestamp: Number(msg.E) || Date.now(),
        };
        sub.priceCallbacks.forEach((cb) => cb(update));
      }
    }
  }

  // --- Binance Alpha Stream (wss://nbstream.binance.com/w3w/wsa/stream) ---
  private ensureAlphaConnection() {
    if (this.alphaWs && (this.alphaWs.readyState === WebSocket.OPEN || this.alphaWs.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.alphaWs = new WebSocket('wss://nbstream.binance.com/w3w/wsa/stream');

      this.alphaWs.onopen = () => {
        this.isAlphaWsReady = true;

        const allAlphaStreams = new Set<string>();
        this.pendingAlphaSubs.forEach((s) => allAlphaStreams.add(s));
        this.subscriptions.forEach((sub) => {
          if (sub.isAlpha) allAlphaStreams.add(sub.streamName);
        });

        // Always subscribe to !ticker@arr for broad broadcast coverage
        allAlphaStreams.add('!ticker@arr');

        if (allAlphaStreams.size > 0) {
          this.sendAlphaSubscribe(Array.from(allAlphaStreams));
          this.pendingAlphaSubs.clear();
        }
      };

      this.alphaWs.onmessage = (evt) => {
        try {
          const raw = JSON.parse(evt.data);
          this.handleAlphaMessage(raw);
        } catch (err) {
          // ignore malformed frame
        }
      };

      this.alphaWs.onerror = (err) => {
        console.debug('Binance Alpha WS notice:', err);
      };

      this.alphaWs.onclose = () => {
        this.alphaWs = null;
        this.isAlphaWsReady = false;
        const hasAlpha = Array.from(this.subscriptions.values()).some((s) => s.isAlpha);
        if (hasAlpha) {
          if (this.alphaReconnectTimer) clearTimeout(this.alphaReconnectTimer);
          this.alphaReconnectTimer = setTimeout(() => this.ensureAlphaConnection(), 3000);
        }
      };
    } catch (e) {
      console.warn('Failed to initiate Binance Alpha WS:', e);
    }
  }

  private sendAlphaSubscribe(streams: string[]) {
    if (!this.alphaWs || this.alphaWs.readyState !== WebSocket.OPEN || streams.length === 0) return;
    this.alphaWs.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: streams,
        id: this.subRequestId++,
      })
    );
  }

  private sendAlphaUnsubscribe(streams: string[]) {
    if (!this.alphaWs || this.alphaWs.readyState !== WebSocket.OPEN || streams.length === 0) return;
    this.alphaWs.send(
      JSON.stringify({
        method: 'UNSUBSCRIBE',
        params: streams,
        id: this.subRequestId++,
      })
    );
  }

  private handleAlphaMessage(msg: any) {
    const payload = msg.data || msg;

    // 1. Kline stream
    if (payload.e === 'kline' && payload.k) {
      const k = payload.k;
      const s = payload.s || k.s;
      const streamKey = `kline_${s.toLowerCase()}@kline_${k.i}`;
      const sub = this.subscriptions.get(streamKey);
      if (sub) {
        const candle: CandlestickData<Time> = {
          time: Math.floor(k.t / 1000) as Time,
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
        };
        const isFinal = Boolean(k.x);
        sub.klineCallbacks.forEach((cb) => cb(candle, isFinal, Number(k.v || 0)));
      }
      return;
    }

    // 2. Individual Ticker stream or Broadcast !ticker@arr
    if (payload.e === '24hrTicker') {
      const symbol = payload.s;
      const symLower = symbol ? symbol.toLowerCase() : '';
      const streamKey = `ticker_${symLower}@ticker`;
      const sub = this.subscriptions.get(streamKey);

      const price = parseFloat(payload.c);
      if (!isNaN(price) && price > 0) {
        const update: WebSocketPriceUpdate = {
          symbol,
          price,
          high24h: parseFloat(payload.h || '0'),
          low24h: parseFloat(payload.l || '0'),
          volume24h: volume24hUsd(payload.q, payload.v, price),
          change24h: parseFloat(payload.P),
          timestamp: Number(payload.E) || Date.now(),
        };

        if (sub) {
          sub.priceCallbacks.forEach((cb) => cb(update));
        }

        marketDataService.getAllChainsAlphaTokens().forEach((tokens, chainId) => {
          for (const t of tokens) {
            const sym = t.alphaId ? `${t.alphaId.toLowerCase()}usdt` : t.binanceSymbol?.toLowerCase();
            if (sym === symLower) {
              this.latestPriceCache.set(`${chainId}_${t.address.toLowerCase()}`, price);
            }
          }
        });
      }
    }
  }
}

export const binanceWebSocketService = new BinanceWebSocketService();
