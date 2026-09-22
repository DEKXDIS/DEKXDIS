import type { TokenConfig } from '../types/trading';
import type { ChartInput } from '../modules/contracts';
import { CHART_COLORS, renderSnapshotChart, validateChartInput, validateSnapshotData, type SnapshotChartInput } from '../chart/chartRendering';
import { marketDataService } from './marketDataService';

export interface ChartSnapshotMetadata {
  chainId: number; tokenAddress: string; symbol: string; timeframe: string; capturedAt: number;
  width: number; height: number; candleCount: number; firstCandleTime: number; lastCandleTime: number;
  indicators: NonNullable<ChartInput['indicators']>; sha256: string; mimeType: 'image/png';
}

/**
 * Recently taken pictures, keyed by exactly what was drawn.
 *
 * A strategy waking on its own timer asks for the chart every cycle, and each capture otherwise
 * re-downloaded the whole candle window and re-rendered the image. On the same token, timeframe and
 * size the picture is identical, so a capture taken within the caller's tolerance is handed back
 * instead. This keeps strategies from adding market-data load and from walking into the provider's
 * rate-limit ladder, whose waits stack into tens of seconds.
 */
const recent = new Map<string, { capturedAt: number; dataUrl: string; metadata: ChartSnapshotMetadata }>();
/** A picture of the same token, timeframe and size is reused only within this window. */
const REUSE_LIMIT_MS = 60 * 1000;

export const chartSnapshotService = {
  async capture(token: TokenConfig, chainId: number, requested: ChartInput, signal?: AbortSignal): Promise<{ dataUrl: string; metadata: ChartSnapshotMetadata }> {
    const input = validateChartInput(requested);
    const reuseKey = [chainId, token.address.toLowerCase(), input.timeframe, input.count, input.width, input.height,
      JSON.stringify(input.indicators ?? {})].join('|');
    const now = Date.now();
    for (const [key, entry] of recent) if (now - entry.capturedAt > REUSE_LIMIT_MS) recent.delete(key);
    const cached = recent.get(reuseKey);
    if (cached) return { dataUrl: cached.dataUrl, metadata: cached.metadata };
    return this.render(token, chainId, input, reuseKey, signal);
  },

  async render(token: TokenConfig, chainId: number, input: SnapshotChartInput, reuseKey: string, signal?: AbortSignal): Promise<{ dataUrl: string; metadata: ChartSnapshotMetadata }> {
    if (typeof document === 'undefined' || !document.body) throw new Error('Chart snapshot renderer is unavailable');
    if (!token || token.chainId !== chainId || !/^0x[\da-fA-F]{40}$/.test(token.address)) throw new Error('Chart token/chain identity mismatch');
    const identity = { ...token, address: token.address.toLowerCase() };
    signal?.throwIfAborted();
    let container: HTMLDivElement | undefined;
    let chart: ReturnType<typeof renderSnapshotChart> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      let rejectInterrupted!: (error: Error) => void;
      const interrupted = new Promise<never>((_, reject) => {
        rejectInterrupted = reject;
        abort = () => reject(new Error('Chart snapshot cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
      });
      // The window is drawn from whatever the shared candle request returns, so a picture already
      // taken this cycle is reused by the caller rather than re-downloaded here.
      const fetched = await Promise.race([marketDataService.fetchCandles(identity, input.timeframe, chainId, input.count), interrupted]);
      signal?.throwIfAborted();
      timer = setTimeout(() => rejectInterrupted(new Error('Chart capture timed out')), 20000);
      const capturedAt = Date.now();
      const data = validateSnapshotData(fetched.candles, fetched.volume, input, capturedAt);
      container = document.createElement('div');
      container.setAttribute('aria-hidden', 'true');
      container.style.cssText = `position:fixed;left:-10000px;top:0;width:${input.width}px;height:${input.height - 52}px;pointer-events:none;overflow:hidden;`;
      document.body.appendChild(container);
      chart = renderSnapshotChart(container, data.candles, data.volume, input);
      const pixels = chart.takeScreenshot(true, false);
      if (!pixels.width || !pixels.height) throw new Error('Chart snapshot has zero dimensions');
      const canvas = document.createElement('canvas');
      canvas.width = input.width; canvas.height = input.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Chart snapshot canvas is unavailable');
      context.fillStyle = CHART_COLORS.background; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(pixels, 0, 52, input.width, input.height - 52);
      context.fillStyle = '#e2e8f0'; context.font = 'bold 16px Arial, sans-serif';
      const symbol = identity.symbol.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 32);
      context.fillText(`${symbol} / USD · ${input.timeframe} · Chain ${chainId}`, 16, 23, input.width - 32);
      const indicators = input.indicators ?? {};
      const labels = [...(indicators.ema ?? []).map(period => `EMA ${period}`), ...(indicators.sma ?? []).map(period => `SMA ${period}`),
        ...(indicators.rsi ? [`RSI ${indicators.rsi}`] : []), ...(indicators.macd ? ['MACD 12/26/9'] : []), ...(indicators.volume ? ['Volume'] : [])];
      context.fillStyle = CHART_COLORS.text; context.font = '12px Arial, sans-serif';
      context.fillText(labels.join(' · ') || 'Candlesticks', 16, 43, input.width - 32);
      const probe = context.getImageData(0, 52, input.width, input.height - 52).data;
      let distinct = 0;
      for (let index = 0; index < probe.length; index += 64) if (probe[index] !== 13 || probe[index + 1] !== 17 || probe[index + 2] !== 26) distinct++;
      if (distinct < 100) throw new Error('Chart snapshot is blank');
      const dataUrl = canvas.toDataURL('image/png');
      if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Chart snapshot PNG encoding failed');
      const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), char => char.charCodeAt(0));
      if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('Chart snapshot exceeds image size limit');
      const digest = await Promise.race([crypto.subtle.digest('SHA-256', bytes), interrupted]);
      signal?.throwIfAborted();
      const sha256 = Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
      const result = { dataUrl, metadata: { chainId, tokenAddress: identity.address, symbol: identity.symbol,
        timeframe: input.timeframe, capturedAt, width: input.width, height: input.height, candleCount: data.candles.length,
        firstCandleTime: Number(data.candles[0].time), lastCandleTime: Number(data.candles[data.candles.length - 1].time),
        indicators, sha256, mimeType: 'image/png' as const } };
      recent.set(reuseKey, { capturedAt, dataUrl, metadata: result.metadata });
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
      try { chart?.remove(); } finally { container?.remove(); }
    }
  },
};
