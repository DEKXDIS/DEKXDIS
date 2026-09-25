import { useLayoutEffect, useRef, type ReactNode, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

/** Keep Tab at the dialog edges instead of allowing focus into browser/window chrome. */
export function containDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== 'Tab' || (event.target as Element).closest('dialog') !== event.currentTarget) return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (!first) { event.preventDefault(); event.currentTarget.focus(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
}

/** Native top-layer modality supplies an inert background and focus restoration. */
export function ModalDialog({ label, onClose, busy = false, children }: {
  label: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return createPortal(<dialog
    ref={dialogRef}
    aria-label={label}
    aria-modal="true"
    onKeyDown={containDialogFocus}
    onCancel={event => {
      event.preventDefault();
      if (!busy) onClose();
    }}
    className="bg-transparent text-inherit outline-none backdrop:bg-transparent"
    style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none', margin: 0, padding: 0, border: 0 }}
  >{children}</dialog>, document.body);
}
