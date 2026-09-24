import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TokenConfig, TradeOrder, WalletState } from '../types/trading';
import { automation } from './runner';
import { readSettings, saveSettings, validateSettings, workspaceKey, type AutomationSettings } from './settings';
import { openBuyCount, RESPONSE_FORMAT } from './packet';

interface Props { selectedToken: TokenConfig; selectedChainId: number; wallet: WalletState | null; orders: TradeOrder[]; onRequireWallet: () => void }
export function AutomationWindow({ selectedToken: token, selectedChainId: chainId, wallet, orders, onRequireWallet }: Props) {
  const key = workspaceKey(wallet?.address || 'preview', chainId, token.address);
  const [settings, setSettings] = useState(() => readSettings(key));
  const [apiKey, setApiKey] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [message, setMessage] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const subscribe = useCallback((fn: () => void) => automation.subscribeWorkspace(key, fn), [key]);
  const status = useSyncExternalStore(subscribe, () => automation.status(key));
  useEffect(() => { let current = true; invoke<boolean>('automation_key_status').then(value => { if (current) setKeySaved(value); }).catch(() => {});
    return () => { current = false; }; }, []);
  const field = <K extends keyof AutomationSettings>(name: K, value: AutomationSettings[K]) => setSettings(s => ({ ...s, [name]: value }));
  const save = () => { validateSettings(settings); saveSettings(key, settings); };
  const start = () => {
    if (!wallet) { onRequireWallet(); return; }
    try { if (!keySaved) throw new Error('Save an OpenAI API key first'); save();
      automation.start({ owner: wallet.address, token, chainId }, settings); setMessage(''); }
    catch (error) { setMessage(String(error instanceof Error ? error.message : error)); }
  };
  const inputClass = 'w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100';
  const w = { owner: wallet?.address || '', token, chainId };
  return <div className="h-full overflow-auto bg-surface p-3 text-xs text-slate-300 space-y-3">
    <div className="flex justify-between gap-2"><strong className="text-white">Automation · {token.symbol}</strong>
      <span>{openBuyCount(orders, w)} open buys</span></div>
    <p>Each check uses this token’s chart, orders, positions and recent history. Enabled tokens keep running when you switch workspaces.</p>
    <fieldset disabled={status.running} className="space-y-3 disabled:opacity-70">
      <label className="block space-y-1"><span>Instructions</span><textarea aria-label="Automation instructions" className={inputClass} rows={7}
        value={settings.prompt} onChange={e => field('prompt', e.target.value)} placeholder="Describe what you want the model to do with the chart and trades." /></label>
      <label className="block space-y-1"><span>OpenAI model ID (must accept images)</span><input className={inputClass} value={settings.model} onChange={e => field('model', e.target.value)} /></label>
      <div className="grid grid-cols-2 gap-2">
        <label>Check every (seconds)<input type="number" min="1" className={inputClass} value={settings.intervalSeconds} onChange={e => field('intervalSeconds', Number(e.target.value))} /></label>
        <label>Time between trades (seconds)<input type="number" min="0" className={inputClass} value={settings.tradeIntervalSeconds} onChange={e => field('tradeIntervalSeconds', Number(e.target.value))} /></label>
        <label>Max open buys (0 = unlimited)<input type="number" min="0" className={inputClass} value={settings.maxOpenBuys} onChange={e => field('maxOpenBuys', Number(e.target.value))} /></label>
        <label>Recent history entries<input type="number" min="0" className={inputClass} value={settings.historyCount} onChange={e => field('historyCount', Number(e.target.value))} /></label>
      </div>
      <p>Only unfilled buy orders count toward the maximum. Filled buys and their TP/SL orders do not count.</p>
      <label className="block">Order amount<select className={inputClass} value={settings.amountMode} onChange={e => field('amountMode', e.target.value as AutomationSettings['amountMode'])}>
        <option value="fixed">Fixed amount per trade</option><option value="model">Model chooses each amount</option></select></label>
      {settings.amountMode === 'fixed' && <div className="grid grid-cols-2 gap-2"><label>Amount<input className={inputClass} value={settings.amount} onChange={e => field('amount', e.target.value)} /></label>
        <label>Unit<select className={inputClass} value={settings.amountUnit} onChange={e => field('amountUnit', e.target.value as 'usd' | 'token')}><option value="usd">USD value</option><option value="token">{token.symbol}</option></select></label></div>}
    </fieldset>
    <div className="flex gap-2">
      <button className="rounded bg-slate-700 px-3 py-2 disabled:opacity-50" disabled={status.running} onClick={() => { try { save(); setMessage('Settings saved'); } catch (error) { setMessage(String(error)); } }}>Save settings</button>
      <button className={`rounded px-4 py-2 font-semibold ${status.running ? 'bg-red-900 text-red-100' : 'bg-emerald-800 text-white'}`} disabled={!status.running && status.busy}
        onClick={() => status.running ? automation.stop(key) : start()}>{status.running ? 'Stop' : status.busy ? 'Finishing request…' : 'Start'}</button>
    </div>
    <div role="status" className="rounded border border-slate-700 p-2 break-words"><p>{status.message}</p>
      {status.checkedAt && <p className="text-slate-500">Last check: {new Date(status.checkedAt).toLocaleTimeString()}</p>}
      {status.nextAt && <p className="text-slate-500">Next check: {new Date(status.nextAt).toLocaleTimeString()}</p>}</div>
    {message && <p role="status" className="text-amber-300 break-words">{message}</p>}
    <details><summary className="cursor-pointer">OpenAI API key · {keySaved ? 'Saved' : 'Not configured'}</summary>
      <div className="mt-2 flex gap-2"><input type="password" aria-label="OpenAI API key" autoComplete="off" className={inputClass} value={apiKey} onChange={e => setApiKey(e.target.value)} />
        <button disabled={!apiKey.trim() || savingKey} className="rounded bg-slate-700 px-3 disabled:opacity-50" onClick={async () => { setSavingKey(true); try {
          await invoke('automation_key_save', { key: apiKey }); setApiKey(''); setKeySaved(true); setMessage('API key saved');
        } catch (error) { setMessage(String(error)); } finally { setSavingKey(false); } }}>Save key</button></div></details>
    <details><summary className="cursor-pointer">Model response format</summary><p className="mt-2 whitespace-pre-wrap text-slate-400">{RESPONSE_FORMAT}</p></details>
  </div>;
}
