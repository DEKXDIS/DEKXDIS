/** DEKXDIS module ABI v1. No executable package source is imported by the WebView. */
import { formatUnits, parseUnits } from 'ethers';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const HOST_API_VERSION = 1;
export const HOST_VERSION = '1.2.6';
export const CAPABILITIES = ['market.price.v1', 'market.candles.v1', 'chart.snapshot.v1',
  'events.schedule.v1', 'state.module.v1', 'http.request.v1', 'secrets.inject.v1',
  'orders.limit-entry.v1', 'orders.limit-exit.v1', 'orders.protection.v1', 'orders.observe.v1', 'orders.cancel.v1', 'orders.funding.v1',
  'ui.module.v1', 'log.module.v1'] as const;
export type Capability = typeof CAPABILITIES[number];
export const TIMEFRAMES: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
export interface ConfigurationField {
  key: string; label: string; type: 'string' | 'number' | 'boolean' | 'select';
  default: Json; required?: boolean; min?: number; max?: number; maxLength?: number;
  options?: { label: string; value: string }[]; description?: string; group?: string;
  /** For long text such as instructions: shown as a wrapped, multi-line box. */
  lines?: number;
}
export interface SecretSlot { id: string; label: string; required: boolean; }
export interface EndpointDeclaration {
  id: string; origin: string; path: string; method: 'GET' | 'POST';
  authentication?: { slotId: string; placement: 'header' | 'body'; name: string; prefix?: string };
}
export interface ModuleManifest {
  /** 'module' when the module's own settings carry the trade counts, so the run limits omit them. */
  tradeCountControl?: 'module';
  /** 'module' when the module's own settings carry the per-order amount, so the run limits omit it. */
  orderAmountControl?: 'module';
  moduleId: string; moduleVersion: string; name: string; description: string;
  hostApiVersion: 1; minimumHostVersion: string; requestedCapabilities: Capability[];
  supportedChains: number[]; configurationSchema: ConfigurationField[]; secretSlots: SecretSlot[];
  viewSchema: { fields: { key: string; label: string; type: 'text' | 'number' | 'image' | 'table' }[];
    buttons: { id: string; label: string }[] };
  endpointDeclarations: EndpointDeclaration[];
  eventSubscriptions: ({ type: 'timer'; intervalMs: number } |
    { type: 'candle-close'; timeframe: string } | { type: 'price'; intervalMs: number } | { type: 'order' })[];
  stateSchemaVersion: number;
  resourceRequirements: { memoryMb: number; cpuMs: number; maxStateBytes: number };
}
export interface ModuleIdentity { moduleId: string; packageHash: string; generation: number; }
export interface InstalledModule extends ModuleIdentity {
  manifest: ModuleManifest; status: 'installed' | 'disabled' | 'removing'; error?: string;
}
export interface RegistrySnapshot {
  modules: InstalledModule[]; selectedModuleId: string | null; inboxPath: string; diagnostics: string[];
}
export interface RunLimits {
  maxOrders: number; maxOpenOrders: number; maxQuotePerOrder: string; maxTotalQuote: string;
  maxRequestsPerMinute: number; maxDataAgeMs: number; orderExpirySeconds: number;
}
export const DEFAULT_LIMITS: RunLimits = { maxOrders: 1, maxOpenOrders: 1, maxQuotePerOrder: '10',
  maxTotalQuote: '10', maxRequestsPerMinute: 12, maxDataAgeMs: 120000, orderExpirySeconds: 86400 };
export interface ModuleEvent {
  id: string; type: 'start' | 'timer' | 'candle-close' | 'price' | 'order' | 'capability-result' |
    'capability-error' | 'pause' | 'recovery' | 'ui';
  time: number; requestId?: string; name?: string; data?: Json; error?: string;
}
export interface ModuleContext {
  hostApiVersion: 1; moduleId: string; moduleVersion: string; runId: string; now: number;
  chainId: number; token: { address: string; symbol: string; decimals: number };
  configuration: Record<string, Json>; limits: RunLimits;
  /** Current workspace chart interval, supplied by host 1.2.2 and later. */
  chart?: { timeframe: string };
  /** Native-injected signed resources; never supplied by another module or wallet. */
  resources?: Record<string, Json>;
}
export interface ModuleRequest { id: string; capability: Capability; input: { [key: string]: Json }; }
export interface ModuleOutput { nextState: Json; requests: ModuleRequest[]; view?: Record<string, Json>; }
export interface Protection { basis: 'fixed' | 'actual-fill'; takeProfit?: number; stopLoss?: number; takeProfitValidity?: 'maximum'; }
export interface LimitEntryInput {
  price: number; quoteAmount: string; protection?: Protection;
  /** Required for decisions based on a market/chart/HTTP result; host checks its age. */
  basisRequestId?: string;
}
export interface LimitExitInput {
  parentOrderId: string; price: number; quantity?: string; basisRequestId?: string;
}
/** Read-only funding for a USD-sized entry; quantities are wrapped-native token units. */
export interface ModuleFunding {
  status: 'ready' | 'insufficient-funds'; affordableOrders: number;
  chainId: number; tokenAddress: string; symbol: string; decimals: number; quoteUsdPrice: number;
  balance: string; reserved: string; available: string; required: string;
  balanceUsd: string; reservedUsd: string; availableUsd: string; requiredUsd: string; message: string;
}
export interface HttpInput {
  endpointId: string; body?: Json; headers?: Record<string, string>;
  /** Host inserts only a run-scoped chart handle at an existing JSON pointer. */
  attachments?: { handle: string; pointer: string; encoding: 'data-url' | 'base64' }[];
}
export interface ChartInput {
  timeframe: string; count: number; width?: number; height?: number;
  indicators?: { ema?: number[]; sma?: number[]; rsi?: number; macd?: boolean; volume?: boolean };
}
export interface NativeScope {
  runId: string; walletAddress: string; walletGeneration: number; configurationRevision: number; secretRevision: number;
}
export interface SecretStatus { revision: number; configured: string[]; shared?: string[]; conflicts?: string[]; }

export function validateConfiguration(manifest: ModuleManifest, input: Record<string, Json>): Record<string, Json> {
  const output: Record<string, Json> = {};
  for (const field of manifest.configurationSchema) {
    const value = input[field.key] ?? field.default;
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${field.label} must be true or false`);
    } else if (field.type === 'number') {
      const n = Number(value);
      if ((typeof value !== 'string' && typeof value !== 'number') || value === '' || !Number.isFinite(n) ||
        (field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) throw new Error(`${field.label} is outside its allowed range`);
    } else {
      if (typeof value !== 'string' || value.length > (field.maxLength ?? 2048) || (field.required && !value.trim())) throw new Error(`${field.label} is invalid`);
      if (field.type === 'select' && !field.options?.some(o => o.value === value)) throw new Error(`${field.label} is not a supported choice`);
    }
    output[field.key] = value;
  }
  return output;
}
export function validateLimits(limits: RunLimits): void {
  for (const [key, min, max] of [['maxOrders', 0, Number.MAX_SAFE_INTEGER], ['maxOpenOrders', 0, Number.MAX_SAFE_INTEGER], ['maxRequestsPerMinute', 1, 60],
    ['maxDataAgeMs', 1000, 300000], ['orderExpirySeconds', 60, 2592000]] as const) {
    if (!Number.isInteger(limits[key]) || limits[key] < min || limits[key] > max) throw new Error(`Invalid run limit: ${key}`);
  }
  for (const key of ['maxQuotePerOrder', 'maxTotalQuote'] as const) {
    if (!/^\d+(\.\d{1,18})?$/.test(limits[key]) || !Number.isFinite(Number(limits[key])) ||
      (key === 'maxTotalQuote' && limits.maxOrders === 0 ? Number(limits[key]) < 0 : Number(limits[key]) <= 0)) throw new Error(`Invalid run limit: ${key}`);
  }
  if (Number(limits.maxTotalQuote) !== 0 && Number(limits.maxQuotePerOrder) > Number(limits.maxTotalQuote)) throw new Error('Per-order size exceeds the total run budget');
}

/**
 * The run limits as the settings form edits them, and back again.
 *
 * These live here rather than in the form because the host also needs them: the limits a strategy is
 * held to are read from what is saved, so editing them takes effect without starting a new run.
 */
export const DURATION_UNITS = { minutes: 60, hours: 3600, days: 86400 };
export interface LimitDraft {
  maxQuotePerOrder: string; maxOrders: string; maxOpenOrders: string; maxRequestsPerMinute: string;
  duration: string; unit: keyof typeof DURATION_UNITS;
}
export function limitsToDraft(limits: RunLimits): LimitDraft {
  const seconds = limits.orderExpirySeconds;
  const unit = seconds % 86400 === 0 ? 'days' : seconds % 3600 === 0 ? 'hours' : 'minutes';
  return { maxQuotePerOrder: limits.maxQuotePerOrder, maxOrders: String(limits.maxOrders),
    maxOpenOrders: String(limits.maxOpenOrders), maxRequestsPerMinute: String(limits.maxRequestsPerMinute),
    duration: String(seconds / DURATION_UNITS[unit]), unit };
}
export function draftToLimits(draft: LimitDraft, moduleTradeCounts = false, moduleOrderAmount = false): RunLimits {
  for (const [key, label] of [['duration', 'Order expiry']] as const) {
    if (!draft[key].trim() || !Number.isFinite(Number(draft[key])) || Number(draft[key]) <= 0) throw new Error(`${label} must be a positive number`);
  }
  // A module that carries its own order amount is not given a spending authorisation by the run
  // limits: its own settings decide how much each order is, and the balance decides whether an
  // order can be placed at all. There is no run total to exceed, so that setting is not asked for.
  let perOrder = draft.maxQuotePerOrder;
  let total = '0';
  if (!moduleOrderAmount) {
    if (!/^\d+(\.\d{1,18})?$/.test(draft.maxQuotePerOrder)) throw new Error('Amount for this run (USD) must be 0 (unlimited) or a positive number');
    // Zero means no limit on what this run may spend. The per-order authorization is then left wide
    // with the total, so nothing refuses an order for budget reasons.
    const unlimited = Number(draft.maxQuotePerOrder) === 0;
    if (!unlimited && Number(draft.maxQuotePerOrder) <= 0) throw new Error('Amount for this run (USD) must be 0 (unlimited) or a positive number');
    const wide = '1000000000000000000';
    perOrder = unlimited ? wide : draft.maxQuotePerOrder;
    total = unlimited ? '0' : formatUnits(parseUnits(draft.maxQuotePerOrder, 18) * BigInt(moduleTradeCounts ? 0 : Number(draft.maxOrders)), 18);
  } else {
    perOrder = '1000000000000000000';
  }
  const entries = moduleTradeCounts ? 0 : Number(draft.maxOrders);
  const open = moduleTradeCounts ? 0 : Number(draft.maxOpenOrders);
  if (!moduleTradeCounts && (!draft.maxOrders.trim() || !Number.isSafeInteger(entries) || entries < 0)) throw new Error('Maximum trades must be 0 (unlimited) or a positive whole number');
  if (!moduleTradeCounts && (!draft.maxOpenOrders.trim() || !Number.isSafeInteger(open) || open < 1)) throw new Error('Maximum open trades must be a positive whole number');
  const limits: RunLimits = { ...DEFAULT_LIMITS,
    maxQuotePerOrder: perOrder, maxOrders: entries, maxOpenOrders: open, maxRequestsPerMinute: 60,
    orderExpirySeconds: Number(draft.duration) * DURATION_UNITS[draft.unit],
    maxTotalQuote: total };
  validateLimits(limits);
  return limits;
}
