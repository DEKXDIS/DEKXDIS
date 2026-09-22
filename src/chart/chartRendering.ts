import { CandlestickSeries, ColorType, HistogramSeries, LineSeries, LineStyle, createChart,
  type CandlestickData, type IChartApi, type Time } from 'lightweight-charts';
import type { ChartInput } from '../modules/contracts';
import { TIMEFRAMES } from '../modules/contracts';
import { calculateEMA, calculateMACD, calculateRSI, getPricePrecision, type VolumeData } from '../utils/indicators';

// The interactive chart already uses these same indicator/precision helpers.
export { getPricePrecision } from '../utils/indicators';
export const CHART_COLORS = { background: '#0d111a', text: '#94a3b8', grid: 'rgba(30, 41, 59, 0.35)',
  up: '#10b981', down: '#ef4444', ema: ['#38bdf8', '#f59e0b', '#a78bfa', '#fb7185'],
  sma: ['#22d3ee', '#facc15', '#c084fc', '#fb923c'], rsi: '#c084fc', macd: '#06b6d4', signal: '#f97316' } as const;

export interface SnapshotChartInput extends ChartInput { width: number; height: number; }
const integer = (value: unknown, min: number, max: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be ${min}–${max}`);
  return value;
};

export function validateChartInput(input: ChartInput): SnapshotChartInput {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['timeframe', 'count', 'width', 'height', 'indicators'].includes(key))) throw new Error('Unsupported chart configuration');
  if (!Object.prototype.hasOwnProperty.call(TIMEFRAMES, input.timeframe)) throw new Error('Unsupported chart timeframe');
  const count = integer(input.count, 30, 500, 'Chart candle count');
  const width = integer(input.width ?? 1200, 640, 1600, 'Chart width');
  const height = integer(input.height ?? 800, 400, 1200, 'Chart height');
  const indicators: NonNullable<ChartInput['indicators']> = {};
  if (input.indicators !== undefined) {
    if (!input.indicators || typeof input.indicators !== 'object' || Array.isArray(input.indicators) || Object.keys(input.indicators).some(key => !['ema', 'sma', 'rsi', 'macd', 'volume'].includes(key))) throw new Error('Unsupported chart indicator');
    for (const kind of ['ema', 'sma'] as const) {
      const periods = input.indicators[kind];
      if (periods !== undefined) {
        if (!Array.isArray(periods) || periods.length > 4 || new Set(periods).size !== periods.length) throw new Error(`${kind.toUpperCase()} requires at most four distinct periods`);
        indicators[kind] = periods.map(period => integer(period, 2, Math.min(200, count), `${kind.toUpperCase()} period`));
      }
    }
    if (input.indicators.rsi !== undefined) indicators.rsi = integer(input.indicators.rsi, 2, Math.min(200, count - 1), 'RSI period');
    for (const kind of ['volume', 'macd'] as const) {
      if (input.indicators[kind] !== undefined) {
        if (typeof input.indicators[kind] !== 'boolean') throw new Error(`${kind} must be boolean`);
        indicators[kind] = input.indicators[kind];
      }
    }
    if (indicators.macd && count < 35) throw new Error('MACD requires at least 35 candles');
    if (indicators.macd && indicators.rsi && height < 640) throw new Error('RSI and MACD together require chart height of at least 640');
  }
  return { timeframe: input.timeframe, count, width, height, indicators };
}

/** Reject corrupt/stale bars. Never substitute another selected chart's data. */
export function validateSnapshotData(candles: CandlestickData<Time>[], volume: VolumeData[], input: SnapshotChartInput, now: number) {
  if (!Array.isArray(candles) || candles.length < input.count) throw new Error(`Chart requires ${input.count} available candles`);
  const selected = candles.slice(-input.count).map(candle => ({ ...candle }));
  let previous = 0;
  for (const candle of selected) {
    if (typeof candle.time !== 'number' || !Number.isInteger(candle.time) || candle.time <= previous ||
      ![candle.open, candle.high, candle.low, candle.close].every(price => Number.isFinite(price) && price > 0) ||
      candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close) || candle.low > candle.high) throw new Error('Chart data contains invalid or unordered candles');
    previous = candle.time;
  }
  const latestTime = Number(selected[selected.length - 1].time) * 1000;
  if (latestTime > now + 60000 || now - latestTime > TIMEFRAMES[input.timeframe] * 1000 + 120000) throw new Error('Chart candle data is stale or future-dated');
  const selectedVolume: VolumeData[] = [];
  if (input.indicators?.volume) {
    if (!Array.isArray(volume)) throw new Error('Chart volume data is unavailable');
    const byTime = new Map(volume.map(bar => [bar.time, bar]));
    for (const candle of selected) {
      const bar = byTime.get(candle.time);
      if (!bar || !Number.isFinite(bar.value) || bar.value < 0) throw new Error('Chart volume data is incomplete');
      selectedVolume.push({ time: candle.time, value: bar.value, color: candle.close >= candle.open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)' });
    }
  }
  return { candles: selected, volume: selectedVolume };
}

export function calculateSMA(candles: CandlestickData<Time>[], period: number): { time: Time; value: number }[] {
  const result: { time: Time; value: number }[] = [];
  let sum = 0;
  for (let index = 0; index < candles.length; index++) {
    sum += candles[index].close;
    if (index >= period) sum -= candles[index - period].close;
    if (index >= period - 1) result.push({ time: candles[index].time, value: sum / period });
  }
  return result;
}

/** Real LWC renderer; no order primitives, account data or module-specific logic. */
export function renderSnapshotChart(container: HTMLElement, candles: CandlestickData<Time>[], volume: VolumeData[], input: SnapshotChartInput): IChartApi {
  const precision = getPricePrecision(candles[candles.length - 1].close);
  const priceFormat = { type: 'price' as const, precision: precision.precision, minMove: precision.minMove };
  const indicators = input.indicators ?? {};
  const chart = createChart(container, { width: input.width, height: input.height - 52, autoSize: false,
    layout: { background: { type: ColorType.Solid, color: CHART_COLORS.background }, textColor: CHART_COLORS.text, fontSize: 12, fontFamily: 'Arial, sans-serif', attributionLogo: true },
    grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
    handleScroll: false, handleScale: false, crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
    leftPriceScale: { visible: false }, rightPriceScale: { visible: true, borderColor: '#1e293b', scaleMargins: { top: 0.08, bottom: indicators.volume ? 0.2 : 0.08 } },
    timeScale: { borderColor: '#1e293b', timeVisible: true, secondsVisible: false, rightOffset: 2, minBarSpacing: 1 } });
  try {
    chart.addSeries(CandlestickSeries, { upColor: CHART_COLORS.up, downColor: CHART_COLORS.down,
      borderVisible: false, wickUpColor: CHART_COLORS.up, wickDownColor: CHART_COLORS.down, priceFormat }).setData(candles);
    if (indicators.volume) {
      const series = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', priceLineVisible: false, lastValueVisible: false });
      series.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } }); series.setData(volume);
    }
    for (const kind of ['ema', 'sma'] as const) {
      (indicators[kind] ?? []).forEach((period, index) => chart.addSeries(LineSeries, {
        color: CHART_COLORS[kind][index], lineWidth: 2, title: `${kind.toUpperCase()} ${period}`, priceFormat,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      }).setData(kind === 'ema' ? calculateEMA(candles, period) : calculateSMA(candles, period)));
    }
    let pane = 1;
    if (indicators.rsi) {
      const series = chart.addSeries(LineSeries, { color: CHART_COLORS.rsi, lineWidth: 2,
        title: `RSI ${indicators.rsi}`, priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
        priceLineVisible: false }, pane++);
      series.setData(calculateRSI(candles, indicators.rsi));
      for (const price of [30, 70]) series.createPriceLine({ price, color: price === 70 ? '#ef4444' : '#10b981', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' });
    }
    if (indicators.macd) {
      const data = calculateMACD(candles), decimals = Math.min(20, precision.precision + 2);
      const common = { priceFormat: { type: 'price' as const, precision: decimals, minMove: 10 ** -decimals }, priceLineVisible: false };
      chart.addSeries(HistogramSeries, { ...common, lastValueVisible: false }, pane).setData(data.histogram);
      chart.addSeries(LineSeries, { ...common, color: CHART_COLORS.macd, title: 'MACD 12/26/9', lineWidth: 2 }, pane).setData(data.macd);
      chart.addSeries(LineSeries, { ...common, color: CHART_COLORS.signal, title: 'Signal', lineWidth: 1, lastValueVisible: false }, pane).setData(data.signal);
    }
    chart.panes().forEach((current, index) => current.setStretchFactor(index === 0 ? 3 : 1));
    chart.timeScale().fitContent();
    // The documented forceRepaint path makes screenshot capture independent of visibility/rAF throttling.
    chart.resize(input.width, input.height - 52, true);
    return chart;
  } catch (error) { chart.remove(); throw error; }
}
