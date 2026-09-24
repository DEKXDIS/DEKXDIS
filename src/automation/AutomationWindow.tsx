import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TokenConfig, TradeOrder, WalletState } from '../types/trading';
import { automation } from './runner';
import { readSettings, saveSettings, settingsDraft, parseSettingsDraft, workspaceKey, type SettingsDraft } from './settings';
import { openBuyCount, RESPONSE_FORMAT } from './packet';
import { tradingAllowance } from './allowance';
import { storageService } from '../services/storageService';

interface Props { selectedToken: TokenConfig; selectedChainId: number; wallet: WalletState | null; orders: TradeOrder[]; onRequireWallet: () => void }
export function AutomationWindow({ selectedToken: token, selectedChainId: chainId, wallet, orders, onRequireWallet }: Props) {
  const key = workspaceKey(wallet?.address || 'preview', chainId, token.address);
  const [settings, setSettings] = useState(() => settingsDraft(readSettings(key)));
  const [apiKey, setApiKey] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [message, setMessage] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const subscribe = useCallback((fn: () => void) => automation.subscribeWorkspace(key, fn), [key]);
  const status = useSyncExternalStore(subscribe, () => automation.status(key));
  useEffect(() => { let current = true; invoke<boolean>('automation_key_status').then(value => { if (current) setKeySaved(value); }).catch(() => {});
    return () => { current = false; }; }, []);
  const field = <K extends keyof SettingsDraft>(name: K, value: SettingsDraft[K]) => setSettings(s => ({ ...s, [name]: value }));
  const save = () => { const value = parseSettingsDraft(settings); saveSettings(key, value); return value; };
  const start = () => {
    if (!wallet) { onRequireWallet(); return; }
    try { if (!keySaved) throw new Error('Save an OpenAI API key first'); const value = save();
      automation.start({ owner: wallet.address, token, chainId }, value); setMessage(''); }
    catch (error) { setMessage(String(error instanceof Error ? error.message : error)); }
  };
  const inputClass = 'w-full rounded-lg border border-surface-border bg-background px-2 py-1.5 text-slate-100 focus:outline-none focus:border-theme-primary';
  const buttonClass = 'btn-tactile rounded-lg border border-surface-border bg-surface px-3 py-2 hover:border-theme-primary disabled:opacity-50';
  const w = { owner: wallet?.address || '', token, chainId };
  const allowance = useMemo(() => {
    try { return tradingAllowance(storageService.getAccountingOrders(orders), w, settings.maxFundsUsd); }
    catch { return null; }
  }, [orders, key, settings.maxFundsUsd]);
  const responseText = useMemo(() => {
    try { return JSON.stringify(JSON.parse(status.lastResponse || ''), null, 2); }
    catch { return status.lastResponse || ''; }
  }, [status.lastResponse]);
  return <div className="h-full overflow-auto bg-surface p-3 text-xs text-slate-300 space-y-3">
    <div className="flex justify-between gap-2 border-b border-surface-border pb-2"><strong className="text-theme-primary">Automation · {token.symbol}</strong>
      <span className="text-theme-secondary">{openBuyCount(orders, w)} open buys</span></div>
    <p>Each check uses this token’s chart, orders, positions and recent history. Enabled tokens keep running when you switch workspaces.</p>
    <fieldset disabled={status.running} className="space-y-3 disabled:opacity-70">
      <label className="block space-y-1"><span>Instructions</span><textarea aria-label="Automation instructions" className={inputClass} rows={7}
        value={settings.prompt} onChange={e => field('prompt', e.target.value)} placeholder="Describe what you want the model to do with the chart and trades." /></label>
      <label className="block space-y-1"><span>OpenAI model ID (must accept images)</span><input className={inputClass} value={settings.model} onChange={e => field('model', e.target.value)} /></label>
      <div className="grid grid-cols-2 gap-2">
        <label>Check every (seconds)<input type="number" min="1" className={inputClass} value={settings.intervalSeconds} onChange={e => field('intervalSeconds', e.target.value)} /></label>
        <label>Time between trades (seconds)<input type="number" min="0" className={inputClass} value={settings.tradeIntervalSeconds} onChange={e => field('tradeIntervalSeconds', e.target.value)} /></label>
        <label>Max open buys (0 = unlimited)<input type="number" min="0" className={inputClass} value={settings.maxOpenBuys} onChange={e => field('maxOpenBuys', e.target.value)} /></label>
        <label>Recent history entries<input type="number" min="0" className={inputClass} value={settings.historyCount} onChange={e => field('historyCount', e.target.value)} /></label>
      </div>
      <p>Only unfilled buy orders count toward the maximum. Filled buys and their TP/SL orders do not count.</p>
      <label className="block">Trading allowance (USD)<input inputMode="decimal" className={inputClass} value={settings.maxFundsUsd}
        onChange={e => field('maxFundsUsd', e.target.value)} placeholder="Unlimited when blank" /></label>
      <p className="text-slate-400">Buys use this token’s allowance; completed sells restore it up to the limit. Pending buys reserve funds. The wallet must also have enough wrapped native tokens.</p>
      <label className="block">Order amount<select className={inputClass} value={settings.amountMode} onChange={e => field('amountMode', e.target.value as SettingsDraft['amountMode'])}>
        <option value="fixed">Fixed amount per trade</option><option value="model">Model chooses each amount</option></select></label>
      {settings.amountMode === 'fixed' && <div className="grid grid-cols-2 gap-2"><label>Amount<input className={inputClass} value={settings.amount} onChange={e => field('amount', e.target.value)} /></label>
        <label>Unit<select className={inputClass} value={settings.amountUnit} onChange={e => field('amountUnit', e.target.value as 'usd' | 'token')}><option value="usd">USD value</option><option value="token">{token.symbol}</option></select></label></div>}
    </fieldset>
    {allowance?.limitUsd !== null && allowance && <div className="rounded-lg border border-surface-border bg-background p-2">
      {allowance.error ? <p className="text-amber-300">{allowance.error}</p> : <><p className="text-theme-primary">Allowance remaining: ${Number(allowance.availableUsd).toFixed(2)} / ${Number(allowance.limitUsd).toFixed(2)}</p>
        <p className="text-slate-400">Used: ${Number(allowance.usedUsd).toFixed(2)} · Pending buys: ${Number(allowance.reservedUsd).toFixed(2)}</p></>}
    </div>}
    <div className="flex gap-2">
      <button className={buttonClass} disabled={status.running} onClick={() => { try { save(); setMessage('Settings saved'); } catch (error) { setMessage(String(error)); } }}>Save settings</button>
      <button className={`btn-tactile rounded-lg px-4 py-2 font-semibold text-slate-950 disabled:opacity-50 ${status.running ? 'bg-theme-secondary shadow-glow-secondary' : 'bg-theme-primary shadow-glow-primary'}`} disabled={!status.running && status.busy}
        onClick={() => status.running ? automation.stop(key) : start()}>{status.running ? 'Stop' : status.busy ? 'Finishing request…' : 'Start'}</button>
    </div>
    <div role="status" className="rounded-lg border border-surface-border bg-background p-2 break-words"><p>{status.message}</p>
      {status.checkedAt && <p className="text-slate-500">Last check: {new Date(status.checkedAt).toLocaleTimeString()}</p>}
      {status.nextAt && <p className="text-slate-500">Next check: {new Date(status.nextAt).toLocaleTimeString()}</p>}</div>
    {message && <p role="status" className="text-amber-300 break-words">{message}</p>}
    <section aria-label="Last AI response" className="rounded-lg border border-surface-border bg-background p-2 space-y-2">
      <div className="flex justify-between gap-2"><strong className="text-theme-secondary">Last AI response</strong>
        {status.respondedAt && <time className="text-slate-500">{new Date(status.respondedAt).toLocaleTimeString()}</time>}</div>
      {responseText ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-slate-300">{responseText}</pre>
        : <p className="text-slate-500">No response yet.</p>}
    </section>
    <details><summary className="cursor-pointer">OpenAI API key · {keySaved ? 'Saved' : 'Not configured'}</summary>
      <div className="mt-2 flex gap-2"><input type="password" aria-label="OpenAI API key" autoComplete="off" className={inputClass} value={apiKey} onChange={e => setApiKey(e.target.value)} />
        <button disabled={!apiKey.trim() || savingKey} className={buttonClass} onClick={async () => { setSavingKey(true); try {
          await invoke('automation_key_save', { key: apiKey }); setApiKey(''); setKeySaved(true); setMessage('API key saved');
        } catch (error) { setMessage(String(error)); } finally { setSavingKey(false); } }}>Save key</button></div></details>
    <details><summary className="cursor-pointer">Model response format</summary><p className="mt-2 whitespace-pre-wrap text-slate-400">{RESPONSE_FORMAT}</p></details>
  </div>;
}
