import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Json, ModuleManifest } from '../../modules/contracts';
import type { ModuleRun } from '../../modules/stateStore';

function display(value: Json | undefined) { return value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
function ModuleImage({ run, handle, label }: { run: ModuleRun; handle: Json | undefined; label: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let disposed = false; setUrl('');
    if (typeof handle !== 'string') return;
    void invoke<string>('modules_blob_preview', {
      identity: { moduleId: run.moduleId, packageHash: run.packageHash, generation: run.generation },
      scope: { runId: run.runId, walletAddress: run.walletAddress, walletGeneration: run.walletGeneration,
        configurationRevision: run.configurationRevision, secretRevision: run.secretRevision }, handle,
    }).then(value => { if (!disposed && value.startsWith('data:image/png;base64,')) setUrl(value); }).catch(() => { if (!disposed) setUrl(''); });
    return () => { disposed = true; };
  }, [handle, run.runId, run.generation, run.status]);
  return url ? <img src={url} alt={label} className="h-auto w-full rounded border border-slate-800" /> : <span className="text-slate-500">Image preview expired or unavailable</span>;
}
export function ModuleView({ manifest, run, onAction }: { manifest: ModuleManifest; run?: ModuleRun; onAction(name: string): void }) {
  if (!run) return null;
  return <div className="space-y-2 border-t border-slate-800 pt-3 text-xs">
    <p className="capitalize text-slate-200">{run.token.symbol}: {run.status}</p>
    {run.error && <p role="alert" className="break-words text-red-300">{run.error}</p>}
    {manifest.viewSchema.fields.map(field => <div key={field.key} className="space-y-1">
      <div className="text-slate-500">{field.label}</div>
      {field.type === 'image' ? <ModuleImage run={run} handle={run.view[field.key]} label={field.label} /> : field.type === 'table' && Array.isArray(run.view[field.key]) ? <div className="overflow-auto"><table className="w-full text-left"><tbody>
        {(run.view[field.key] as Json[]).slice(0, 20).map((row, i) => <tr key={i}>{(Array.isArray(row) ? row : [row]).slice(0, 8).map((cell, j) => <td key={j} className="border-b border-slate-800 p-1">{display(cell)}</td>)}</tr>)}
      </tbody></table></div> : <div className="break-words text-slate-200">{display(run.view[field.key])}</div>}
    </div>)}
    {manifest.viewSchema.buttons.map(button => <button key={button.id} type="button" disabled={run.status !== 'running'}
      onClick={() => onAction(button.id)} className="mr-2 rounded border border-slate-600 px-2 py-1 disabled:opacity-40">{button.label}</button>)}
  </div>;
}
