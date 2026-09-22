import React from 'react';
import type { ConfigurationField, Json } from '../../modules/contracts';

export function ModuleForm({ fields, values, disabled, onChange }: { fields: ConfigurationField[]; values: Record<string, Json>;
  disabled?: boolean; onChange(values: Record<string, Json>): void }) {
  return <div className="space-y-3">{fields.map(field => <label key={field.key} className="block text-xs text-slate-300">
    <span className="mb-1 block">{field.group ? `${field.group} · ` : ''}{field.label}</span>
    {field.type === 'boolean' ? <input type="checkbox" checked={Boolean(values[field.key] ?? field.default)} disabled={disabled}
      onChange={event => onChange({ ...values, [field.key]: event.target.checked })} /> : field.type === 'select' ?
      <select className="w-full rounded border border-slate-700 bg-slate-950 p-2" value={String(values[field.key] ?? field.default)} disabled={disabled}
        onChange={event => onChange({ ...values, [field.key]: event.target.value })}>
        {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : field.lines ? <textarea className="w-full resize-y whitespace-pre-wrap break-words rounded border border-slate-700 bg-slate-950 p-2 leading-relaxed"
        rows={field.lines} maxLength={field.maxLength ?? 2048} required={field.required} disabled={disabled}
        value={String(values[field.key] ?? field.default ?? '')}
        onChange={event => onChange({ ...values, [field.key]: event.target.value })} /> :
      <input className="w-full rounded border border-slate-700 bg-slate-950 p-2" type={field.type === 'number' ? 'number' : 'text'}
        step="any" min={field.min} max={field.max} maxLength={field.maxLength ?? 2048} required={field.required}
        value={String(values[field.key] ?? field.default ?? '')} disabled={disabled}
        onChange={event => onChange({ ...values, [field.key]: event.target.value })} />}
    {field.description && <span className="mt-1 block text-slate-500">{field.description}</span>}
  </label>)}</div>;
}
