import React, { useLayoutEffect, useRef } from 'react';
import { containDialogFocus } from './ModalDialog';
import { AlertTriangle } from 'lucide-react';

export function WalletChangeWarningModal({
  isOpen,
  ladderCount,
  orderCount,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean;
  ladderCount: number;
  orderCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (isOpen && dialog && !dialog.open) dialog.showModal();
    if (!isOpen && dialog?.open) dialog.close();
    return () => { if (dialog?.open) dialog.close(); };
  }, [isOpen]);
  if (!isOpen) return null;

  return <dialog
    ref={dialogRef}
    onKeyDown={containDialogFocus}
    aria-labelledby="wallet-change-warning-title"
    onCancel={event => { event.preventDefault(); onCancel(); }}
    className="m-auto p-0 bg-transparent text-slate-200 w-[calc(100%-2rem)] max-w-lg backdrop:bg-black/80 backdrop:backdrop-blur-sm"
  >
    <div className="rounded-2xl border border-amber-500/60 bg-surface p-5 shadow-2xl select-text">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-6 h-6 text-amber-400 shrink-0 mt-0.5" />
        <div>
          <h3 id="wallet-change-warning-title" className="text-base font-bold text-white">Confirm wallet switch</h3>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            The current wallet has {ladderCount > 0 && <>{ladderCount} running {ladderCount === 1 ? 'strategy' : 'strategies'} and </>}{orderCount} open or pending {orderCount === 1 ? 'order' : 'orders'}.
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            Before DEKXDIS changes wallets, it will {ladderCount > 0 && 'turn off every running strategy for the current wallet and '}request cancellation of every open or pending order. The wallet will stay active if any order cannot be confirmed as cancelled or otherwise closed.
          </p>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-3 flex-wrap">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-600 bg-slate-800 text-sm">Keep current wallet</button>
        <button type="button" onClick={onConfirm} className="px-4 py-2 rounded-lg border border-amber-500 bg-amber-500/20 text-amber-200 text-sm font-semibold">{ladderCount > 0 ? 'Stop strategies, cancel orders, and switch' : 'Cancel orders and switch'}</button>
      </div>
    </div>
  </dialog>;
}
