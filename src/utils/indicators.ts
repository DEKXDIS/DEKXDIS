import { CandlestickData, Time } from 'lightweight-charts';
import { formatTokenDisplay } from './displayFormat';

export interface VolumeData {
  time: Time;
  value: number;
  color: string;
}

export interface IndicatorPoint {
  time: Time;
  value: number;
}

export interface HistogramPoint {
  time: Time;
  value: number;
  color: string;
}

export interface MACDResult {
  macd: IndicatorPoint[];
  signal: IndicatorPoint[];
  histogram: HistogramPoint[];
}

export interface DonchianResult {
  upper: IndicatorPoint[];
  lower: IndicatorPoint[];
  midpoint: IndicatorPoint[];
}

export interface ZigZagPoint {
  time: Time;
  value: number;
  type: 'high' | 'low';
  index: number;
}

export interface ZigZagResult {
  points: ZigZagPoint[];
  linePoints: IndicatorPoint[];
}

export interface LocalExtremaPoint {
  time: Time;
  price: number;
  type: 'peak' | 'trough';
  index: number;
  volume?: number;
}

export interface SupportResistanceLevel {
  price: number;
  type: 'support' | 'resistance';
  touches: number;
  strength: number; // 0 to 1 score based on touch density & proximity
  minPrice: number;
  maxPrice: number;
}

export interface ExtremaBinningResult {
  levels: SupportResistanceLevel[];
  nearestSupport: SupportResistanceLevel | null;
  nearestResistance: SupportResistanceLevel | null;
  extrema: LocalExtremaPoint[];
}

export function getPricePrecision(price: number): { precision: number; minMove: number; format: (p: number) => string } {
  if (!price || price <= 0 || !isFinite(price)) {
    return { precision: 4, minMove: 0.0001, format: formatTokenDisplay };
  }

  if (price >= 1) {
    return { precision: 4, minMove: 0.0001, format: formatTokenDisplay };
  }

  const str = price.toFixed(14);
  const decimalPart = str.split('.')[1] || '';
  let leadingZeros = 0;
  for (let i = 0; i < decimalPart.length; i++) {
    if (decimalPart[i] === '0') {
      leadingZeros++;
    } else {
      break;
    }
  }
  const precision = Math.min(20, Math.max(4, leadingZeros + 4));
  const minMove = Math.pow(10, -precision);

  return {
    precision,
    minMove,
    format: formatTokenDisplay,
  };
}

/**
 * Calculates Exponential Moving Average (EMA) for given period.
 */
export function calculateEMA(data: CandlestickData<Time>[], period: number): IndicatorPoint[] {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const result: IndicatorPoint[] = [];

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i].close;
  }
  let prevEma = sum / period;
  result.push({ time: data[period - 1].time, value: prevEma });

  for (let i = period; i < data.length; i++) {
    const currentEma = data[i].close * k + prevEma * (1 - k);
    result.push({ time: data[i].time, value: currentEma });
    prevEma = currentEma;
  }
  return result;
}

/**
 * Calculates Relative Strength Index (RSI).
 */
export function calculateRSI(data: CandlestickData<Time>[], period: number = 14): IndicatorPoint[] {
  if (data.length <= period) return [];
  const result: IndicatorPoint[] = [];

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = data[i].close - data[i - 1].close;
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  let rsi = avgLoss === 0 ? 100 : (100 - 100 / (1 + rs));
  result.push({ time: data[period].time, value: rsi });

  for (let i = period + 1; i < data.length; i++) {
    const change = data[i].close - data[i - 1].close;
    const gain = change >= 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi = avgLoss === 0 ? 100 : (100 - 100 / (1 + rs));
    result.push({ time: data[i].time, value: rsi });
  }
  return result;
}

/**
 * Calculates MACD with configurable fast, slow, and signal EMA periods.
 */
export function calculateMACD(
  data: CandlestickData<Time>[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): MACDResult {
  const emaFast = calculateEMA(data, fastPeriod || 12);
  const emaSlow = calculateEMA(data, slowPeriod || 26);

  const emaFastMap = new Map(emaFast.map((e) => [e.time, e.value]));
  const macdRaw: { time: Time; value: number; close: number }[] = [];

  for (const eSlow of emaSlow) {
    const vFast = emaFastMap.get(eSlow.time);
    if (vFast !== undefined) {
      const diff = vFast - eSlow.value;
      macdRaw.push({ time: eSlow.time, value: diff, close: diff });
    }
  }

  const signalRaw = calculateEMA(macdRaw as any, signalPeriod || 9);
  const signalMap = new Map(signalRaw.map((s) => [s.time, s.value]));

  const macd: IndicatorPoint[] = [];
  const signal: IndicatorPoint[] = [];
  const histogram: HistogramPoint[] = [];

  for (const m of macdRaw) {
    const sigVal = signalMap.get(m.time);
    if (sigVal !== undefined) {
      macd.push({ time: m.time, value: m.value });
      signal.push({ time: m.time, value: sigVal });
      const histVal = m.value - sigVal;
      histogram.push({
        time: m.time,
        value: histVal,
        color: histVal >= 0 ? '#10b981' : '#ef4444',
      });
    }
  }

  return { macd, signal, histogram };
}

/**
 * Calculates Donchian Channels & Rolling Midpoint.
 * Upper = highest high over period
 * Lower = lowest low over period
 * Midpoint = (Upper + Lower) / 2
 */
export function calculateDonchianChannels(
  data: CandlestickData<Time>[],
  period: number = 20
): DonchianResult {
  if (data.length < period) {
    return { upper: [], lower: [], midpoint: [] };
  }

  const upper: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];
  const midpoint: IndicatorPoint[] = [];

  for (let i = period - 1; i < data.length; i++) {
    let highest = -Infinity;
    let lowest = Infinity;

    for (let j = i - period + 1; j <= i; j++) {
      if (data[j].high > highest) highest = data[j].high;
      if (data[j].low < lowest) lowest = data[j].low;
    }

    const mid = (highest + lowest) / 2;
    const time = data[i].time;

    upper.push({ time, value: highest });
    lower.push({ time, value: lowest });
    midpoint.push({ time, value: mid });
  }

  return { upper, lower, midpoint };
}

/**
 * Calculates Zig-Zag Swing Highs and Lows.
 * Filters out price movements below deviation threshold percentage.
 */
export function calculateZigZag(
  data: CandlestickData<Time>[],
  deviationPct: number = 1.5,
  depth: number = 6
): ZigZagResult {
  if (data.length < depth * 2) {
    return { points: [], linePoints: [] };
  }

  const points: ZigZagPoint[] = [];
  let lastPivotType: 'high' | 'low' | null = null;
  let lastPivotPrice = 0;
  let lastPivotTime: Time | null = null;
  let lastPivotIdx = 0;

  for (let i = depth; i < data.length - depth; i++) {
    const currentHigh = data[i].high;
    const currentLow = data[i].low;

    // Check if candle i is highest high in window
    let isHighest = true;
    for (let j = i - depth; j <= i + depth; j++) {
      if (data[j].high > currentHigh) {
        isHighest = false;
        break;
      }
    }

    // Check if candle i is lowest low in window
    let isLowest = true;
    for (let j = i - depth; j <= i + depth; j++) {
      if (data[j].low < currentLow) {
        isLowest = false;
        break;
      }
    }

    if (isHighest && isLowest) continue;

    if (isHighest) {
      if (lastPivotType === null) {
        lastPivotType = 'high';
        lastPivotPrice = currentHigh;
        lastPivotTime = data[i].time;
        lastPivotIdx = i;
        points.push({ time: data[i].time, value: currentHigh, type: 'high', index: i });
      } else if (lastPivotType === 'high') {
        // Extend high if higher
        if (currentHigh > lastPivotPrice) {
          points[points.length - 1] = { time: data[i].time, value: currentHigh, type: 'high', index: i };
          lastPivotPrice = currentHigh;
          lastPivotTime = data[i].time;
          lastPivotIdx = i;
        }
      } else if (lastPivotType === 'low') {
        const changePct = ((currentHigh - lastPivotPrice) / lastPivotPrice) * 100;
        if (changePct >= deviationPct) {
          lastPivotType = 'high';
          lastPivotPrice = currentHigh;
          lastPivotTime = data[i].time;
          lastPivotIdx = i;
          points.push({ time: data[i].time, value: currentHigh, type: 'high', index: i });
        }
      }
    } else if (isLowest) {
      if (lastPivotType === null) {
        lastPivotType = 'low';
        lastPivotPrice = currentLow;
        lastPivotTime = data[i].time;
        lastPivotIdx = i;
        points.push({ time: data[i].time, value: currentLow, type: 'low', index: i });
      } else if (lastPivotType === 'low') {
        // Extend low if lower
        if (currentLow < lastPivotPrice) {
          points[points.length - 1] = { time: data[i].time, value: currentLow, type: 'low', index: i };
          lastPivotPrice = currentLow;
          lastPivotTime = data[i].time;
          lastPivotIdx = i;
        }
      } else if (lastPivotType === 'high') {
        const changePct = ((lastPivotPrice - currentLow) / lastPivotPrice) * 100;
        if (changePct >= deviationPct) {
          lastPivotType = 'low';
          lastPivotPrice = currentLow;
          lastPivotTime = data[i].time;
          lastPivotIdx = i;
          points.push({ time: data[i].time, value: currentLow, type: 'low', index: i });
        }
      }
    }
  }

  // Connect pivots into line series
  const linePoints: IndicatorPoint[] = points.map((p) => ({
    time: p.time,
    value: p.value,
  }));

  return { points, linePoints };
}

/**
 * Calculates Local Extrema (peaks and troughs) across candlestick data.
 */
export function calculateLocalExtrema(
  data: CandlestickData<Time>[],
  window: number = 4
): LocalExtremaPoint[] {
  if (data.length < window * 2 + 1) return [];

  const extrema: LocalExtremaPoint[] = [];

  for (let i = window; i < data.length - window; i++) {
    const currentHigh = data[i].high;
    const currentLow = data[i].low;

    let isPeak = true;
    let isTrough = true;

    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (data[j].high >= currentHigh) isPeak = false;
      if (data[j].low <= currentLow) isTrough = false;
    }

    if (isPeak) {
      extrema.push({
        time: data[i].time,
        price: currentHigh,
        type: 'peak',
        index: i,
      });
    }
    if (isTrough) {
      extrema.push({
        time: data[i].time,
        price: currentLow,
        type: 'trough',
        index: i,
      });
    }
  }

  return extrema;
}

/**
 * Groups local extrema into price density bins to calculate major Support and Resistance levels.
 */
export function calculateExtremaBins(
  data: CandlestickData<Time>[],
  currentPrice: number,
  window: number = 4,
  binCount: number = 14
): ExtremaBinningResult {
  const extrema = calculateLocalExtrema(data, window);

  if (extrema.length === 0) {
    return {
      levels: [],
      nearestSupport: null,
      nearestResistance: null,
      extrema: [],
    };
  }

  // Price range of extrema
  let minPrice = Infinity;
  let maxPrice = -Infinity;

  extrema.forEach((e) => {
    if (e.price < minPrice) minPrice = e.price;
    if (e.price > maxPrice) maxPrice = e.price;
  });

  if (minPrice >= maxPrice) {
    return {
      levels: [],
      nearestSupport: null,
      nearestResistance: null,
      extrema,
    };
  }

  const binStep = (maxPrice - minPrice) / binCount;
  interface Bin {
    min: number;
    max: number;
    prices: number[];
    extremaCount: number;
    peaks: number;
    troughs: number;
  }

  const bins: Bin[] = Array.from({ length: binCount }, (_, i) => ({
    min: minPrice + i * binStep,
    max: minPrice + (i + 1) * binStep,
    prices: [],
    extremaCount: 0,
    peaks: 0,
    troughs: 0,
  }));

  // Populate bins
  extrema.forEach((e) => {
    const rawIdx = Math.floor((e.price - minPrice) / binStep);
    const idx = Math.min(Math.max(rawIdx, 0), binCount - 1);
    bins[idx].prices.push(e.price);
    bins[idx].extremaCount++;
    if (e.type === 'peak') bins[idx].peaks++;
    if (e.type === 'trough') bins[idx].troughs++;
  });

  // Calculate max touch count for normalization
  let maxTouches = 1;
  bins.forEach((b) => {
    if (b.extremaCount > maxTouches) maxTouches = b.extremaCount;
  });

  // Filter significant bins (at least 2 touches or > 0 touches if few extrema)
  const threshold = extrema.length > 20 ? 2 : 1;
  const levels: SupportResistanceLevel[] = [];

  bins.forEach((b) => {
    if (b.extremaCount >= threshold && b.prices.length > 0) {
      const avgPrice = b.prices.reduce((a, c) => a + c, 0) / b.prices.length;
      const type: 'support' | 'resistance' = avgPrice < currentPrice ? 'support' : 'resistance';
      const strength = Math.min(1, b.extremaCount / maxTouches);

      levels.push({
        price: avgPrice,
        type,
        touches: b.extremaCount,
        strength,
        minPrice: b.min,
        maxPrice: b.max,
      });
    }
  });

  // Sort levels by price ascending
  levels.sort((a, b) => a.price - b.price);

  // Find nearest support (highest level below current price)
  const supports = levels.filter((l) => l.price < currentPrice);
  const nearestSupport = supports.length > 0 ? supports[supports.length - 1] : null;

  // Find nearest resistance (lowest level above current price)
  const resistances = levels.filter((l) => l.price >= currentPrice);
  const nearestResistance = resistances.length > 0 ? resistances[0] : null;

  return {
    levels,
    nearestSupport,
    nearestResistance,
    extrema,
  };
}

/**
 * 1. Independent Zig-Zag Swing S/R Analysis
 */
export interface ZigZagAnalysis {
  points: ZigZagPoint[];
  linePoints: IndicatorPoint[];
  swingHighs: ZigZagPoint[];
  swingLows: ZigZagPoint[];
  nearestSwingLow: ZigZagPoint | null;
  nearestSwingHigh: ZigZagPoint | null;
  currentWave: 'up' | 'down' | 'none';
  distToLowPct: string | null;
  distToHighPct: string | null;
}

export function getZigZagAnalysis(
  data: CandlestickData<Time>[],
  currentPrice: number,
  deviationPct: number = 1.5,
  depth: number = 6
): ZigZagAnalysis {
  const zz = calculateZigZag(data, deviationPct, depth);
  const swingHighs = zz.points.filter((p) => p.type === 'high');
  const swingLows = zz.points.filter((p) => p.type === 'low');

  const validLows = swingLows.filter((p) => p.value < currentPrice);
  const nearestSwingLow = validLows.length > 0 ? validLows[validLows.length - 1] : (swingLows[swingLows.length - 1] || null);

  const validHighs = swingHighs.filter((p) => p.value >= currentPrice);
  const nearestSwingHigh = validHighs.length > 0 ? validHighs[validHighs.length - 1] : (swingHighs[swingHighs.length - 1] || null);

  const lastPoint = zz.points[zz.points.length - 1];
  const currentWave = lastPoint ? (lastPoint.type === 'low' ? 'up' : 'down') : 'none';

  const distToLowPct = nearestSwingLow && currentPrice > 0
    ? (((currentPrice - nearestSwingLow.value) / currentPrice) * 100).toFixed(2)
    : null;

  const distToHighPct = nearestSwingHigh && currentPrice > 0
    ? (((nearestSwingHigh.value - currentPrice) / currentPrice) * 100).toFixed(2)
    : null;

  return {
    points: zz.points,
    linePoints: zz.linePoints,
    swingHighs,
    swingLows,
    nearestSwingLow,
    nearestSwingHigh,
    currentWave,
    distToLowPct,
    distToHighPct,
  };
}

/**
 * 2. Independent Donchian Channels & Rolling Midpoint Analysis
 */
export interface DonchianAnalysis {
  upper: IndicatorPoint[];
  lower: IndicatorPoint[];
  midpoint: IndicatorPoint[];
  currentUpper: number | null;
  currentLower: number | null;
  currentMid: number | null;
  channelWidth: number | null;
  distToLowerPct: string | null;
  distToUpperPct: string | null;
  distToMidPct: string | null;
}

export function getDonchianAnalysis(
  data: CandlestickData<Time>[],
  currentPrice: number,
  period: number = 20
): DonchianAnalysis {
  const don = calculateDonchianChannels(data, period);
  const currentUpper = don.upper.length > 0 ? don.upper[don.upper.length - 1].value : null;
  const currentLower = don.lower.length > 0 ? don.lower[don.lower.length - 1].value : null;
  const currentMid = don.midpoint.length > 0 ? don.midpoint[don.midpoint.length - 1].value : null;

  const channelWidth = currentUpper !== null && currentLower !== null ? currentUpper - currentLower : null;

  const distToLowerPct = currentLower !== null && currentPrice > 0
    ? (((currentPrice - currentLower) / currentPrice) * 100).toFixed(2)
    : null;

  const distToUpperPct = currentUpper !== null && currentPrice > 0
    ? (((currentUpper - currentPrice) / currentPrice) * 100).toFixed(2)
    : null;

  const distToMidPct = currentMid !== null && currentPrice > 0
    ? (((currentPrice - currentMid) / currentPrice) * 100).toFixed(2)
    : null;

  return {
    upper: don.upper,
    lower: don.lower,
    midpoint: don.midpoint,
    currentUpper,
    currentLower,
    currentMid,
    channelWidth,
    distToLowerPct,
    distToUpperPct,
    distToMidPct,
  };
}

/**
 * 3. Z-Score Asymmetric Channel & Candle Volatility Analysis
 */
export interface ZScoreChannelPoint {
  time: Time;
  mean: number;
  upper: number;
  lower: number;
  stdDev: number;
  candleZ: number;
  candleSize: number;
  close: number;
  open: number;
  high: number;
  low: number;
  isGreen: boolean;
  isRed: boolean;
}

export interface ZScoreChannelResult {
  mean: IndicatorPoint[];
  upper: IndicatorPoint[];
  lower: IndicatorPoint[];
  points: ZScoreChannelPoint[];
}

export function calculateZScoreChannel(
  data: CandlestickData<Time>[],
  period: number = 20,
  upperMult: number = 2.0,
  lowerMult: number = 2.0,
  measure: 'range' | 'body' = 'range'
): ZScoreChannelResult {
  if (!data || data.length === 0) {
    return { mean: [], upper: [], lower: [], points: [] };
  }

  const effectivePeriod = Math.max(2, Math.min(period, data.length));
  const meanPoints: IndicatorPoint[] = [];
  const upperPoints: IndicatorPoint[] = [];
  const lowerPoints: IndicatorPoint[] = [];
  const fullPoints: ZScoreChannelPoint[] = [];

  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    const startIndex = Math.max(0, i - effectivePeriod + 1);
    const window = data.slice(startIndex, i + 1);
    const count = window.length;

    let sum = 0;
    for (let j = 0; j < count; j++) {
      sum += window[j].close;
    }
    const mean = sum / count;

    let varianceSum = 0;
    for (let j = 0; j < count; j++) {
      varianceSum += Math.pow(window[j].close - mean, 2);
    }
    const stdDev = Math.sqrt(varianceSum / count);

    const upper = mean + (upperMult * stdDev);
    const lower = mean - (lowerMult * stdDev);

    const candleSize = measure === 'body'
      ? Math.abs(c.close - c.open)
      : Math.abs(c.high - c.low);

    const candleZ = stdDev > 0 ? candleSize / stdDev : 0;
    const isGreen = c.close >= c.open;
    const isRed = c.close < c.open;

    meanPoints.push({ time: c.time, value: mean });
    upperPoints.push({ time: c.time, value: upper });
    lowerPoints.push({ time: c.time, value: lower });

    fullPoints.push({
      time: c.time,
      mean,
      upper,
      lower,
      stdDev,
      candleZ,
      candleSize,
      close: c.close,
      open: c.open,
      high: c.high,
      low: c.low,
      isGreen,
      isRed,
    });
  }

  return {
    mean: meanPoints,
    upper: upperPoints,
    lower: lowerPoints,
    points: fullPoints,
  };
}

export interface ZScoreAnalysis {
  mean: IndicatorPoint[];
  upper: IndicatorPoint[];
  lower: IndicatorPoint[];
  currentMean: number | null;
  currentUpper: number | null;
  currentLower: number | null;
  currentStdDev: number | null;
  currentCandleZ: number | null;
  currentCandleSize: number | null;
  distToUpperPct: string | null;
  distToLowerPct: string | null;
  distToMeanPct: string | null;
}

export function getZScoreAnalysis(
  data: CandlestickData<Time>[],
  currentPrice: number,
  period: number = 20,
  upperMult: number = 2.0,
  lowerMult: number = 2.0,
  measure: 'range' | 'body' = 'range'
): ZScoreAnalysis {
  let effectiveData = data;
  if (data && data.length > 0 && currentPrice > 0) {
    const last = data[data.length - 1];
    const liveCandle: CandlestickData<Time> = {
      time: last.time,
      open: last.open !== undefined ? last.open : currentPrice,
      high: Math.max(last.high !== undefined ? last.high : currentPrice, currentPrice),
      low: Math.min(last.low !== undefined ? last.low : currentPrice, currentPrice),
      close: currentPrice,
    };
    effectiveData = [...data.slice(0, -1), liveCandle];
  }

  const result = calculateZScoreChannel(effectiveData, period, upperMult, lowerMult, measure);
  const lastPoint = result.points.length > 0 ? result.points[result.points.length - 1] : null;

  const currentMean = lastPoint ? lastPoint.mean : null;
  const currentUpper = lastPoint ? lastPoint.upper : null;
  const currentLower = lastPoint ? lastPoint.lower : null;
  const currentStdDev = lastPoint ? lastPoint.stdDev : null;
  const currentCandleZ = lastPoint ? lastPoint.candleZ : null;
  const currentCandleSize = lastPoint ? lastPoint.candleSize : null;

  const distToUpperPct = currentUpper !== null && currentPrice > 0
    ? (((currentUpper - currentPrice) / currentPrice) * 100).toFixed(2)
    : null;

  const distToLowerPct = currentLower !== null && currentPrice > 0
    ? (((currentPrice - currentLower) / currentPrice) * 100).toFixed(2)
    : null;

  const distToMeanPct = currentMean !== null && currentPrice > 0
    ? (((currentPrice - currentMean) / currentPrice) * 100).toFixed(2)
    : null;

  return {
    mean: result.mean,
    upper: result.upper,
    lower: result.lower,
    currentMean,
    currentUpper,
    currentLower,
    currentStdDev,
    currentCandleZ,
    currentCandleSize,
    distToUpperPct,
    distToLowerPct,
    distToMeanPct,
  };
}


