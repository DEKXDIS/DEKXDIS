import { marketDataService } from '../../services/marketDataService';
import { TIMEFRAMES, type Json } from '../contracts';
import type { ModuleRun } from '../stateStore';

export async function modulePrice(run: ModuleRun): Promise<Json> {
  const data = await marketDataService.fetchTokenPrice(run.token.address, run.chainId, run.token.binanceSymbol, { maxAgeMs: 4000 });
  if (!Number.isFinite(data.price) || data.price <= 0 || Date.now() - data.lastUpdated > run.limits.maxDataAgeMs) throw new Error('Module market price is invalid or stale');
  return { chainId: run.chainId, tokenAddress: run.token.address, price: data.price, timestamp: data.lastUpdated };
}
export async function moduleCandles(run: ModuleRun, input: Record<string, Json>): Promise<Json> {
  const timeframe = String(input.timeframe ?? ''), count = Number(input.count);
  if (!TIMEFRAMES[timeframe] || !Number.isInteger(count) || count < 2 || count > 200) throw new Error('Unsupported candle timeframe or count (2–200)');
  const data = await marketDataService.fetchCandles(run.token, timeframe, run.chainId, count);
  const now = Date.now(), seconds = TIMEFRAMES[timeframe];
  const candles = data.candles.filter(c => typeof c.time === 'number' && (!input.closedOnly || c.time + seconds <= now / 1000)).slice(-count);
  const last = candles[candles.length - 1];
  if (!last || typeof last.time !== 'number' || last.time * 1000 > now + 1000 || now - (last.time + seconds) * 1000 > Math.max(run.limits.maxDataAgeMs, seconds * 1000)) throw new Error('Module candles are missing or stale');
  const times = new Set(candles.map(c => c.time));
  return { chainId: run.chainId, tokenAddress: run.token.address, timeframe, capturedAt: now,
    candles: candles as unknown as Json, volume: data.volume.filter(v => times.has(v.time)).map(v => ({ time: v.time, value: v.value })) as unknown as Json };
}
