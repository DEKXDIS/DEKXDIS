import React, { useEffect, useRef, useState } from 'react';
import type { WalletState } from '../../types/trading';
import { nativeStore } from '../../services/nativeStore';
import { storageService } from '../../services/storageService';
import { systemLogService } from '../../services/systemLogService';

export function WalletCreationPanel({ wallet, onOpenWalletSetup, onSwitchWallet }: {
  onOpenWalletSetup: () => void;
  onSwitchWallet: (address: string) => Promise<void>;
  wallet: WalletState | null;
}) {
  const [wallets, setWallets] = useState<WalletState[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [nicknameDrafts, setNicknameDrafts] = useState<Record<string, string>>({});
  const operation = useRef(false);
  const [busyMessage, setBusyMessage] = useState('');

  const switchWallet = async (address: string) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setBusyMessage('Switching wallet…');
    setMessage('');
    try {
      await onSwitchWallet(address);
      setMessage('Wallet activated.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setMessage('');
    nativeStore.listWallets().then(saved => {
      if (!cancelled) setWallets(saved);
    }).catch(error => {
      if (cancelled) return;
      const details = String(error);
      setMessage(details);
      systemLogService.logError('WALLET', 'Saved Wallets Could Not Be Loaded', details);
    });
    setNicknameDrafts(storageService.getWalletNicknames());
    return () => { cancelled = true; };
  }, [wallet?.address]);

  const saveNickname = async (address: string) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setBusyMessage('Saving nickname…');
    setMessage('');
    try {
      const key = address.toLowerCase();
      const updated = storageService.saveWalletNickname(address, nicknameDrafts[key] || '');
      await storageService.flush();
      setNicknameDrafts(current => ({ ...current, [key]: updated[key] || '' }));
      setMessage(updated[key] ? 'Wallet nickname saved.' : 'Wallet nickname removed.');
    } catch (error) {
      const details = String(error);
      setMessage(details);
      systemLogService.logError('WALLET', 'Wallet Nickname Could Not Be Saved', `${address}: ${details}`);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };

  const button = 'btn-tactile px-3 py-1.5 rounded-lg bg-surface-hover hover:bg-theme-primary-10 border border-surface-border hover:border-theme-primary text-slate-300 hover:text-theme-primary text-[10px] font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer';

  return <section aria-label="Wallet creation" className="h-full flex flex-col gap-2 p-2.5 font-mono text-xs text-slate-200 select-text">
    <div className="flex items-center justify-between gap-2 border-b border-surface-border pb-2 shrink-0">
      <span className="text-[10px] font-bold uppercase text-slate-400">Saved wallet nicknames</span>
      <button type="button" className={button} disabled={busy} onClick={onOpenWalletSetup}>Import or create wallet</button>
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
      {wallets.map(savedWallet => {
        const key = savedWallet.address.toLowerCase();
        return <div key={key} className="rounded-lg border border-surface-border bg-background/80 p-2">
          <div className="flex items-start gap-2 mb-2">
            <span className="min-w-0 break-all text-[10px] text-slate-400">{savedWallet.address}</span>
            {key === wallet?.address.toLowerCase() && <span className="shrink-0 text-[10px] text-theme-primary">Active</span>}
            {key !== wallet?.address.toLowerCase() && <button type="button" className={`${button} shrink-0 ml-auto`} disabled={busy} onClick={() => void switchWallet(savedWallet.address)}>Activate</button>}
          </div>
          <div className="flex items-center gap-2">
            <input
              aria-label={`Nickname for ${savedWallet.address}`}
              className="min-w-0 flex-1 bg-background border border-surface-border rounded-lg px-2 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-theme-primary"
              maxLength={40}
              placeholder="Add a nickname"
              value={nicknameDrafts[key] || ''}
              disabled={busy}
              onChange={event => setNicknameDrafts(current => ({ ...current, [key]: event.target.value }))}
            />
            <button type="button" className={`${button} shrink-0`} disabled={busy} onClick={() => saveNickname(savedWallet.address)}>Save nickname</button>
          </div>
        </div>;
      })}
    </div>
    {(busy || message) && <p role="status" className="shrink-0 text-[10px] text-slate-300 break-words">{busy ? busyMessage : message}</p>}
  </section>;
}
