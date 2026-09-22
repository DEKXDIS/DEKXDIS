import React from 'react';
import { DURATION_UNITS, draftToLimits, limitsToDraft, type LimitDraft } from '../../modules/contracts';

export { DURATION_UNITS, limitsToDraft, draftToLimits };
export type { LimitDraft };
export function RunLimitForm({ value, onChange, disabled, moduleTradeCounts = false, moduleOrderAmount = false }:
  { value: LimitDraft; onChange(value: LimitDraft): void; disabled?: boolean;
    moduleTradeCounts?: boolean; moduleOrderAmount?: boolean }) {
  const inputClass = 'w-24 rounded border border-slate-700 bg-slate-950 p-1';
  return <fieldset disabled={disabled} className="space-y-2 rounded border border-slate-800 p-3"><legend className="px-1 text-xs">Run limits</legend>
    {/* A module that carries its own order amount is asked only for its order expiry: there is no
        run spending total for it, so that setting is not shown. */}
    {!moduleOrderAmount && <label className="flex items-center justify-between gap-2 text-xs"><span>Maximum amount per order (USD)</span>
      <input type="number" min="0" step="any" className={inputClass} value={value.maxQuotePerOrder}
        onChange={event => onChange({ ...value, maxQuotePerOrder: event.target.value })} />
    </label>}
    {!moduleTradeCounts && ([['maxOrders', 'Maximum trades (0 = unlimited)'], ['maxOpenOrders', 'Maximum open trades']] as const).map(([key, label]) =>
      <label key={key} className="flex items-center justify-between gap-2 text-xs"><span>{label}</span>
        <input type="number" min={key === 'maxOpenOrders' ? '1' : '0'} step="1"
          className={inputClass} value={value[key]} onChange={event => onChange({ ...value, [key]: event.target.value })} />
      </label>)}
    <div className="flex items-center justify-between gap-2 text-xs"><label htmlFor="module-order-expiry">Order expiry</label>
      <div className="flex gap-1"><input id="module-order-expiry" type="number" min="0" step="any" className={inputClass}
        value={value.duration} onChange={event => onChange({ ...value, duration: event.target.value })} />
        <select aria-label="Order expiry unit" className="rounded border border-slate-700 bg-slate-950 p-1" value={value.unit}
          onChange={event => onChange({ ...value, unit: event.target.value as LimitDraft['unit'] })}>
          <option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option>
        </select></div>
    </div>
  </fieldset>;
}
