import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { acceptBeta, getStrategiesEnabled, subscribeReleaseFeatures, validateBetaKey } from '../config/releaseFeatures';
import terms from '../config/betaTerms.json';
import { systemLogService } from '../services/systemLogService';

export function BetaAccess() {
  const enabled = useSyncExternalStore(subscribeReleaseFeatures, getStrategiesEnabled);
  const [key, setKey] = useState('');
  const [pending, setPending] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (pending) element?.showModal();
    return () => { element?.close(); };
  }, [pending]);
  const report = (reason: unknown) => {
    const message = String(reason);
    setError(message);
    systemLogService.logError('SYSTEM', 'Beta access failed', message);
  };
  const cancel = () => { if (!busy) { setPending(false); setAgreed(false); setKey(''); setError(''); } };
  return <section className="p-3.5 rounded-xl bg-background border border-surface-border space-y-3">
    <label htmlFor="dekxdis-beta-key" className="block text-xs font-bold text-slate-200">Beta key</label>
    {enabled ? <p className="text-xs text-theme-primary" role="status">Strategy beta access enabled on this computer.</p> :
      <form className="flex gap-2" onSubmit={async event => {
        event.preventDefault(); if (busy) return;
        setBusy(true); setError('');
        try { await validateBetaKey(key); setAgreed(false); setPending(true); }
        catch (reason) { report(reason); }
        finally { setBusy(false); }
      }}>
        <input id="dekxdis-beta-key" type="text" autoComplete="off" spellCheck={false} value={key}
          onChange={event => setKey(event.target.value)} disabled={busy} placeholder="Enter beta key"
          className="min-w-0 flex-1 bg-surface border border-surface-border rounded-lg p-2 text-white" />
        <button type="submit" disabled={busy || !key.trim()} className="px-3 py-2 rounded-lg bg-theme-primary text-slate-950 font-bold disabled:opacity-40">Continue</button>
      </form>}
    {error && !pending && <p role="alert" className="text-rose-400 text-xs">{error}</p>}
    <dialog ref={dialog} aria-labelledby="beta-agreement-title" onCancel={event => { event.preventDefault(); cancel(); }}
      className="m-auto w-[min(720px,94vw)] max-h-[90vh] p-0 rounded-xl border border-surface-border bg-surface text-slate-200 shadow-2xl backdrop:bg-black/80">
      <div className="p-5 space-y-4 font-sans">
        <h2 id="beta-agreement-title" tabIndex={-1} autoFocus className="text-lg font-bold text-white">{terms.title}</h2>
        <p className="text-xs text-slate-400">Agreement version {terms.version}. Please read before enabling strategies.</p>
        {terms.sections.map(section => <section key={section.title} className="space-y-1">
          <h3 className="text-sm font-bold text-white">{section.title}</h3>
          <p className="text-sm leading-relaxed">{section.text}</p>
        </section>)}
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={agreed} disabled={busy} onChange={event => setAgreed(event.target.checked)} className="mt-1" />
          <span>I have read and agree to this Beta Testing Agreement, including the financial risks and limitations of liability.</span>
        </label>
        {error && pending && <p role="alert" className="text-sm text-rose-400">{error}</p>}
        <div className="flex justify-end gap-3">
          <button type="button" disabled={busy} onClick={cancel} className="px-4 py-2 rounded-lg border border-surface-border">Decline</button>
          <button type="button" disabled={!agreed || busy} className="px-4 py-2 rounded-lg bg-theme-primary text-slate-950 font-bold disabled:opacity-40" onClick={async () => {
            if (busy || !agreed) return;
            setBusy(true); setError('');
            try {
              await acceptBeta(key, agreed);
              setPending(false); setKey('');
              systemLogService.logInfo('SYSTEM', 'Strategy beta enabled', `Beta testing agreement ${terms.version} accepted on this computer.`);
            } catch (reason) { report(reason); }
            finally { setBusy(false); }
          }}>{busy ? 'Enabling…' : 'I agree and enable beta'}</button>
        </div>
      </div>
    </dialog>
  </section>;
}
