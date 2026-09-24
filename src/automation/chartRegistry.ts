import type { TradeOrder } from '../types/trading';
export interface ChartCapture {
  image: string; capturedAt: number; interval: string; lastCandle: unknown;
  orders: TradeOrder[]; width: number; height: number;
}
const charts = new Map<string, () => ChartCapture>();
export function registerChart(key: string, capture: () => ChartCapture) {
  charts.set(key, capture);
  return () => { if (charts.get(key) === capture) charts.delete(key); };
}
export const visibleChart = (key: string) => charts.get(key);
