import { useEffect, useState } from 'react';
import { nativeStore } from '../services/nativeStore';
import { storageService } from '../services/storageService';
import { orderJournal } from '../services/orderJournal';
import { OrderSubmissionError } from '../services/submissionError';

/** Observe the original persisted intent, including recovery after closing/reopening a form. */
export function useOrderSubmission(owner: string | undefined, chainId: number, tokenAddress: string, busy: boolean) {
  const scope = `${owner?.toLowerCase()}:${chainId}:${tokenAddress.toLowerCase()}`;
  const [notice, setNotice] = useState<{ scope: string; uid?: string; error?: string; rejected?: boolean }>();
  const [, refresh] = useState(0);
  useEffect(() => nativeStore.subscribe(key => {
    if (!key || key === 'haven_defi_terminal_submissions_v1' || key === 'haven_defi_terminal_orders') refresh(value => value + 1);
  }), []);
  const records = owner && nativeStore.getWallet()?.address.toLowerCase() === owner.toLowerCase() ? orderJournal.all() : [];
  const pending = records.find(record => record.chainId === chainId && !record.rejected && record.purpose !== 'bridge' &&
    [record.payload.sellToken, record.payload.buyToken].some(address => String(address).toLowerCase() === tokenAddress.toLowerCase()));
  const current = notice?.scope === scope ? notice : undefined;
  useEffect(() => {
    if (pending?.error && !busy) setNotice(previous => previous?.scope === scope && previous.uid === pending.uid
      ? previous : { scope, uid: pending.uid });
  }, [pending?.uid, pending?.error, busy, scope]);
  const uid = pending?.uid || current?.uid;
  const record = uid ? records.find(item => item.uid === uid) : undefined;
  const order = uid ? storageService.getOrders().find(item => item.id === uid) : undefined;
  const rejected = record?.rejected || current?.rejected || !!order?.submissionError;
  let message = current?.error || '';
  if (pending) message = 'Submission unconfirmed. DEKXDIS is tracking and retrying the original order. Wait for confirmation before placing another order for this token.';
  else if (uid && rejected) message = `Order rejected. ${record?.error || order?.submissionError || current?.error || 'Review the order details before retrying.'}`;
  else if (uid) message = order
    ? `Original order ${order.status === 'pending' || order.status === 'open' ? 'confirmed; awaiting fill' : order.status}. Review Order History before starting another order.`
    : 'The original order needs reconciliation. Review Order History before starting another order.';
  return {
    message, uid,
    blocked: !!pending || (!!uid && !rejected),
    canStartAnother: !!uid && !pending && !!order,
    clear: () => setNotice(undefined),
    onError: (error: unknown) => setNotice({ scope,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof OrderSubmissionError ? { uid: error.uid, rejected: error.rejected } : {}),
    }),
  };
}
