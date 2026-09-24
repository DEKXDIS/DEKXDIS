import { tradingQuoteUsdPrice } from '../services/tradingQuote';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { storageService } from '../services/storageService';
import { readChartView, workspaceKey, type Workspace } from './settings';
import { visibleChart, type ChartCapture } from './chartRegistry';

export async function captureWorkspace(w: Workspace, signal: AbortSignal): Promise<ChartCapture> {
  signal.throwIfAborted();
  const key = workspaceKey(w.owner, w.chainId, w.token.address);
  const visible = visibleChart(key);
  if (visible) return visible();
  const { TradingViewChart } = await import('../components/TradingViewChart');
  signal.throwIfAborted();
  const nativePriceSnapshot = { chainId: w.chainId, price: await tradingQuoteUsdPrice(w.chainId), timestamp: Date.now() };
  signal.throwIfAborted();
  const view = readChartView(key, storageService.getChartSettings());
  const container = document.createElement('div');
  // On demand only: background workspaces have no continuously mounted extra chart.
  Object.assign(container.style, { position: 'fixed', left: '-20000px', top: '0',
    width: `${view.width || 1100}px`, height: `${(view.height || 650) + 42}px`, pointerEvents: 'none' });
  container.setAttribute('aria-hidden', 'true');
  document.body.appendChild(container);
  const root = createRoot(container);
  function SnapshotChart({ ready, failed }: { ready: (capture: () => ChartCapture) => void; failed: (error: string) => void }) {
    const [orders, setOrders] = useState(() => storageService.getOrders());
    const [quote, setQuote] = useState<typeof nativePriceSnapshot | undefined>(nativePriceSnapshot);
    useEffect(() => storageService.subscribe(() => setOrders(storageService.getOrders())), []);
    useEffect(() => {
      const timer = setTimeout(() => setQuote(undefined), Math.max(0, nativePriceSnapshot.timestamp + 30000 - Date.now()));
      return () => clearTimeout(timer);
    }, []);
    return <TradingViewChart token={w.token} chainId={w.chainId} orders={orders} nativePriceSnapshot={quote}
      chartMarkers={storageService.getChartMarkers()} strategyConfig={storageService.getTokenStrategies()[`${w.chainId}_${w.token.address.toLowerCase()}`] || storageService.getStrategyConfig(w.chainId)}
      snapshotOnly onCaptureReady={ready} onCaptureError={failed} />;
  }
  try {
    return await new Promise<ChartCapture>((resolve, reject) => {
      let finished = false;
      const finish = (value?: ChartCapture, error?: unknown) => {
        if (finished) return; finished = true;
        clearTimeout(timeout); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value!);
      };
      const abort = () => finish(undefined, new Error('Automation stopped'));
      const timeout = setTimeout(() => finish(undefined, new Error('Chart capture timed out')), 45000);
      signal.addEventListener('abort', abort, { once: true });
      root.render(<SnapshotChart ready={capture => {
          try { signal.throwIfAborted(); finish(capture()); } catch (error) { finish(undefined, error); }
        }} failed={error => finish(undefined, new Error(error))} />);
    });
  } finally { root.unmount(); container.remove(); }
}
