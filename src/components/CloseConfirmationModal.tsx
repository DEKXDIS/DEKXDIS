import React from 'react';
import { AlertTriangle } from 'lucide-react';

export function CloseConfirmationModal({ isOpen, onCancel, onConfirm }: { isOpen: boolean; onCancel: () => void; onConfirm: () => void }) {
  if (!isOpen) return null;
  return <div className="fixed inset-0 z-[10001] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm select-text" role="dialog" aria-modal="true" aria-labelledby="close-title">
    <div className="w-full max-w-xl rounded-2xl border border-amber-500/60 bg-surface p-5 shadow-2xl">
      <div className="flex gap-3"><AlertTriangle className="w-6 h-6 text-amber-400 shrink-0" /><div>
        <h3 id="close-title" className="font-bold text-white">Close DEKXDIS?</h3>
        <p className="mt-3 text-sm leading-6 text-slate-300">Orders already submitted to CoW remain active and may fill while DEKXDIS is closed. DEKXDIS cannot run automation, place new automatic orders, or trigger a local stop-loss while it is closed.</p>
        <p className="mt-2 text-sm leading-6 text-slate-300">Any exit order already submitted to CoW can still fill. DEKXDIS cannot detect that fill and cancel the opposite OCO order until the program is running again. Confirm only if you accept that automated protection will be unavailable while DEKXDIS is closed.</p>
      </div></div>
      <div className="mt-5 flex justify-end gap-3"><button onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-600 bg-slate-800 text-sm">Keep DEKXDIS running</button><button onClick={onConfirm} className="px-4 py-2 rounded-lg border border-rose-500 bg-rose-500/20 text-rose-200 text-sm font-semibold">Close DEKXDIS</button></div>
    </div>
  </div>;
}
