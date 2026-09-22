import React, { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import type { TokenConfig, WalletState } from '../../types/trading';
import { useStrategyModules } from '../../hooks/useStrategyModules';
import { moduleRegistry } from '../../modules/registry';
import { moduleHost } from '../../modules/host';
import { DEFAULT_LIMITS, validateConfiguration, type Json, type SecretStatus } from '../../modules/contracts';
import { nativeStore } from '../../services/nativeStore';
import { systemLogService } from '../../services/systemLogService';
import { ModuleForm } from './ModuleForm';
import { ModuleView } from './ModuleView';
import { RunLimitForm, limitsToDraft, draftToLimits } from './RunLimitForm';

const configKey = 'haven_defi_terminal_module_config_saved_v1';
const chosenKey = 'haven_defi_terminal_module_token_strategies_v1';
const tokenKey = (chainId: number, tokenAddress: string) => `${chainId}:${tokenAddress.toLowerCase()}`;
function readChosen(): Record<string, string> {
  try { return JSON.parse(nativeStore.getItem(chosenKey) || '{}') as Record<string, string>; } catch { return {}; }
}
/** This workspace's own strategy choice. Each workspace keeps its own; nothing is shared. */
function useWorkspaceChoice(chainId: number, tokenAddress: string): string | null {
  return React.useSyncExternalStore(nativeStore.subscribe, () => readChosen()[tokenKey(chainId, tokenAddress)] ?? null);
}
const button = 'rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-40';
export function ModuleLibrary({ token, chainId, wallet }: { token: TokenConfig; chainId: number; wallet: WalletState | null }) {
  const library = useStrategyModules();
  const chosenId = useWorkspaceChoice(chainId, token.address);
  const selected = library.modules.find(m => m.moduleId === chosenId && m.status === 'installed') ?? library.modules.find(m => m.status === 'installed');
  const [values, setValues] = useState<Record<string, Json>>({});
  const [limits, setLimits] = useState(() => limitsToDraft(DEFAULT_LIMITS));
  const [secrets, setSecrets] = useState<SecretStatus>({ revision: 0, configured: [] });
  const [entered, setEntered] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [runAction, setRunAction] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const currentRuns = library.runs.filter(run => run.moduleId === selected?.moduleId && run.chainId === chainId && run.token.address.toLowerCase() === token.address.toLowerCase());
  // The run for this workspace. A stopped run must never hide a newer one, or the panel would keep
  // offering to resume a run the user has already replaced.
  const run = [...currentRuns].sort((a, b) => b.createdAt - a.createdAt)[0];
  const active = run?.status === 'running';
  const resumable = run?.status === 'paused' || run?.status === 'error';
  // A run that errored can only be resumed with the state that broke it, so the panel offers a
  // clean start as well. Resuming is kept for a run that was deliberately paused.
  const resumableStatus = run?.status;
  const report = (failure: unknown) => { const message = String(failure).slice(0, 600); setError(message); systemLogService.logError('STRATEGY', 'Module manager needs attention', message, chainId); };
  const action = async (operation: () => Promise<unknown>, label = '') => {
    setBusy(true); setRunAction(label); setError(''); try { await operation(); } catch (failure) { report(failure); } finally { setBusy(false); setRunAction(''); }
  };
  const importFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!/\.(?:dekxdis|haven)-module$/.test(file.name)) throw new Error('Choose a .dekxdis-module package');
      if (file.size > 2 * 1024 * 1024) throw new Error('Module exceeds the 2 MiB package limit');
      await moduleRegistry.install(await file.text());
    }
  };
  useEffect(() => {
    void moduleRegistry.refresh(true).catch(report);
    if (!isTauri()) return;
    let disposed = false, unlisten: (() => void) | undefined;
    void getCurrentWebviewWindow().onDragDropEvent(event => {
      if (event.payload.type === 'drop') void action(async () => {
        for (const path of event.payload.type === 'drop' ? event.payload.paths : []) await invoke('modules_install_path', { path });
        await moduleRegistry.refresh(false, true);
      });
    }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(report);
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    setEntered({}); setError(''); setSecrets({ revision: 0, configured: [] });
    if (!selected) { setValues({}); return; }
    const key = `${selected.moduleId}:${chainId}:${token.address.toLowerCase()}`;
    try {
      const saved = JSON.parse(nativeStore.getItem(configKey) || '{}')[key];
      setValues(Object.fromEntries(selected.manifest.configurationSchema.map(f => [f.key, saved?.values?.[f.key] ?? f.default])));
      setLimits(limitsToDraft(saved?.limits ?? DEFAULT_LIMITS));
    } catch (failure) { report(failure); }
    let disposed = false;
    void moduleRegistry.secretStatus(selected.moduleId).then(value => {
      if (!disposed) {
        setSecrets(value);
        if (value.conflicts?.length) report('This module has a different saved provider key. Save the key you want all modules to use.');
      }
    }).catch(report);
    return () => { disposed = true; };
  }, [selected?.packageHash, selected?.generation, chainId, token.address]);
  const saveKey = async (slotId: string) => {
    if (!selected || !entered[slotId]) return;
    setSecrets(await moduleHost.secret(selected.moduleId, slotId, entered[slotId]));
    setEntered(previous => ({ ...previous, [slotId]: '' }));
  };
  const save = async () => {
    if (!selected) return;
    const checked = validateConfiguration(selected.manifest, values);
    const checkedLimits = draftToLimits(limits, selected.manifest.tradeCountControl === 'module',
      selected.manifest.orderAmountControl === 'module');
    if (!nativeStore.isHealthy()) throw new Error('Open the Windows desktop app with an available wallet');
    for (const slot of selected.manifest.secretSlots) await saveKey(slot.id);
    const saved = JSON.parse(nativeStore.getItem(configKey) || '{}');
    saved[`${selected.moduleId}:${chainId}:${token.address.toLowerCase()}`] = { packageHash: selected.packageHash, values: checked, limits: checkedLimits };
    nativeStore.setItem(configKey, JSON.stringify(saved)); await nativeStore.flush();
    return { configuration: checked, limits: checkedLimits };
  };
  return <section className="h-full overflow-auto bg-background p-4 text-slate-200" aria-label="Strategy Modules"
    onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (event.dataTransfer.files.length) void action(() => importFiles(event.dataTransfer.files)); }}>
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <h2 className="mr-auto text-sm font-semibold">Strategy Modules</h2>
      <button type="button" className={button} disabled={busy || !isTauri()} onClick={() => input.current?.click()}>Add module</button>
      <a className={button} href="https://dekxdis.com/#modules" target="_blank" rel="noreferrer">Get modules</a>
      <input ref={input} className="hidden" type="file" accept=".dekxdis-module,.haven-module" aria-label="Choose module package"
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void action(() => importFiles(files)); }} />
    </div>
    {error && <p role="alert" className="mb-3 break-words text-xs text-red-300">{error}</p>}
    {library.diagnostics.map((message, i) => <p role="status" key={i} className="mb-2 break-words text-xs text-amber-300">{message}</p>)}
    {!isTauri() && <p className="mb-3 text-xs text-slate-400">Install and run modules in the Windows desktop app.</p>}
    {library.modules.length === 0 ? <div className="rounded border border-dashed border-slate-700 p-5 text-sm">
      <p>No modules installed.</p><p className="mt-2 text-xs text-slate-400">Add a downloaded .dekxdis-module package to see its settings. Installing a module does not start it.</p>
    </div> : <div className="mb-4 space-y-2">{library.modules.map(module => <div key={module.moduleId} className="flex items-start gap-2 rounded border border-slate-700 p-2">
      <button className="min-w-0 flex-1 text-left" disabled={busy || module.status !== 'installed'} onClick={() => void action(() => moduleHost.chooseForToken(token, chainId, module.moduleId))}>
        <span className="block text-sm">{module.manifest.name}{selected?.moduleId === module.moduleId ? ' · Selected' : ''}</span>
        <span className="text-xs text-slate-500">{module.manifest.moduleVersion} · {module.status}</span>
      </button><button className={button} disabled={busy} onClick={() => void action(() => moduleHost.remove(module.moduleId))}>Remove</button>
    </div>)}</div>}
    {library.inboxPath && <details className="my-3 text-xs text-slate-500"><summary>Module inbox</summary><p className="mt-1 break-all select-text">{library.inboxPath}</p><button className={`${button} mt-2`} disabled={busy} onClick={() => void action(() => moduleRegistry.refresh(true))}>Scan inbox</button></details>}
    {selected?.status === 'installed' && <div className="space-y-4">
      <p className="text-xs leading-relaxed text-slate-400">{selected.manifest.description}</p>
      <p className="text-xs">Run token: {token.symbol} · Chain {chainId}</p>
      <ModuleForm fields={selected.manifest.configurationSchema} values={values} onChange={setValues} disabled={busy || active} />
      {selected.manifest.secretSlots.map(slot => <div key={slot.id} className="space-y-1 text-xs">
        <label className="block">{slot.label}{secrets.configured.includes(slot.id) ? ' · Saved in Windows' : slot.required ? ' · Required' : ''}
          <input type="password" autoComplete="new-password" placeholder={secrets.configured.includes(slot.id) ? 'Saved key ready to use. Enter a key only to replace it.' : 'Enter API key'} maxLength={8192} value={entered[slot.id] ?? ''} disabled={busy} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 p-2"
            onChange={event => setEntered({ ...entered, [slot.id]: event.target.value })} /></label>
        {secrets.shared?.includes(slot.id) && <p className="text-slate-400">Saved securely for all modules using this provider. Kept when modules are updated or removed. Replacing or deleting it applies to all those modules.</p>}
        {secrets.conflicts?.includes(slot.id) && <p role="alert" className="text-amber-300">This module has a different saved key for the same provider. Save the key you want all modules to use.</p>}
        <button className={button} disabled={busy || !entered[slot.id]} onClick={() => void action(() => saveKey(slot.id))}>Save key</button>
        {secrets.configured.includes(slot.id) && <button className={`${button} ml-2`} disabled={busy} onClick={() => void action(async () => { setSecrets(await moduleHost.secret(selected.moduleId, slot.id, null)); })}>Delete saved key</button>}
      </div>)}
      <RunLimitForm value={limits} onChange={setLimits} disabled={busy || active}
        moduleTradeCounts={selected.manifest.tradeCountControl === 'module'}
        moduleOrderAmount={selected.manifest.orderAmountControl === 'module'} />
      <div className="flex gap-2"><button className={button} disabled={busy || active || !wallet} onClick={() => void action(save)}>Save settings</button>
        <button className={`${button} border-emerald-700`} disabled={busy || !wallet} onClick={() => void action(async () => {
          if (active) await moduleHost.pause(run.runId);
          else { const saved = await save(); if (saved) {
            if (resumable && run && resumableStatus === 'paused') await moduleHost.resume(run.runId, saved.configuration, saved.limits, wallet!);
            else await moduleHost.start(selected.moduleId, token, chainId, saved.configuration, saved.limits, wallet!);
          } }
        }, active ? 'Pausing…' : resumable && resumableStatus === 'paused' ? 'Resuming…' : 'Starting…')}>{runAction || (active ? 'Pause' : resumable && resumableStatus === 'paused' ? 'Resume' : 'Start')}</button>
        {resumable && resumableStatus === 'error' && <button className={button} disabled={busy || !wallet} onClick={() => void action(async () => {
          const saved = await save();
          if (saved) await moduleHost.start(selected.moduleId, token, chainId, saved.configuration, saved.limits, wallet!);
        }, 'Starting…')}>Start fresh</button>}</div>
      <ModuleView manifest={selected.manifest} run={run} onAction={name => run && void action(() => moduleHost.ui(run.runId, name))} />
    </div>}
  </section>;
}
