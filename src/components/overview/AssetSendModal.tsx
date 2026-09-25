import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { containDialogFocus } from '../ModalDialog';
import { ethers } from 'ethers';
import { Send, X, Loader2 } from 'lucide-react';
import { assetSendService, AssetSendRecord, AssetSendReview, SendAsset } from '../../services/assetSendService';
import { sendErrorText } from '../../services/assetSendRequests';
import { nativeStore } from '../../services/nativeStore';
import { systemLogService } from '../../services/systemLogService';
import { openExplorerLink } from '../../services/explorerLinks';
import { getChainConfig } from '../../types/chains';
import { formatUsdDisplay } from '../../utils/displayFormat';

const button = 'px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-xs text-slate-100 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed';
const primary = 'px-4 py-2 rounded-lg bg-theme-primary text-white text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed';
const stateLabel = (record: AssetSendRecord) => ({ preparing: 'Preparing', pending: 'Pending confirmation', confirmed: 'Confirmed on-chain', failed: 'Failed', 'receipt-mismatch': 'Receipt requires inspection' })[record.state];

export function AssetSendModal({ from, asset, displayPrice, onClose, onRefresh }: {
  from: string; asset: SendAsset; displayPrice?: number; onClose: () => void; onRefresh: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const recipientInput = useRef<HTMLInputElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const resultPanel = useRef<HTMLElement>(null);
  const [recipient, setRecipient] = useState('');
  const [usd, setUsd] = useState('');
  const [max, setMax] = useState(false);
  const [review, setReview] = useState<AssetSendReview | null>(null);
  const [record, setRecord] = useState<AssetSendRecord | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState<'review' | 'send' | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const operation = useRef(false);
  const reviewId = useRef<string>();
  const chain = getChainConfig(asset.chainId);
  const close = () => { dialog.current?.close(); onClose(); };
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    recipientInput.current?.focus();
    return () => { generation.current++; if (reviewId.current) assetSendService.discard(reviewId.current); element.close(); };
  }, []);
  useEffect(() => {
    if (!review) return;
    reviewHeading.current?.focus();
    setExpired(Date.now() >= review.expiresAt);
    const timer = setTimeout(() => setExpired(true), Math.max(0, review.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [review]);
  useEffect(() => { if (record) resultPanel.current?.focus(); }, [record]);
  const edit = () => {
    generation.current++;
    if (reviewId.current) assetSendService.discard(reviewId.current);
    reviewId.current = undefined;
    setReview(null); setError(''); setExpired(false);
  };
  const runReview = async () => {
    if (operation.current) return;
    edit();
    const version = generation.current;
    operation.current = true; setBusy('review');
    try {
      const value = await assetSendService.review(from, asset, recipient, usd, max);
      if (version !== generation.current) { assetSendService.discard(value.id); return; }
      reviewId.current = value.id; setReview(value);
    } catch (failure) { if (version === generation.current) setError(sendErrorText(failure)); }
    finally { operation.current = false; if (version === generation.current) setBusy(null); }
  };
  const send = async () => {
    if (!review || operation.current || expired) return;
    operation.current = true; setBusy('send'); setError('');
    const id = review.id;
    try {
      const sent = await assetSendService.send(id);
      setRecord(sent); setReview(null);
      if (sent.state === 'confirmed') onRefresh();
    } catch (failure) {
      setError(sendErrorText(failure));
      setReview(null);
      const saved = assetSendService.all(from).find(item => item.id === id);
      if (saved) setRecord(saved);
    } finally { operation.current = false; setBusy(null); }
  };
  const amount = review ? ethers.formatUnits(review.amountRaw, asset.decimals) : undefined;
  const estimate = review?.amountUsd ?? (amount && displayPrice && displayPrice > 0 ? Number(amount) * displayPrice : undefined);
  return createPortal(<dialog ref={dialog} aria-labelledby="asset-send-title"
    onKeyDown={containDialogFocus}
    onCancel={event => { event.preventDefault(); if (busy !== 'send') close(); }}
    onPointerDown={event => event.stopPropagation()}
    className="m-auto w-[calc(100%-2rem)] max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-surface-border bg-surface p-5 text-slate-100 shadow-2xl backdrop:bg-black/80 select-text">
    <div className="flex items-center justify-between gap-3 mb-4">
      <h2 id="asset-send-title" className="flex items-center gap-2 text-lg font-bold"><Send className="w-5 h-5 text-theme-primary" aria-hidden="true" />Send {asset.symbol}</h2>
      <button type="button" aria-label="Close send" className={button} disabled={busy === 'send'} onClick={close}><X className="w-4 h-4" aria-hidden="true" /></button>
    </div>
    <p className="text-sm font-semibold text-theme-primary">Network: {chain.name}</p>
    <p className="mt-1 text-xs text-slate-400">Use your receiving wallet’s address on {chain.name}.</p>
    <p className="mt-3 text-xs break-all">From: <span className="font-mono">{from}</span></p>
    {asset.kind === 'erc20' && <p className="mt-1 text-xs text-slate-400 break-all">Token contract: {asset.address}</p>}
    {!review && !record && <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void runReview(); }}>
      <label className="block text-sm">Recipient wallet address
        <input ref={recipientInput} autoFocus required name="recipient" aria-describedby="asset-send-recipient-help" spellCheck={false} autoCapitalize="none" value={recipient}
          onChange={event => { edit(); setRecipient(event.target.value); }} disabled={!!busy} placeholder="Paste or enter 0x…"
          className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 p-3 text-sm font-mono" />
      </label>
      <p id="asset-send-recipient-help" className="text-xs text-slate-400">Paste with Ctrl+V or type the full address. The receiving wallet does not need to be imported into DEKXDIS.</p>
      <div className="flex items-end gap-2">
        <label className="block flex-1 text-sm">Amount (USD)
          <input required={!max} inputMode="decimal" name="amountUsd" value={max ? 'MAX' : usd} disabled={!!busy || max}
            onChange={event => { edit(); setUsd(event.target.value); }} placeholder="0.00" className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 p-3 text-sm" />
        </label>
        <button type="button" aria-pressed={max} disabled={!!busy} className={button} onClick={() => { edit(); setMax(value => !value); }}>{max ? 'Enter amount' : 'MAX'}</button>
      </div>
      {max && <p className="text-xs text-slate-400">Send the available {asset.symbol} balance{asset.kind === 'native' ? ', keeping a reserve for network gas' : '; network gas is paid separately'}.</p>}
      <button type="submit" disabled={!!busy || !recipient.trim() || (!max && !usd)} className={primary}>Review transfer</button>
    </form>}
    {review && <section aria-label="Review external transfer" className="mt-4 space-y-3">
      <h3 ref={reviewHeading} tabIndex={-1} className="font-bold">Review transfer</h3>
      <p className="text-sm break-all">To: <strong className="font-mono">{review.to}</strong></p>
      <div className="rounded-lg border border-slate-600 bg-slate-950 p-3">
        <p className="font-bold break-all">{amount} {asset.symbol}</p>
        <p className="text-sm text-slate-400">{estimate !== undefined && Number.isFinite(estimate) ? `Estimated $${formatUsdDisplay(estimate)} USD` : 'USD estimate unavailable'}</p>
        <p className="mt-2 text-xs break-all">Network gas reserve: {ethers.formatEther(review.gasReserveWei)} {chain.nativeToken.symbol}</p>
      </div>
      <p className="text-xs text-slate-400">{expired ? 'This review expired. Refresh it before sending.' : 'Review valid for 30 seconds. Check the full address and network before confirming.'}</p>
      <div className="flex flex-wrap gap-2">
        {expired ? <button type="button" className={primary} disabled={!!busy} onClick={() => void runReview()}>Refresh review</button>
          : <button type="button" className={primary} disabled={!!busy} onClick={() => void send()}>Confirm and send</button>}
        <button type="button" className={button} disabled={!!busy} onClick={edit}>Edit transfer</button>
      </div>
    </section>}
    {record && <section ref={resultPanel} tabIndex={-1} className="mt-4 space-y-3" aria-label="Transfer result">
      <p className="font-bold">{stateLabel(record)}</p>
      <p className="text-sm break-all">{ethers.formatUnits(record.amountRaw, record.asset.decimals)} {record.asset.symbol} → {record.to}</p>
      {record.hash && <button className={button} type="button" onClick={() => void openExplorerLink(chain.txUrl(record.hash!))}>View transaction</button>}
      {record.state === 'pending' && <p className="text-xs text-slate-400">Close this dialog and use Recent sends to check or resume the original transaction.</p>}
      {record.error && <p className="text-sm text-rose-300 break-words">{record.error}</p>}
    </section>}
    {busy && <p role="status" className="mt-4 flex items-center gap-2 text-sm"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />{busy === 'review' ? 'Checking address, balance and network gas…' : 'Submitting and checking the transaction…'}</p>}
    {error && <p role="alert" className="mt-4 text-sm text-rose-300 break-words">{error}</p>}
  </dialog>, document.body);
}

export function AssetSendHistory({ from, onRefresh }: { from: string; onRefresh: () => void }) {
  const [records, setRecords] = useState<AssetSendRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const running = useRef(false);
  const refresh = useRef(onRefresh); refresh.current = onRefresh;
  useEffect(() => {
    let alive = true;
    let reportedHistoryError = false;
    const update = () => {
      try {
        const current = assetSendService.all(from);
        if (alive) setRecords(current);
        reportedHistoryError = false;
        return current;
      }
      catch (error) {
        if (alive) setMessage(sendErrorText(error));
        if (!reportedHistoryError) {
          reportedHistoryError = true;
          systemLogService.logError('WALLET', 'Unable to load asset transfers', sendErrorText(error));
        }
        return undefined;
      }
    };
    const initial = update();
    // One read-only reconciliation on mount. Pending inclusion never creates an endless retry loop.
    for (const item of initial?.filter(item => item.state === 'preparing' || item.state === 'pending') || []) void assetSendService.check(item.id).then(result => {
      if (alive && result.state === 'confirmed') refresh.current();
    }, error => { if (alive) setMessage(sendErrorText(error)); });
    const unsubscribe = nativeStore.subscribe(update);
    return () => { alive = false; unsubscribe(); };
  }, [from]);
  const run = async (record: AssetSendRecord, resume: boolean) => {
    if (running.current) return;
    running.current = true; setBusy(record.id); setMessage('');
    try {
      const result = resume ? await assetSendService.resume(record.id) : await assetSendService.check(record.id, true);
      setMessage(stateLabel(result));
      if (result.state === 'confirmed') onRefresh();
    } catch (error) { setMessage(sendErrorText(error)); }
    finally { running.current = false; setBusy(null); }
  };
  if (!records.length && !message) return null;
  return <details className="mt-2 rounded-lg border border-surface-border p-2 text-xs">
    <summary className="cursor-pointer text-slate-200">Recent sends{records.some(item => item.state === 'pending' || item.state === 'preparing') ? ' · transfer pending' : ''}</summary>
    <div className="mt-2 space-y-2 max-h-64 overflow-auto">
      {records.slice().reverse().map(record => <div key={record.id} className="rounded border border-slate-700 p-2 space-y-1">
        <p className="text-slate-100">{stateLabel(record)} · {getChainConfig(record.asset.chainId).name}</p>
        <p className="break-all">{ethers.formatUnits(record.amountRaw, record.asset.decimals)} {record.asset.symbol} → {record.to}</p>
        {record.amountUsd !== undefined && <p className="text-slate-400">Estimated value at review: ${formatUsdDisplay(record.amountUsd)} USD</p>}
        {record.error && <p className="text-rose-300 break-words">{record.error}</p>}
        <div className="flex gap-2 flex-wrap">
          {record.hash && <button type="button" className={button} onClick={() => void openExplorerLink(getChainConfig(record.asset.chainId).txUrl(record.hash!))}>View transaction</button>}
          {(record.state === 'pending' || record.state === 'preparing') && <>
            <button type="button" className={button} disabled={!!busy} onClick={() => void run(record, false)}>{busy === record.id ? 'Checking…' : 'Check status'}</button>
            {record.hash && <button type="button" className={button} disabled={!!busy} onClick={() => void run(record, true)}>Resume original transaction</button>}
          </>}
        </div>
      </div>)}
    </div>
    {message && <p role="status" className="mt-2 text-sky-300 break-words">{message}</p>}
  </details>;
}
