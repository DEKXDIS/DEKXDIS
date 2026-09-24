import { STRATEGIES_ENABLED } from '../config/releaseFeatures';
import { nativeStore } from '../services/nativeStore';
import { readChartView, saveChartView, workspaceKey } from '../automation/settings';
import { registerChart, type ChartCapture } from '../automation/chartRegistry';
import { ChartOrderLabels, shortChartId } from './chartOrderLabels';
import { buildFillMarkers } from '../utils/fillMarkers';
import { displayOrderCategory, orderLimitPriceUsd, type NativeUsdSnapshot } from '../utils/orderHistory';
import React, { useEffect, useLayoutEffect, useRef, useState, memo, useCallback } from 'react';
import { 
  createChart, 
  ColorType, 
  LineStyle, 
  CrosshairMode, 
  IChartApi, 
  ISeriesApi, 
  IPriceLine, 
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  createSeriesMarkers, 
  ISeriesMarkersPluginApi, 
  CandlestickData, 
  Time,
  SeriesMarker
} from 'lightweight-charts';
import { 
  BarChart3, 
  RefreshCw, 
  Target, 
  Zap,
  AlertTriangle
} from 'lucide-react';
import { TradeOrder, ChartMarker, TokenConfig, DEFAULT_BSC_TOKENS, ChartUserSettings, StrategyConfig } from '../types/trading';
import { DEFAULT_CHAIN_ID, getChainConfig } from '../types/chains';
import { storageService } from '../services/storageService';
import { marketDataService } from '../services/marketDataService';
import { binanceWebSocketService } from '../services/binanceWebSocketService';
import { isReportedCandleFailure } from '../services/candleRequests';
import { systemLogService } from '../services/systemLogService';
import { 
  calculateEMA, 
  calculateRSI, 
  calculateMACD, 
  calculateDonchianChannels, 
  calculateZigZag, 
  calculateExtremaBins,
  calculateZScoreChannel,
  getPricePrecision,
  VolumeData 
} from '../utils/indicators';

export { getPricePrecision };

interface TradingViewChartProps {
  token?: TokenConfig;
  chainId?: number;
  orders?: TradeOrder[];
  chartMarkers?: ChartMarker[];
  strategyMarkers?: ChartMarker[];
  strategyConfig?: StrategyConfig;
  onPriceSelected?: (price: number, candleTime?: number) => void;
  onCancelOrder?: (orderId: string) => void;
  livePrice?: number;
  nativePriceSnapshot?: NativeUsdSnapshot;
  onCandlesUpdated?: (candles: CandlestickData<Time>[]) => void;
  onIntervalChange?: (interval: string) => void;
  snapshotOnly?: boolean;
  onCaptureReady?: (capture: () => ChartCapture) => void;
  onCaptureError?: (message: string) => void;
}

export const TradingViewChart: React.FC<TradingViewChartProps> = memo(({
  token = DEFAULT_BSC_TOKENS[0],
  chainId = DEFAULT_CHAIN_ID,
  orders = [],
  chartMarkers = [],
  strategyMarkers = [] as ChartMarker[],
  strategyConfig,
  onPriceSelected,
  onCancelOrder,
  livePrice,
  nativePriceSnapshot,
  onCandlesUpdated,
  onIntervalChange,
  snapshotOnly = false,
  onCaptureReady,
  onCaptureError,
}) => {
  const viewKey = workspaceKey(nativeStore.getWallet()?.address || 'preview', chainId, token.address);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const currentPrecisionRef = useRef<{ precision: number; minMove: number; format: (p: number) => string }>({
    precision: 2,
    minMove: 0.01,
    format: (p) => (p || 0).toFixed(2),
  });
  
  // Series Refs
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ema20SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdLineRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdSignalRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdHistRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const macdPaneIndexRef = useRef<number | null>(null);
  const rsiPriceLinesRef = useRef<IPriceLine[]>([]);

  // Advanced S/R Indicator Series Refs
  const donchianUpperRef = useRef<ISeriesApi<'Line'> | null>(null);
  const donchianLowerRef = useRef<ISeriesApi<'Line'> | null>(null);
  const donchianMidRef = useRef<ISeriesApi<'Line'> | null>(null);
  const zigzagSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const srPriceLinesRef = useRef<IPriceLine[]>([]);
  const zscoreUpperRef = useRef<ISeriesApi<'Line'> | null>(null);
  const zscoreLowerRef = useRef<ISeriesApi<'Line'> | null>(null);
  const zscoreMeanRef = useRef<ISeriesApi<'Line'> | null>(null);

  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const orderLabelsRef = useRef<ChartOrderLabels | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const lastCandleRef = useRef<CandlestickData<Time> | null>(null);
  const onPriceSelectedRef = useRef(onPriceSelected);
  const onCancelOrderRef = useRef(onCancelOrder);
  const onCandlesUpdatedRef = useRef(onCandlesUpdated);
  const livePriceRef = useRef(livePrice);
  const ordersRef = useRef(orders);
  const nativePriceSnapshotRef = useRef(nativePriceSnapshot);
  nativePriceSnapshotRef.current = nativePriceSnapshot;
  const strategyConfigRef = useRef(strategyConfig);

  useEffect(() => {
    strategyConfigRef.current = strategyConfig;
  }, [strategyConfig]);

  useEffect(() => {
    onPriceSelectedRef.current = onPriceSelected;
  }, [onPriceSelected]);

  useEffect(() => {
    onCancelOrderRef.current = onCancelOrder;
  }, [onCancelOrder]);

  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  useEffect(() => {
    onCandlesUpdatedRef.current = onCandlesUpdated;
  }, [onCandlesUpdated]);

  useEffect(() => {
    livePriceRef.current = livePrice;
  }, [livePrice]);

  // Persistent chart configuration & state
  const [savedSettings] = useState(() => readChartView(viewKey, storageService.getChartSettings()));

  // Indicator Toggles & Interval initialized from persistent storage
  const [showVolume, setShowVolume] = useState<boolean>(savedSettings.showVolume);
  const [showEMA, setShowEMA] = useState<boolean>(savedSettings.showEMA);
  const [showRSI, setShowRSI] = useState<boolean>(savedSettings.showRSI);
  const [showMACD, setShowMACD] = useState<boolean>(savedSettings.showMACD);
  const [showDonchian, setShowDonchian] = useState<boolean>(savedSettings.showDonchian);
  const [showZigZag, setShowZigZag] = useState<boolean>(savedSettings.showZigZag);
  const [showSR, setShowSR] = useState<boolean>(savedSettings.showSR);
  const [showSignals, setShowSignals] = useState<boolean>(STRATEGIES_ENABLED && savedSettings.showSignals);
  const [showZScore, setShowZScore] = useState<boolean>(savedSettings.showZScore ?? true);
  const [interval, setIntervalState] = useState<string>(savedSettings.interval || '15m');

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const loadedHistoryKeyRef = useRef<string | null>(null);
  const [hasHistory, setHasHistory] = useState(false);
  const [hoverPrice, setHoverPrice] = useState<number | null>(null);
  const [hoverRsi, setHoverRsi] = useState<number | null>(null);

  // Sync indicator toggles and interval to persistent storage
  useEffect(() => {
    if (!snapshotOnly) saveChartView(viewKey, {
      showVolume,
      showEMA,
      showRSI,
      showMACD,
      showDonchian,
      showZigZag,
      showSR,
      showSignals,
      showZScore,
      interval,
    });
    if (onIntervalChange) {
      onIntervalChange(interval);
    }
  }, [showVolume, showEMA, showRSI, showMACD, showDonchian, showZigZag, showSR, showSignals, showZScore, interval, onIntervalChange]);

  const intervalRef = useRef(interval);
  useEffect(() => {
    intervalRef.current = interval;
  }, [interval]);

  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const chainIdRef = useRef(chainId);
  useEffect(() => {
    chainIdRef.current = chainId;
  }, [chainId]);

  // Zoom level & scroll position preservation refs
  const currentLogicalRangeRef = useRef<{ from: number; to: number } | null>(savedSettings.logicalRange || null);
  const prevCandlesLengthRef = useRef<number>(savedSettings.candleCount || 500);

  // Raw data cache for recalculating indicators
  const rawCandlesRef = useRef<CandlestickData<Time>[]>([]);
  const rawVolumeRef = useRef<VolumeData[]>([]);

  // Dynamic Pane Height Management
  // When only Candlestick & RSI are enabled, Candlestick receives ~74% of window space.
  const updatePaneHeights = useCallback(() => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return;
    const totalHeight = container.clientHeight;
    if (totalHeight <= 0) return;

    try {
      const panes = chart.panes();
      if (!panes || panes.length === 0) return;

      if (panes.length === 1) {
        panes[0].setHeight(totalHeight);
      } else if (panes.length === 2) {
        // 1 Sub-Pane (e.g. Candlesticks + RSI):
        // Main candle chart gets ~74% (> 70% of space), Sub-pane gets ~26%
        const subHeight = Math.max(70, Math.min(150, Math.floor(totalHeight * 0.26)));
        const mainHeight = Math.max(120, totalHeight - subHeight);
        panes[0].setHeight(mainHeight);
        panes[1].setHeight(subHeight);
      } else if (panes.length >= 3) {
        // 2 Sub-Panes (Candlesticks + RSI + MACD):
        // Main candle chart gets ~60% of space, Sub-panes get ~20% each
        const subHeight = Math.max(60, Math.min(120, Math.floor(totalHeight * 0.20)));
        const mainHeight = Math.max(120, totalHeight - (subHeight * (panes.length - 1)));
        panes[0].setHeight(mainHeight);
        for (let p = 1; p < panes.length; p++) {
          panes[p].setHeight(subHeight);
        }
      }
    } catch (err) {
      console.warn('Could not adjust chart pane heights:', err);
    }
  }, []);

  // Sync Dynamic RSI and MACD Sub-Panes based on user toggle
  const syncSubPanes = useCallback((candles: CandlestickData<Time>[]) => {
    const chart = chartRef.current;
    if (!chart) return;

    let nextPaneIndex = 1;

    // 1. Manage RSI Sub-Pane
    if (showRSI) {
      if (!rsiSeriesRef.current) {
        const rsiSeries = chart.addSeries(LineSeries, {
          color: '#c084fc',
          lineWidth: 2,
          title: 'RSI 14',
          priceFormat: { type: 'custom', formatter: (v: number) => v.toFixed(1) },
          priceScaleId: 'rsi',
        }, nextPaneIndex);

        const l70 = rsiSeries.createPriceLine({
          price: 70,
          color: 'rgba(239, 68, 68, 0.5)',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: false,
          title: '70',
        });

        const l30 = rsiSeries.createPriceLine({
          price: 30,
          color: 'rgba(16, 185, 129, 0.5)',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: false,
          title: '30',
        });

        rsiPriceLinesRef.current = [l70, l30];
        rsiSeriesRef.current = rsiSeries;
      }

      if (candles && candles.length > 0 && rsiSeriesRef.current) {
        const rsiData = calculateRSI(candles, 14);
        rsiSeriesRef.current.setData(rsiData);
        if (rsiData.length > 0) {
          setHoverRsi(rsiData[rsiData.length - 1].value);
        }
      }
      nextPaneIndex++;
    } else {
      if (rsiSeriesRef.current) {
        try {
          chart.removeSeries(rsiSeriesRef.current);
        } catch (removeErr) {
          console.debug('RSI series cleanup notice:', removeErr);
        }
        rsiSeriesRef.current = null;
        rsiPriceLinesRef.current = [];
        setHoverRsi(null);
      }
    }

    // 2. Manage MACD Sub-Pane
    if (showMACD) {
      const targetMacdPane = nextPaneIndex;
      // If MACD series exist but in a different pane index, recreate them
      if (macdLineRef.current && macdPaneIndexRef.current !== targetMacdPane) {
        try {
          if (macdLineRef.current) chart.removeSeries(macdLineRef.current);
          if (macdSignalRef.current) chart.removeSeries(macdSignalRef.current);
          if (macdHistRef.current) chart.removeSeries(macdHistRef.current);
        } catch (removeErr) {
          console.debug('MACD series recreation cleanup notice:', removeErr);
        }
        macdLineRef.current = null;
        macdSignalRef.current = null;
        macdHistRef.current = null;
        macdPaneIndexRef.current = null;
      }

      if (!macdLineRef.current) {
        const macdLine = chart.addSeries(LineSeries, {
          color: '#06b6d4',
          lineWidth: 2,
          title: 'MACD',
          priceScaleId: 'macd',
        }, targetMacdPane);

        const macdSignal = chart.addSeries(LineSeries, {
          color: '#f97316',
          lineWidth: 2,
          title: 'Signal',
          priceScaleId: 'macd',
        }, targetMacdPane);

        const macdHist = chart.addSeries(HistogramSeries, {
          title: 'Hist',
          priceScaleId: 'macd',
        }, targetMacdPane);

        const precObj = currentPrecisionRef.current;
        const macdPrecision = Math.min(10, (precObj?.precision || 2) + 2);
        const macdPriceFormat = {
          type: 'price' as const,
          precision: macdPrecision,
          minMove: Math.pow(10, -macdPrecision),
        };
        macdLine.applyOptions({ priceFormat: macdPriceFormat });
        macdSignal.applyOptions({ priceFormat: macdPriceFormat });
        macdHist.applyOptions({ priceFormat: macdPriceFormat });

        macdLineRef.current = macdLine;
        macdSignalRef.current = macdSignal;
        macdHistRef.current = macdHist;
        macdPaneIndexRef.current = targetMacdPane;
      }

      if (candles && candles.length > 0 && macdLineRef.current && macdSignalRef.current && macdHistRef.current) {
        const macdData = calculateMACD(candles);
        macdLineRef.current.setData(macdData.macd);
        macdSignalRef.current.setData(macdData.signal);
        macdHistRef.current.setData(macdData.histogram);
      }
      nextPaneIndex++;
    } else {
      if (macdLineRef.current || macdSignalRef.current || macdHistRef.current) {
        try {
          if (macdLineRef.current) chart.removeSeries(macdLineRef.current);
          if (macdSignalRef.current) chart.removeSeries(macdSignalRef.current);
          if (macdHistRef.current) chart.removeSeries(macdHistRef.current);
        } catch (removeErr) {
          console.debug('MACD series cleanup notice:', removeErr);
        }
        macdLineRef.current = null;
        macdSignalRef.current = null;
        macdHistRef.current = null;
        macdPaneIndexRef.current = null;
      }
    }

    updatePaneHeights();
  }, [showRSI, showMACD, updatePaneHeights]);

  // Update Indicator Series Data
  const updateIndicatorSeries = useCallback((candles: CandlestickData<Time>[], volume: VolumeData[]) => {
    if (!candles || candles.length === 0) return;

    // 1. Volume
    if (volumeSeriesRef.current) {
      if (showVolume) {
        volumeSeriesRef.current.setData(volume);
      } else {
        volumeSeriesRef.current.setData([]);
      }
    }

    // 2. EMAs
    if (ema20SeriesRef.current && ema50SeriesRef.current) {
      if (showEMA) {
        ema20SeriesRef.current.setData(calculateEMA(candles, 20));
        ema50SeriesRef.current.setData(calculateEMA(candles, 50));
      } else {
        ema20SeriesRef.current.setData([]);
        ema50SeriesRef.current.setData([]);
      }
    }

    // 3. Donchian Channels & Rolling Midpoint
    if (donchianUpperRef.current && donchianLowerRef.current && donchianMidRef.current) {
      if (showDonchian) {
        const donchianData = calculateDonchianChannels(candles, 20);
        donchianUpperRef.current.setData(donchianData.upper);
        donchianLowerRef.current.setData(donchianData.lower);
        donchianMidRef.current.setData(donchianData.midpoint);
      } else {
        donchianUpperRef.current.setData([]);
        donchianLowerRef.current.setData([]);
        donchianMidRef.current.setData([]);
      }
    }

    // 4. Zig-Zag Indicator
    if (zigzagSeriesRef.current) {
      if (showZigZag) {
        const zzData = calculateZigZag(candles, 1.5, 6);
        zigzagSeriesRef.current.setData(zzData.linePoints);
      } else {
        zigzagSeriesRef.current.setData([]);
      }
    }

    // 5. Local Extrema + Binning Support / Resistance Lines
    if (seriesRef.current) {
      srPriceLinesRef.current.forEach((line) => {
        try {
          seriesRef.current?.removePriceLine(line);
        } catch (removeErr) {
          console.debug('SR price line removal notice:', removeErr);
        }
      });
      srPriceLinesRef.current = [];

      if (showSR && candles.length > 30) {
        const latestPrice = candles[candles.length - 1].close;
        const binResult = calculateExtremaBins(candles, latestPrice, 4, 12);
        const newSrLines: IPriceLine[] = [];

        binResult.levels.forEach((lvl) => {
          const isSupport = lvl.type === 'support';
          const line = seriesRef.current?.createPriceLine({
            price: lvl.price,
            color: isSupport ? 'rgba(16, 185, 129, 0.45)' : 'rgba(239, 68, 68, 0.45)',
            lineWidth: lvl.strength > 0.6 ? 2 : 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: `${isSupport ? 'SUP' : 'RES'} (${lvl.touches}x) $${getPricePrecision(lvl.price).format(lvl.price)}`,
          });
          if (line) newSrLines.push(line);
        });

        srPriceLinesRef.current = newSrLines;
      }
    }

    // 6. Z-Score Asymmetric Channels (Upper, Lower, Mean)
    if (zscoreUpperRef.current && zscoreLowerRef.current && zscoreMeanRef.current) {
      if (showZScore) {
        const period = strategyConfigRef.current?.zscorePeriod || 20;
        const upperMult = strategyConfigRef.current?.zscoreUpperMult || 2.0;
        const lowerMult = strategyConfigRef.current?.zscoreLowerMult || 2.0;
        const measure = strategyConfigRef.current?.zscoreCandleMeasure || 'range';
        const zData = calculateZScoreChannel(candles, period, upperMult, lowerMult, measure);
        zscoreUpperRef.current.setData(zData.upper);
        zscoreLowerRef.current.setData(zData.lower);
        zscoreMeanRef.current.setData(zData.mean);
      } else {
        zscoreUpperRef.current.setData([]);
        zscoreLowerRef.current.setData([]);
        zscoreMeanRef.current.setData([]);
      }
    }

    // 7. Dynamic RSI & MACD Panes
    syncSubPanes(candles);
  }, [showVolume, showEMA, showDonchian, showZigZag, showSR, showZScore, syncSubPanes]);

  // React to indicator toggle changes immediately
  useEffect(() => {
    if (rawCandlesRef.current.length > 0) {
      updateIndicatorSeries(rawCandlesRef.current, rawVolumeRef.current);
    }
  }, [showVolume, showEMA, showRSI, showMACD, showDonchian, showZigZag, showSR, showZScore, strategyConfig, updateIndicatorSeries]);

  // Load Full Klines Data via marketDataService (Binance spot + GeckoTerminal DEX)
  const candleRequest = useRef(0);
  const loadKlines = useCallback(async (intv: string, fit: boolean = true, forceRefresh = false) => {
    const request = ++candleRequest.current;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const activeTok = tokenRef.current;
      const activeChain = chainIdRef.current;
      const { candles, volume } = await marketDataService.fetchCandles(activeTok, intv, activeChain, 500, { forceRefresh: forceRefresh || snapshotOnly });

      if (request !== candleRequest.current || activeTok.address !== tokenRef.current.address || activeChain !== chainIdRef.current || intv !== intervalRef.current) return;
      rawCandlesRef.current = candles;
      rawVolumeRef.current = volume;
      loadedHistoryKeyRef.current = `${activeChain}:${activeTok.address.toLowerCase()}:${intv}`;
      setHasHistory(true);

      if (seriesRef.current && candles.length > 0) {
        // Compute and apply token dynamic decimal precision
        const lastCandle = candles[candles.length - 1];
        lastCandleRef.current = lastCandle;
        const samplePrice = lastCandle.close || livePriceRef.current || 0;
        const precObj = getPricePrecision(samplePrice);
        currentPrecisionRef.current = precObj;

        const priceFormat = {
          type: 'price' as const,
          precision: precObj.precision,
          minMove: precObj.minMove,
        };

        seriesRef.current.applyOptions({ priceFormat });
        ema20SeriesRef.current?.applyOptions({ priceFormat });
        ema50SeriesRef.current?.applyOptions({ priceFormat });
        donchianUpperRef.current?.applyOptions({ priceFormat });
        donchianLowerRef.current?.applyOptions({ priceFormat });
        donchianMidRef.current?.applyOptions({ priceFormat });
        zigzagSeriesRef.current?.applyOptions({ priceFormat });
        zscoreUpperRef.current?.applyOptions({ priceFormat });
        zscoreLowerRef.current?.applyOptions({ priceFormat });
        zscoreMeanRef.current?.applyOptions({ priceFormat });

        const macdPrecision = Math.min(10, precObj.precision + 2);
        const macdPriceFormat = {
          type: 'price' as const,
          precision: macdPrecision,
          minMove: Math.pow(10, -macdPrecision),
        };
        macdLineRef.current?.applyOptions({ priceFormat: macdPriceFormat });
        macdSignalRef.current?.applyOptions({ priceFormat: macdPriceFormat });
        macdHistRef.current?.applyOptions({ priceFormat: macdPriceFormat });

        seriesRef.current.setData(candles);

        updateIndicatorSeries(candles, volume);

        if (onCandlesUpdatedRef.current) {
          onCandlesUpdatedRef.current(candles);
        }

        if (fit && chartRef.current) {
          chartRef.current.timeScale().fitContent();
        } else if (chartRef.current) {
          if (currentLogicalRangeRef.current && prevCandlesLengthRef.current > 0) {
            const prevRange = currentLogicalRangeRef.current;
            const span = prevRange.to - prevRange.from;
            const rightOffsetBars = prevRange.to - prevCandlesLengthRef.current;

            const newTo = candles.length + rightOffsetBars;
            const newFrom = newTo - span;

            chartRef.current.timeScale().setVisibleLogicalRange({
              from: newFrom,
              to: newTo,
            });
          } else {
            chartRef.current.timeScale().setVisibleLogicalRange({
              from: Math.max(0, candles.length - 80),
              to: candles.length + 10,
            });
          }
        }
        prevCandlesLengthRef.current = candles.length;
      }
    } catch (err: any) {
      if (request !== candleRequest.current) return;
      console.error('Error loading candles:', err);
      const msg = err.message || `Failed to fetch candle data for ${tokenRef.current?.symbol}`;
      if (!isReportedCandleFailure(err)) systemLogService.logError('MARKET_DATA',
        `Chart could not be displayed: ${tokenRef.current?.symbol}`, msg, chainIdRef.current);
      setErrorMessage(msg);
    } finally {
      if (request === candleRequest.current) setIsLoading(false);
    }
  }, [updateIndicatorSeries]);

  // Clear the previous identity before painting the new heading or accepting its live prices.
  useLayoutEffect(() => {
    candleRequest.current++;
    loadedHistoryKeyRef.current = null;
    rawCandlesRef.current = [];
    rawVolumeRef.current = [];
    lastCandleRef.current = null;
    prevCandlesLengthRef.current = savedSettings.candleCount || 500;
    setHasHistory(false);
    setIsLoading(true);
    setErrorMessage(null);
    setHoverPrice(null);
    setHoverRsi(null);
    [seriesRef, volumeSeriesRef, ema20SeriesRef, ema50SeriesRef, rsiSeriesRef,
      macdLineRef, macdSignalRef, macdHistRef, donchianUpperRef, donchianLowerRef,
      donchianMidRef, zigzagSeriesRef, zscoreUpperRef, zscoreLowerRef, zscoreMeanRef]
      .forEach(ref => ref.current?.setData([]));
    srPriceLinesRef.current.forEach(line => seriesRef.current?.removePriceLine(line));
    srPriceLinesRef.current = [];
    markersPluginRef.current?.setMarkers([]);
    onCandlesUpdatedRef.current?.([]);
  }, [token.address, chainId, interval]);

  // Helper to convert Lightweight Charts Time to epoch seconds
  const toEpochSec = useCallback((t: Time): number => {
    if (typeof t === 'number') return t;
    if (typeof t === 'string') return Math.floor(new Date(t).getTime() / 1000);
    if (typeof t === 'object' && t !== null && 'year' in (t as any)) {
      const dt = t as { year: number; month: number; day: number };
      return Math.floor(new Date(dt.year, dt.month - 1, dt.day).getTime() / 1000);
    }
    return 0;
  }, []);


  // 1. Initialize Lightweight Chart ONCE on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0d111a' },
        textColor: '#94a3b8',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(30, 41, 59, 0.35)' },
        horzLines: { color: 'rgba(30, 41, 59, 0.35)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: '#64748b',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#1e293b',
        },
        horzLine: {
          color: '#64748b',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#1e293b',
        },
      },
      leftPriceScale: { visible: false },
      rightPriceScale: {
        visible: true,
        borderColor: '#1e293b',
        scaleMargins: { top: 0.08, bottom: 0.18 },
      },
      defaultVisiblePriceScaleId: 'right',
      timeScale: {
        borderColor: '#1e293b',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 16,
        barSpacing: 9,
        minBarSpacing: 2,
        shiftVisibleRangeOnNewBar: true,
      },
    });

    // Main Candlestick Series (Pane 0)
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    // Volume Overlay (Pane 0)
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.82,
        bottom: 0,
      },
    });

    // EMA Overlays
    const ema20Series = chart.addSeries(LineSeries, {
      color: '#38bdf8',
      lineWidth: 2,
      title: 'EMA 20',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const ema50Series = chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 2,
      title: 'EMA 50',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // Donchian Channels & Rolling Midpoint Overlays
    const donchianUpper = chart.addSeries(LineSeries, {
      color: 'rgba(6, 182, 212, 0.65)',
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      title: 'Donchian Upper',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const donchianLower = chart.addSeries(LineSeries, {
      color: 'rgba(6, 182, 212, 0.65)',
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      title: 'Donchian Lower',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const donchianMid = chart.addSeries(LineSeries, {
      color: '#fbbf24',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      title: 'Rolling Mid',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // Zig-Zag Line Overlay
    const zigzagSeries = chart.addSeries(LineSeries, {
      color: '#ec4899',
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      title: 'ZigZag',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
    });

    // Z-Score Asymmetric Channels Overlays
    const zscoreUpper = chart.addSeries(LineSeries, {
      color: '#f43f5e',
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      title: 'Z-Upper',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const zscoreLower = chart.addSeries(LineSeries, {
      color: '#10b981',
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      title: 'Z-Lower',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const zscoreMean = chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      title: 'Z-Mean',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const markersPlugin = createSeriesMarkers(series as any, []) as ISeriesMarkersPluginApi<Time>;

    chartRef.current = chart;
    seriesRef.current = series;
    orderLabelsRef.current = new ChartOrderLabels();
    series.attachPrimitive(orderLabelsRef.current);
    volumeSeriesRef.current = volumeSeries;
    ema20SeriesRef.current = ema20Series;
    ema50SeriesRef.current = ema50Series;
    donchianUpperRef.current = donchianUpper;
    donchianLowerRef.current = donchianLower;
    donchianMidRef.current = donchianMid;
    zigzagSeriesRef.current = zigzagSeries;
    zscoreUpperRef.current = zscoreUpper;
    zscoreLowerRef.current = zscoreLower;
    zscoreMeanRef.current = zscoreMean;
    markersPluginRef.current = markersPlugin;

    // Crosshair move handler
    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !seriesRef.current) {
        setHoverPrice(null);
        return;
      }
      const price = seriesRef.current.coordinateToPrice(param.point.y);
      if (price !== null && !isNaN(price)) {
        setHoverPrice(price);
      }
    });

    // Find active order near coordinate
    const findOrderAtCoordinate = (y: number, clickedPrice: number | null): TradeOrder | undefined => {
      if (!seriesRef.current) return undefined;
      const curTok = tokenRef.current?.address.toLowerCase();
      const curChain = chainIdRef.current;
      if (!curTok || !curChain) return undefined;

      const activeOrders = ordersRef.current.filter((o) => {
        if (o.status !== 'open' && o.status !== 'pending') return false;
        if (!o.limitPrice && !o.triggerPrice) return false;
        if (!o.sellToken && !o.buyToken) return false;
        const matchesTok = o.sellToken?.toLowerCase() === curTok || o.buyToken?.toLowerCase() === curTok;
        const matchesChain = o.chainId === curChain;
        return matchesTok && matchesChain;
      });
      let nearest: TradeOrder | undefined, nearestDistance = Infinity;
      for (const o of activeOrders) {
        const orderPrice = orderLimitPriceUsd(o, nativePriceSnapshotRef.current);
        if (!orderPrice) continue;
        const orderY = seriesRef.current?.priceToCoordinate(orderPrice);
        const distance = orderY !== null && orderY !== undefined ? Math.abs(orderY - y) / 18
          : clickedPrice !== null && clickedPrice > 0 ? Math.abs(clickedPrice - orderPrice) / orderPrice / 0.006 : Infinity;
        if (distance <= 1 && distance < nearestDistance) { nearest = o; nearestDistance = distance; }
      }
      return nearest;
    };

    // Chart Left-Click: cancel order if clicked on line
    const handleClick = (e: MouseEvent) => {
      if (!containerRef.current || !seriesRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const clickedPrice = seriesRef.current.coordinateToPrice(y);
      const matchedOrder = findOrderAtCoordinate(y, clickedPrice);
      if (matchedOrder && onCancelOrderRef.current) {
        onCancelOrderRef.current(matchedOrder.id);
      }
    };

    // Chart Right-Click: open Limit Order Modal
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (!containerRef.current || !seriesRef.current || !chartRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const x = e.clientX - rect.left;
      const clickedPrice = seriesRef.current.coordinateToPrice(y);

      const matchedOrder = findOrderAtCoordinate(y, clickedPrice);
      if (matchedOrder && onCancelOrderRef.current) {
        onCancelOrderRef.current(matchedOrder.id);
        return;
      }

      if (!loadedHistoryKeyRef.current) return;

      if (clickedPrice !== null && !isNaN(clickedPrice) && clickedPrice > 0) {
        const timeFromCoord = chartRef.current.timeScale().coordinateToTime(x);
        const candleTime = typeof timeFromCoord === 'number' ? timeFromCoord : Math.floor(Date.now() / 1000);
        if (onPriceSelectedRef.current) {
          onPriceSelectedRef.current(clickedPrice, candleTime);
        }
      }
    };

    const containerEl = containerRef.current;
    containerEl.addEventListener('click', handleClick);
    containerEl.addEventListener('contextmenu', handleContextMenu);

    // Resize Observer
    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
        updatePaneHeights();
        if (!snapshotOnly) saveChartView(viewKey, { width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    let saveRangeTimer: any = null;
    chart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
      if (!logicalRange) return;
      currentLogicalRangeRef.current = logicalRange;
      if (rawCandlesRef.current.length > 0) {
        prevCandlesLengthRef.current = rawCandlesRef.current.length;
      }
      if (saveRangeTimer) clearTimeout(saveRangeTimer);
      saveRangeTimer = setTimeout(() => {
        if (!snapshotOnly) saveChartView(viewKey, { logicalRange, candleCount: rawCandlesRef.current.length });
      }, 300);
    });


    return () => {
      candleRequest.current++;
      loadedHistoryKeyRef.current = null;
      if (saveRangeTimer) clearTimeout(saveRangeTimer);
      containerEl.removeEventListener('click', handleClick);
      containerEl.removeEventListener('contextmenu', handleContextMenu);
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      orderLabelsRef.current = null;
      volumeSeriesRef.current = null;
      ema20SeriesRef.current = null;
      ema50SeriesRef.current = null;
      donchianUpperRef.current = null;
      donchianLowerRef.current = null;
      donchianMidRef.current = null;
      zigzagSeriesRef.current = null;
      rsiSeriesRef.current = null;
      macdLineRef.current = null;
      macdSignalRef.current = null;
      macdHistRef.current = null;
      markersPluginRef.current = null;
      lastCandleRef.current = null;
    };
  }, []); // Run ONCE on mount

  // Reload when token, chain, or interval changes without resetting user zoom & position
  useEffect(() => {
    if (seriesRef.current) {
      loadKlines(interval, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token.address, chainId, interval]);

  useEffect(() => {
    if (snapshotOnly) return;
    if (token.binanceSymbol || marketDataService.getAlphaTokenByAddress(token.address.toLowerCase(), chainId)?.binanceSymbol) return;
    const timer = setInterval(() => void loadKlines(interval, false), 30000);
    return () => { clearInterval(timer); candleRequest.current++; };
  }, [token.address, token.binanceSymbol, chainId, interval, loadKlines]);

  // Update indicators when toggles change
  useEffect(() => {
    if (rawCandlesRef.current.length > 0) {
      updateIndicatorSeries(rawCandlesRef.current, rawVolumeRef.current);
    }
  }, [showVolume, showEMA, showRSI, showMACD, showDonchian, showZigZag, showSR, updateIndicatorSeries]);

  // Real-time WebSocket streaming for Binance Spot and Binance Alpha tokens
  useEffect(() => {
    if (snapshotOnly) return;
    const unsub = binanceWebSocketService.subscribeKline(
      token,
      interval,
      (liveCandle, isFinal, liveVolume) => {
        if (!seriesRef.current || loadedHistoryKeyRef.current !== `${chainId}:${token.address.toLowerCase()}:${interval}`) return;

        // Apply price formatting dynamically if needed
        const precObj = getPricePrecision(liveCandle.close);
        if (currentPrecisionRef.current.precision !== precObj.precision) {
          currentPrecisionRef.current = precObj;
          const priceFormat = {
            type: 'price' as const,
            precision: precObj.precision,
            minMove: precObj.minMove,
          };
          seriesRef.current.applyOptions({ priceFormat });
          ema20SeriesRef.current?.applyOptions({ priceFormat });
          ema50SeriesRef.current?.applyOptions({ priceFormat });
          donchianUpperRef.current?.applyOptions({ priceFormat });
          donchianLowerRef.current?.applyOptions({ priceFormat });
          donchianMidRef.current?.applyOptions({ priceFormat });
          zigzagSeriesRef.current?.applyOptions({ priceFormat });
        }

        // Live update to lightweight chart - guard against older packet timestamps
        const lastTime = lastCandleRef.current ? toEpochSec(lastCandleRef.current.time) : 0;
        const liveTime = toEpochSec(liveCandle.time);
        if (liveTime < lastTime) {
          return;
        }

        seriesRef.current.update(liveCandle);
        lastCandleRef.current = liveCandle;

        // Keep rawCandlesRef synced
        const current = [...rawCandlesRef.current];
        if (current.length > 0) {
          const idx = current.findIndex((c) => c.time === liveCandle.time);
          if (idx >= 0) {
            current[idx] = liveCandle;
          } else {
            // New minute candle rolled over
            current.push(liveCandle);
          }
          if (current.length > 500) current.splice(0, current.length - 500);
          rawCandlesRef.current = current;
          if (liveVolume !== undefined && Number.isFinite(liveVolume)) {
            const bar = { time: liveCandle.time, value: liveVolume, color: liveCandle.close >= liveCandle.open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)' };
            rawVolumeRef.current = [...rawVolumeRef.current.filter(v => v.time !== liveCandle.time), bar].slice(-500);
          }

          // If candle finalised or on steady cadence, refresh indicators
          updateIndicatorSeries(current, rawVolumeRef.current);

          if (onCandlesUpdatedRef.current) {
            onCandlesUpdatedRef.current(current);
          }
        }
      },
      chainId
    );

    return () => {
      unsub();
    };
  }, [token, interval, chainId, updateIndicatorSeries, toEpochSec]);


  // Live price tick
  useEffect(() => {
    if (seriesRef.current && lastCandleRef.current && livePrice && livePrice > 0 &&
        loadedHistoryKeyRef.current === `${chainId}:${token.address.toLowerCase()}:${interval}`) {
      const precObj = getPricePrecision(livePrice);
      if (currentPrecisionRef.current.precision !== precObj.precision) {
        currentPrecisionRef.current = precObj;
        const priceFormat = {
          type: 'price' as const,
          precision: precObj.precision,
          minMove: precObj.minMove,
        };
        seriesRef.current.applyOptions({ priceFormat });
        ema20SeriesRef.current?.applyOptions({ priceFormat });
        ema50SeriesRef.current?.applyOptions({ priceFormat });
        donchianUpperRef.current?.applyOptions({ priceFormat });
        donchianLowerRef.current?.applyOptions({ priceFormat });
        donchianMidRef.current?.applyOptions({ priceFormat });
        zigzagSeriesRef.current?.applyOptions({ priceFormat });

        const macdPrecision = Math.min(10, precObj.precision + 2);
        const macdPriceFormat = {
          type: 'price' as const,
          precision: macdPrecision,
          minMove: Math.pow(10, -macdPrecision),
        };
        macdLineRef.current?.applyOptions({ priceFormat: macdPriceFormat });
        macdSignalRef.current?.applyOptions({ priceFormat: macdPriceFormat });
        macdHistRef.current?.applyOptions({ priceFormat: macdPriceFormat });
      }

      const current = lastCandleRef.current;
      const units: Record<string, number> = { m: 60, h: 3600, d: 86400, w: 604800 };
      const match = /^(\d+)(m|h|d|w)$/.exec(interval);
      const seconds = match ? Number(match[1]) * units[match[2]] : 60;
      // Never rewrite a closed historical candle with a price from a later interval.
      if (toEpochSec(current.time) + seconds <= Date.now() / 1000) return;
      const updatedCandle: CandlestickData<Time> = {
        time: current.time,
        open: current.open,
        high: Math.max(current.high, livePrice),
        low: Math.min(current.low, livePrice),
        close: livePrice,
      };
      seriesRef.current.update(updatedCandle);
      lastCandleRef.current = updatedCandle;

      const raw = rawCandlesRef.current;
      if (raw && raw.length > 0) {
        const lastIdx = raw.length - 1;
        raw[lastIdx] = updatedCandle;
        if (onCandlesUpdatedRef.current) {
          onCandlesUpdatedRef.current([...raw]);
        }
      }
    }
  }, [livePrice]);

  // Active Orders Solid Lines & Pending Bracket Dashed Lines
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    priceLinesRef.current.forEach((line) => {
      try {
        series.removePriceLine(line);
      } catch (removeErr) {
        console.debug('Order price line removal notice:', removeErr);
      }
    });
    priceLinesRef.current = [];

    const newLines: IPriceLine[] = [];
    const labels: { price: number; title: string; color: string }[] = [];
    const createOrderLine = (options: Parameters<typeof series.createPriceLine>[0]) => {
      labels.push({ price: options.price, title: options.title || '', color: options.color || '#94a3b8' });
      return series.createPriceLine({ ...options, title: '' });
    };
    const lowerTok = token.address.toLowerCase();

    const activeOrders = orders.filter((o) => {
      if (o.status !== 'open' && o.status !== 'pending') return false;
      if (!o.sellToken && !o.buyToken) return false;
      const matchesToken = o.sellToken?.toLowerCase() === lowerTok || o.buyToken?.toLowerCase() === lowerTok;
      const matchesChain = o.chainId === chainId;
      return matchesToken && matchesChain;
    });

    activeOrders.forEach((order) => {
      const targetPrice = orderLimitPriceUsd(order, nativePriceSnapshot);
      const category = displayOrderCategory(order, orders);
      const tag = order.externalOrderId || order.ocoGroupId || order.id;
      const ocoTag = tag ? ` [${shortChartId(tag)}]` : '';

      if (targetPrice && targetPrice > 0) {
        if (category === 'take_profit') {
          const line = createOrderLine({
            price: targetPrice,
            color: '#10b981',
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: `TP${ocoTag} @ $${getPricePrecision(targetPrice).format(targetPrice)} (${order.sellSymbol || 'TOK'})`,
          });
          newLines.push(line);
        } else if (category === 'stop_loss') {
          const line = createOrderLine({
            price: targetPrice,
            color: '#ef4444',
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: `SL${ocoTag} @ $${getPricePrecision(targetPrice).format(targetPrice)} (${order.sellSymbol || 'TOK'})`,
          });
          newLines.push(line);
        } else if (category === 'limit_sell' || (!order.orderCategory && order.type === 'BNB_TO_USDT')) {
          const line = createOrderLine({
            price: targetPrice,
            color: '#ef4444',
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: `SELL${ocoTag} @ $${getPricePrecision(targetPrice).format(targetPrice)} (${order.sellSymbol || 'TOK'})`,
          });
          newLines.push(line);
        } else if (order.orderCategory === 'limit' || order.orderCategory === 'strategy_buy' || (!order.orderCategory && order.type === 'USDT_TO_BNB')) {
          const line = createOrderLine({
            price: targetPrice,
            color: '#10b981',
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: `BUY${ocoTag} @ $${getPricePrecision(targetPrice).format(targetPrice)}`,
          });
          newLines.push(line);
        }
      }

      if (
        (order.orderCategory === 'limit' || order.orderCategory === 'strategy_buy') &&
        order.bracket &&
        !order.bracket.isTriggered &&
        !order.bracket.isCompleted
      ) {
        if (order.bracket.tpEnabled && order.bracket.tpPrice > 0) {
          const tpLine = createOrderLine({
            price: order.bracket.tpPrice,
            color: '#10b981',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `TP${ocoTag} (Pending) @ $${getPricePrecision(order.bracket.tpPrice).format(order.bracket.tpPrice)}`,
          });
          newLines.push(tpLine);
        }

        if (order.bracket.slEnabled && order.bracket.slPrice > 0) {
          const slLine = createOrderLine({
            price: order.bracket.slPrice,
            color: '#ef4444',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `SL${ocoTag} (Pending) @ $${getPricePrecision(order.bracket.slPrice).format(order.bracket.slPrice)}`,
          });
          newLines.push(slLine);
        }
      }
    });

    priceLinesRef.current = newLines;
    orderLabelsRef.current?.setLabels(labels);
  }, [orders, token.address, chainId, nativePriceSnapshot, isLoading]);

  // Unified Markers Plugin - STRICT TOKEN AND CHAIN ISOLATION (ZERO FALLBACKS)
  useEffect(() => {
    const plugin = markersPluginRef.current;
    if (!plugin) return;

    const allMarkers: SeriesMarker<Time>[] = [];
    const lowerTok = token.address.toLowerCase();

    const seconds = ({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 } as Record<string, number>)[interval] || 900;
    const fills = buildFillMarkers(orders, token.address, getChainConfig(chainId).nativeToken.wrappedAddress, chainId, seconds);
    const candleTimes = new Set(rawCandlesRef.current.map(c => Number(c.time)));
    [...chartMarkers.filter(m => !m.orderId), ...fills].forEach((m) => {
      if (m.orderId && !candleTimes.has(m.time)) return;
      if (!m.tokenAddress || !m.chainId) return;
      const matchesToken = m.tokenAddress.toLowerCase() === lowerTok;
      const matchesChain = m.chainId === chainId;
      if (matchesToken && matchesChain) {
        allMarkers.push({
          time: m.time as Time,
          position: m.position,
          color: m.color,
          shape: m.shape,
          text: m.text,
          size: m.size || 2,
        });
      }
    });

    if (STRATEGIES_ENABLED && showSignals && strategyMarkers.length > 0) {
      strategyMarkers.forEach((m) => {
        allMarkers.push({
          time: m.time as Time,
          position: m.position || 'belowBar',
          color: m.color || '#38bdf8',
          shape: m.shape || 'arrowUp',
          text: m.text || 'STRAT BUY',
          size: m.size || 2,
        });
      });
    }

    allMarkers.sort((a, b) => (a.time as number) - (b.time as number));
    plugin.setMarkers(allMarkers);
  }, [orders, chartMarkers, strategyMarkers, showSignals, token.address, chainId, interval, isLoading]);

  useEffect(() => {
    if (errorMessage) { onCaptureError?.(errorMessage); return; }
    if (!hasHistory || isLoading) return;
    const capture = (): ChartCapture => {
      if (!chartRef.current || !rawCandlesRef.current.length) throw new Error('Chart is not ready');
      const canvas = chartRef.current.takeScreenshot(true, false);
      return { image: canvas.toDataURL('image/png'), capturedAt: Date.now(), interval, nativePriceSnapshot,
        lastCandle: { ...rawCandlesRef.current[rawCandlesRef.current.length - 1] },
        orders: ordersRef.current.slice(), width: canvas.width, height: canvas.height };
    };
    const unregister = snapshotOnly ? undefined : registerChart(viewKey, capture);
    // Include series, indicators, labels and fill markers after their render pass.
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => onCaptureReady?.(capture)); });
    return () => { unregister?.(); cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [viewKey, interval, hasHistory, isLoading, errorMessage, snapshotOnly, onCaptureReady, onCaptureError, nativePriceSnapshot]);

  const chainConf = getChainConfig(chainId);

  return (
    <div className="bg-surface/90 border border-surface-border rounded-xl p-3 shadow-lg flex flex-col h-full min-h-0">
      
      {/* Chart Header Toolbar */}
      <div className="flex items-center justify-between gap-2 pb-2 mb-1.5 border-b border-surface-border shrink-0 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400">
            <BarChart3 className="w-3.5 h-3.5" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-white flex items-center gap-1.5">
              {token.symbol} / USD
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-surface border border-surface-border text-slate-400">
                {chainConf.shortName}
              </span>
              {token.isAlpha && (
                <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300">
                  ALPHA
                </span>
              )}
            </h3>
          </div>
        </div>

        {/* Indicators Toolbar, Interval & Action Hints */}
        <div className="flex items-center gap-1.5 flex-wrap">
          
          {/* Timeframe Interval Selector (Segmented Control) */}
          <div className="flex items-center bg-slate-900 border border-slate-700/80 rounded-lg p-0.5 font-mono text-[10px]">
            {['1m', '5m', '15m', '1h', '4h', '1d'].map((intv) => (
              <button
                key={intv}
                onClick={() => setIntervalState(intv)}
                className={`btn-tactile px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
                  interval === intv
                    ? 'bg-theme-primary text-slate-950 font-bold shadow-sm'
                    : 'text-slate-400 hover:text-white cursor-pointer'
                }`}
              >
                {intv.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Technical Indicator Toggle Chips */}
          <div className="flex items-center gap-1 bg-slate-900/90 border border-slate-700/80 rounded-lg p-0.5 font-mono">
            
            {/* Strategy Signals Toggle */}
            {STRATEGIES_ENABLED && <button
              onClick={() => setShowSignals(!showSignals)}
              className={`btn-tactile px-2 py-0.5 rounded text-[9px] font-bold transition-all flex items-center gap-1 cursor-pointer ${
                showSignals 
                  ? 'bg-theme-primary-10 text-theme-primary border border-theme-primary-30 shadow-sm' 
                  : 'bg-slate-900 text-slate-400 border border-slate-700/60 hover:border-slate-500 hover:text-slate-200'
              }`}
              title="Show Strategy Buy Signals on Chart"
            >
              <Zap className="w-2.5 h-2.5" />
              <span>SIGNALS</span>
            </button>}

            <button
              onClick={() => setShowZScore(!showZScore)}
              className={`btn-tactile px-2 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer ${
                showZScore 
                  ? 'bg-theme-secondary-10 text-theme-secondary border border-theme-secondary-30 shadow-sm' 
                  : 'bg-slate-900 text-slate-400 border border-slate-700/60 hover:border-slate-500 hover:text-slate-200'
              }`}
              title="Toggle Z-Score Asymmetric Channels (Upper / Mean / Lower)"
            >
              Z-SCORE
            </button>

            <button
              onClick={() => setShowZigZag(!showZigZag)}
              className={`btn-tactile px-2 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer ${
                showZigZag 
                  ? 'bg-pink-500/20 text-pink-300 border border-pink-500/50 shadow-sm' 
                  : 'bg-slate-900 text-slate-400 border border-slate-700/60 hover:border-slate-500 hover:text-slate-200'
              }`}
              title="Toggle Zig-Zag Swing Pivots"
            >
              ZZ
            </button>

            <button
              onClick={() => setShowDonchian(!showDonchian)}
              className={`btn-tactile px-2 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer ${
                showDonchian 
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 shadow-sm' 
                  : 'bg-slate-900 text-slate-400 border border-slate-700/60 hover:border-slate-500 hover:text-slate-200'
              }`}
              title="Toggle Donchian Channels & Midpoint"
            >
              DON
            </button>

            <button
              onClick={() => setShowSR(!showSR)}
              className={`btn-tactile px-2 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer ${
                showSR 
                  ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/50 shadow-sm' 
                  : 'bg-slate-900 text-slate-400 border border-slate-700/60 hover:border-slate-500 hover:text-slate-200'
              }`}
              title="Toggle Extrema Support/Resistance Lines"
            >
              EXT-BIN
            </button>

            <button
              onClick={() => setShowEMA(!showEMA)}
              className={`btn-tactile px-2 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer ${
                showEMA 
                  ? 'bg-theme-primary-10 text-theme-primary border border-theme-primary-30 shadow-sm' 
                  : 'bg-slate-900 text-slate-400 border border-slate-700/60 hover:border-slate-500 hover:text-slate-200'
              }`}
              title="Toggle EMA 20 & EMA 50"
            >
              EMA
            </button>

            <button
              onClick={() => setShowRSI(!showRSI)}
              className={`btn-tactile px-2 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer ${
                showRSI 
                  ? 'bg-theme-secondary-10 text-theme-secondary border border-theme-secondary-30 shadow-sm' 
                  : 'bg-slate-900 text-slate-400 border border-slate-700/60 hover:border-slate-500 hover:text-slate-200'
              }`}
              title="Toggle RSI Oscillator"
            >
              RSI {hoverRsi !== null && showRSI ? `(${hoverRsi.toFixed(0)})` : ''}
            </button>

            <button
              onClick={() => setShowMACD(!showMACD)}
              className={`btn-tactile px-2 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer ${
                showMACD 
                  ? 'bg-theme-secondary-10 text-theme-secondary border border-theme-secondary-30 shadow-sm' 
                  : 'bg-slate-900 text-slate-400 border border-slate-700/60 hover:border-slate-500 hover:text-slate-200'
              }`}
              title="Toggle MACD Sub-pane"
            >
              MACD
            </button>
          </div>

          {/* Limit Order Action Button */}
          <button
            disabled={!hasHistory || !livePrice || livePrice <= 0}
            onClick={() => { if (livePrice && livePrice > 0) onPriceSelectedRef.current?.(livePrice, Math.floor(Date.now() / 1000)); }}
            className="btn-tactile flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-theme-gradient text-slate-950 text-[10px] font-extrabold font-mono transition-all shadow-glow-primary cursor-pointer"
            title="Open Limit Order Dialog at Live Price"
          >
            <Target className="w-3.5 h-3.5" />
            <span>+ Limit Order</span>
          </button>

          <button
            onClick={() => {
              if (chartRef.current) {
                chartRef.current.timeScale().fitContent();
              }
            }}
            className="btn-tactile p-1.5 rounded-lg bg-slate-900 border border-slate-700 hover:border-theme-primary text-slate-400 hover:text-white transition-colors cursor-pointer shadow-sm"
            title="Reset Zoom (Fit All Candles)"
          >
            <BarChart3 className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => loadKlines(interval, false, true)}
            disabled={isLoading}
            className="btn-tactile p-1.5 rounded-lg bg-slate-900 border border-slate-700 hover:border-theme-primary text-slate-400 hover:text-white transition-colors cursor-pointer shadow-sm"
            title="Refresh Candles"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-theme-primary' : ''}`} />
          </button>
        </div>
      </div>

      {/* Candlestick & Indicator Canvas Container */}
      <div className="flex-1 w-full min-h-0 rounded-lg overflow-hidden bg-background relative">
        <div 
          ref={containerRef} 
          className="h-full w-full cursor-crosshair"
          style={snapshotOnly ? { width: savedSettings.width || 1100, height: savedSettings.height || 650 } : undefined}
        />

        {isLoading && !hasHistory && !errorMessage && (
          <div role="status" className="absolute inset-0 z-20 bg-slate-950/80 flex items-center justify-center text-sm text-slate-300">
            Loading {token.symbol} chart history… Temporary connection failures will retry automatically.
          </div>
        )}

        {/* Error Overlay (Zero Fallbacks) */}
        {errorMessage && (
          <div className="absolute inset-0 z-30 bg-slate-950/80 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center">
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-2xl mb-3 text-red-400">
              <AlertTriangle className="w-8 h-8 mx-auto mb-2" />
              <div className="text-sm font-bold text-red-300 mb-1">Candlestick Feed Error</div>
              <div className="text-xs text-slate-400 max-w-md">{errorMessage}</div>
            </div>
            <button
              onClick={() => loadKlines(interval, true, true)}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry Query</span>
            </button>
          </div>
        )}

        {/* Floating Quick Stats on Chart */}
        <div className="absolute top-2 left-2 z-10 pointer-events-none flex items-center gap-2 text-[10px] font-mono bg-surface/90 border border-surface-border/80 px-2 py-1 rounded-md backdrop-blur-sm flex-wrap">
          <span className="text-slate-400 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
            {token.symbol}:
          </span>
          <span className="text-white font-bold">
            ${livePrice ? getPricePrecision(livePrice).format(livePrice) : '--.--'}
          </span>
          {hoverPrice !== null && (
            <>
              <span className="text-slate-600">|</span>
              <span className="text-amber-400">
                Cursor: ${getPricePrecision(hoverPrice).format(hoverPrice)}
              </span>
            </>
          )}
          {showDonchian && (
            <>
              <span className="text-slate-600">|</span>
              <span className="text-cyan-400 text-[9px]">DON</span>
              <span className="text-amber-400 text-[9px]">MID</span>
            </>
          )}
          {STRATEGIES_ENABLED && showSignals && strategyMarkers.length > 0 && (
            <>
              <span className="text-slate-600">|</span>
              <span className="text-emerald-400 text-[9px] font-bold flex items-center gap-0.5">
                <Zap className="w-2.5 h-2.5" />
                {strategyMarkers.length} Signals
              </span>
            </>
          )}
          <span className="text-slate-500 text-[9px] hidden sm:inline">
            | 💡 Right-click to Place • Click line/pill to Cancel
          </span>
        </div>

        {/* Floating Active Orders Compact Badges (Click to Cancel) */}
        {orders.filter((o) => 
          (o.status === 'open' || o.status === 'pending') && 
          ((o.limitPrice && o.limitPrice > 0) || (o.triggerPrice && o.triggerPrice > 0)) &&
          (o.sellToken?.toLowerCase() === token.address.toLowerCase() || o.buyToken?.toLowerCase() === token.address.toLowerCase()) &&
          o.chainId === chainId
        ).length > 0 && (
          <div className="absolute top-2 right-12 z-20 flex flex-wrap items-center justify-end gap-1.5 max-w-[calc(100%-140px)] pointer-events-auto">
            {orders
              .filter((o) => 
                (o.status === 'open' || o.status === 'pending') && 
                ((o.limitPrice && o.limitPrice > 0) || (o.triggerPrice && o.triggerPrice > 0)) &&
                (o.sellToken?.toLowerCase() === token.address.toLowerCase() || o.buyToken?.toLowerCase() === token.address.toLowerCase()) &&
                o.chainId === chainId
              )
              .map((order) => {
                const targetPrice = orderLimitPriceUsd(order, nativePriceSnapshot);
                const category = displayOrderCategory(order, orders);
                const isTp = category === 'take_profit';
                const isSl = category === 'stop_loss';
                const isSell = isTp || isSl || category === 'limit_sell' || order.type === 'BNB_TO_USDT';
                const isBuy = order.orderCategory === 'limit' || order.orderCategory === 'strategy_buy' || order.type === 'USDT_TO_BNB';
                const tag = order.externalOrderId || order.ocoGroupId || order.id;
                const ocoTag = tag ? `[${shortChartId(tag)}]` : '';
                const titleLabel = isTp ? `TP${ocoTag}` : isSl ? `SL${ocoTag}` : isSell ? `SELL${ocoTag}` : `BUY${ocoTag}`;
                
                return (
                  <button
                    key={order.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCancelOrder?.(order.id);
                    }}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-surface/95 border border-surface-border hover:border-rose-500 shadow-md cursor-pointer transition-all hover:bg-rose-950/80 group font-mono text-[10px] backdrop-blur-md select-none animate-in fade-in duration-150"
                    title={order.ocoGroupId ? `Click to cancel order [${shortChartId(order.ocoGroupId)}]` : 'Click to cancel this active order'}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isBuy || isTp ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400 animate-pulse'}`} />
                    <span className="font-semibold text-white">
                      {titleLabel} {targetPrice === undefined ? 'USD unavailable' : `$${getPricePrecision(targetPrice).format(targetPrice)}`}
                    </span>
                    <span className="text-[9px] text-rose-400 group-hover:text-rose-200 font-bold ml-0.5">
                      ✕
                    </span>
                  </button>
                );
              })}
          </div>
        )}
      </div>

    </div>
  );
});
