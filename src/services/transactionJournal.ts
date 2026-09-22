import { ethers } from 'ethers';
import { nativeStore } from './nativeStore';

const queues = new Map<string, Promise<unknown>>();
/** Persist signed bytes before broadcast and resume the same transaction after a timeout. */
export async function confirmedTransaction(signer: ethers.Signer, chainId: number, to: string, data: string,
  options: { value?: bigint; gasLimit?: bigint; operationId?: string; beforePrepare?: () => Promise<void | ethers.TransactionRequest>; onPrepared?: (hash: string) => Promise<void>; onConfirmed?: (receipt: ethers.TransactionReceipt) => Promise<void>; onBroadcastError?: (error: unknown) => void } = {}): Promise<ethers.TransactionReceipt> {
  const owner = (await signer.getAddress()).toLowerCase();
  const key = `haven_transactions_${owner}_${chainId}`;
  const run = async () => {
    const provider = signer.provider;
    if (!provider) throw new Error('Transaction provider unavailable');
    await nativeStore.flush();
    const stored = nativeStore.getItem(key);
    let record: { hash: string; raw: string; to: string; data: string; value?: string; operationId?: string; broadcastError?: string } | null = stored ? JSON.parse(stored) : null;
    if (record && options.operationId && record.operationId !== options.operationId) {
      throw new Error(`Transaction ${record.hash} belongs to another operation; check that transaction before sending`);
    }
    for (;;) {
      if (!record) {
        const gasFields = await options.beforePrepare?.();
        const tx = await signer.populateTransaction({ ...gasFields, to, data, value: options.value ?? 0n, gasLimit: gasFields?.gasLimit ?? options.gasLimit });
        const raw = await signer.signTransaction(tx);
        record = { hash: ethers.keccak256(raw), raw, to, data, value: (options.value ?? 0n).toString(), operationId: options.operationId };
        nativeStore.setItem(key, JSON.stringify(record));
        await nativeStore.flush();
      }
      const same = record.to.toLowerCase() === to.toLowerCase() && record.data === data && (record.value ?? '0') === (options.value ?? 0n).toString() && record.operationId === options.operationId;
      if (options.operationId && !same) throw new Error('Signed transaction does not match this transfer; submission stopped');
      if (same && options.onPrepared) await options.onPrepared(record.hash);
      let receipt = await provider.getTransactionReceipt(record.hash);
      if (!receipt) {
        try { await provider.broadcastTransaction(record.raw); } catch (error) {
          // Preserve the failure while reconciling the original hash. Never log signed bytes.
          const failure = error as { shortMessage?: string; message?: string };
          record.broadcastError = String(failure.shortMessage || failure.message || error).replace(/0x[0-9a-f]{128,}/gi, '[signed data omitted]');
          nativeStore.setItem(key, JSON.stringify(record)); await nativeStore.flush();
          options.onBroadcastError?.(error);
        }
        receipt = await provider.waitForTransaction(record.hash, 1, 20000);
      }
      if (!receipt) throw new Error(`Transaction ${record.hash} is pending; no replacement was submitted${record.broadcastError ? `. Broadcast response: ${record.broadcastError}` : ''}`);
      // Let the owning operation durably record receipt evidence before retiring signed bytes.
      if (same && options.onConfirmed) await options.onConfirmed(receipt);
      nativeStore.removeItem(key); await nativeStore.flush();
      if (receipt.status !== 1) throw Object.assign(new Error(`Transaction ${record.hash} reverted`), {
        code: 'TRANSACTION_REVERTED', transactionHash: record.hash, receipt,
      });
      if (same) return receipt;
      // Finish a previous operation before allocating another nonce.
      record = null;
    }
  };
  const next = (queues.get(key) || Promise.resolve()).then(run, run);
  queues.set(key, next.catch(() => {}));
  return next;
}
