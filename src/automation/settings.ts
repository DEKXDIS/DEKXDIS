import type { ChartUserSettings, TokenConfig } from '../types/trading';

export const workspaceKey = (owner: string, chain: number, token: string) => `${owner.toLowerCase()}:${chain}:${token.toLowerCase()}`;
export interface AutomationSettings {
  prompt: string; model: string; intervalSeconds: number; tradeIntervalSeconds: number;
  maxOpenBuys: number; amountMode: 'fixed' | 'model'; amount: string; amountUnit: 'usd' | 'token'; historyCount: number;
}
export const defaultSettings: AutomationSettings = {
  prompt: '', model: '', intervalSeconds: 60, tradeIntervalSeconds: 0,
  maxOpenBuys: 4, amountMode: 'fixed', amount: '10', amountUnit: 'usd', historyCount: 20,
};
const prefix = 'dekxdis_automation_settings_v1:';
export function readSettings(key: string): AutomationSettings {
  try { return { ...defaultSettings, ...JSON.parse(localStorage.getItem(prefix + key) || '{}') }; }
  catch { return { ...defaultSettings }; }
}
export function validateSettings(s: AutomationSettings) {
  if (!s.prompt.trim() || !s.model.trim()) throw new Error('Enter your instructions and an image-capable model ID');
  for (const [label, value, minimum] of [ ['Check interval', s.intervalSeconds, 1], ['Time between trades', s.tradeIntervalSeconds, 0],
    ['Maximum open buys', s.maxOpenBuys, 0], ['Recent history', s.historyCount, 0] ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be a whole number of at least ${minimum}`);
  }
  if (!['fixed', 'model'].includes(s.amountMode) || !['usd', 'token'].includes(s.amountUnit)) throw new Error('Invalid amount setting');
  if (s.amountMode === 'fixed' && (!/^\d+(\.\d+)?$/.test(s.amount) || !Number.isFinite(Number(s.amount)) || Number(s.amount) <= 0)) throw new Error('Enter a positive order amount');
}
export function saveSettings(key: string, settings: AutomationSettings) {
  // Only the form values live here. No images, packets, decisions, orders or run state.
  localStorage.setItem(prefix + key, JSON.stringify(settings));
}
export interface ChartView extends ChartUserSettings { width?: number; height?: number; candleCount?: number }
const viewKey = (key: string) => 'dekxdis_chart_view_v1:' + key;
export function readChartView(key: string, fallback: ChartUserSettings): ChartView {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(viewKey(key)) || '{}') }; } catch { return fallback; }
}
export function saveChartView(key: string, changes: Partial<ChartView>) {
  const previous = JSON.parse(localStorage.getItem(viewKey(key)) || '{}');
  const value = JSON.stringify({ ...previous, ...changes });
  if (localStorage.getItem(viewKey(key)) !== value) localStorage.setItem(viewKey(key), value);
}
export type Workspace = { owner: string; token: TokenConfig; chainId: number };
