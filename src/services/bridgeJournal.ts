import { nativeStore } from './nativeStore';
import { web3Service } from './web3Service';
import { systemLogService } from './systemLogService';
import { getChainConfig } from '../types/chains';
import type { TokenConfig } from '../types/trading';
import { bridgeFetch, bridgeRetryFailure, type BridgeRetryState } from './bridgeRequests';
import { cowProtocol } from './cowProtocol';
import { orderJournal } from './orderJournal';
import { withCowBridgeSdk } from './cowBridgeSdk';
import { ethers } from 'ethers';

export interface BridgeTransfer extends BridgeRetryState {
  hash: string; owner: string; fromChainId: number; toChainId: number; tool?: string;
  createdAt: number; status: 'pending' | 'delivered' | 'partial' | 'refunded' | 'failed';
  message?: string; destinationHash?: string; lastChecked?: number;
  loggedOutcome?: BridgeTransfer['status'];
  protocol?: 'cow'; orderUid?: string; quoteId?: string; sourceHash?: string; refundHash?: string;
  stage?: 'submitting' | 'source' | 'bridge' | 'refund';
  sourceToken?: TokenConfig; destinationToken?: TokenConfig; fromAmountRaw?: string; minimumReceiveRaw?: string;
  nativeInput?: boolean; nativeOutput?: boolean; validTo?: number; nativeOrder?: { to: string; data: string; value: string };
}
export function bridgeStatusMessage(status: BridgeTransfer['status'], record?: BridgeTransfer): string {
  if (status === 'pending' && record?.protocol === 'cow') {
    if (record.trackingStopped) return 'Transfer status unconfirmed; see System Log';
    return record.stage === 'bridge' ? 'CoW settled; awaiting destination delivery' : record.stage === 'refund' ? 'CoW order expired; refund pending' : 'CoW order submitted; awaiting settlement';
  }
  return { pending: 'Source confirmed; awaiting bridge delivery', delivered: 'Bridge delivery complete',
    partial: 'Bridge partially delivered; see log', refunded: 'Bridge refunded; see log', failed: 'Error, see log' }[status];
}
const key = (owner: string) => `haven_bridges_${owner.toLowerCase()}`;
export function bridgeOutcome(status: string, substatus: string): BridgeTransfer['status'] {
  if (status === 'FAILED') return 'failed';
  if (status !== 'DONE') return 'pending';
  return substatus === 'COMPLETED' ? 'delivered' : substatus === 'PARTIAL' ? 'partial' : substatus === 'REFUNDED' ? 'refunded' : 'pending';
}
let polling = false;
export const bridgeJournal = {
  all(owner: string): BridgeTransfer[] { return JSON.parse(nativeStore.getItem(key(owner)) || '[]'); },
  async put(record: BridgeTransfer) {
    const previous = this.all(record.owner).find(x => x.hash === record.hash);
    if (record.status === 'pending' && previous && previous.status !== 'pending') record = { ...record, ...previous };
    if (record.status !== 'pending' && (record.loggedOutcome || previous?.loggedOutcome) !== record.status) {
      const title = record.status === 'failed' ? 'Bridge transfer failed' : bridgeStatusMessage(record.status);
      if (!systemLogService.getLogs().some(log => log.category === 'BRIDGE' && log.title === title && log.details?.includes(record.hash))) {
        const sourceHash = record.protocol === 'cow' ? record.sourceHash : record.hash;
        const transactionHash = record.destinationHash || record.refundHash || sourceHash;
        const transactionChain = record.destinationHash ? record.toChainId : record.fromChainId;
        systemLogService.addLog({ category: 'BRIDGE', level: record.status === 'delivered' ? 'success' : record.status === 'failed' ? 'error' : 'warn',
          title, details: `${getChainConfig(record.fromChainId).name} → ${getChainConfig(record.toChainId).name}\n${record.protocol === 'cow' ? `CoW order: ${record.hash}\n` : ''}Source transaction: ${sourceHash || 'Not settled'}\nDestination transaction: ${record.destinationHash || 'Not provided'}\n${record.message || record.status}`,
          txHash: transactionHash, chainId: transactionChain,
          explorerUrl: transactionHash ? getChainConfig(transactionChain).txUrl(transactionHash) : record.protocol === 'cow' ? cowProtocol.getExplorerUrl(record.hash) : undefined });
      }
      record = { ...record, loggedOutcome: record.status };
    }
    nativeStore.setItem(key(record.owner), JSON.stringify([...this.all(record.owner).filter(x => x.hash !== record.hash), record]));
    await nativeStore.flush();
  },
  async poll(owner: string) {
    if (polling || !nativeStore.isHealthy()) return;
    polling = true;
    try {
      // Recover completion notices for transfers saved by older builds.
      for (const record of this.all(owner).filter(x => x.status !== 'pending' && x.loggedOutcome !== x.status)) await this.put(record);
      for (const record of this.all(owner).filter(x => x.status === 'pending' && !x.trackingStopped && Date.now() >= (x.nextCheckAt || 0) && Date.now() - (x.lastChecked || 0) >= (x.failures ? 0 : 15000))) {
        if (nativeStore.getWallet()?.address.toLowerCase() !== owner.toLowerCase()) break;
        try {
          if (record.protocol === 'cow') {
            const updated = await this.checkCow(record);
            if (record.trackingReported) systemLogService.logSuccess('BRIDGE', 'Transfer tracking recovered', record.hash, undefined, undefined, record.fromChainId);
            await this.put({ ...updated, failures: 0, trackingStopped: false, trackingReported: false, nextCheckAt: undefined, lastChecked: Date.now() });
            continue;
          }
          const url = new URL('https://li.quest/v1/status');
          url.searchParams.set('txHash', record.hash);
          url.searchParams.set('fromChain', String(record.fromChainId));
          url.searchParams.set('toChain', String(record.toChainId));
          if (record.tool) url.searchParams.set('bridge', record.tool);
          const response = await bridgeFetch(url);
          if (!response.ok) throw new Error(`Bridge status unavailable (HTTP ${response.status})`);
          const result = await response.json();
          let status = bridgeOutcome(result.status, result.substatus);
          // A reverted source transaction cannot deliver; unknown/indexing states stay pending.
          if (status === 'pending') {
            const provider = web3Service.getProvider(record.fromChainId);
            try {
              const receipt = await provider.getTransactionReceipt(record.hash);
              if (receipt?.status === 0) status = 'failed';
              if (!receipt) {
                const saved = nativeStore.getItem(`haven_transactions_${record.owner.toLowerCase()}_${record.fromChainId}`);
                const transaction = saved ? JSON.parse(saved) : null;
                if (transaction?.hash === record.hash) {
                  try { await provider.broadcastTransaction(transaction.raw); } catch (error) { console.warn('Legacy bridge exact transaction rebroadcast:', error); }
                }
              }
            } finally { provider.destroy(); }
          }
          if (record.trackingReported) systemLogService.logSuccess('BRIDGE', 'Transfer tracking recovered', record.hash, undefined, undefined, record.fromChainId);
          await this.put({ ...record, status, destinationHash: result.receiving?.txHash, failures: 0, trackingReported: false, nextCheckAt: undefined,
            message: result.substatusMessage || result.substatus || result.status, lastChecked: Date.now() });
        } catch (error) { await this.put({ ...(this.all(owner).find(item => item.hash === record.hash) || record),
          ...bridgeRetryFailure(record, error, record.hash, record.fromChainId), message: String(error), lastChecked: Date.now() }); }
      }
    } finally { polling = false; }
  },
  async resumeTracking(owner: string) {
    for (const record of this.all(owner).filter(item => item.status === 'pending' && item.trackingStopped)) {
      systemLogService.logInfo('BRIDGE', 'Retrying transfer tracking', record.hash, record.fromChainId);
      await this.put({ ...record, trackingStopped: false, failures: 0, nextCheckAt: 0, lastChecked: 0 });
    }
  },
  async checkCow(record: BridgeTransfer): Promise<BridgeTransfer> {
    if (!record.orderUid || record.orderUid !== record.hash || !record.sourceToken || !record.destinationToken) throw new Error('Invalid persisted CoW transfer identity');
    // The bridge journal owns these submissions; ordinary order reconciliation skips them.
    const submission = orderJournal.all().find(item => item.uid === record.orderUid && item.purpose === 'bridge');
    if (submission?.rejected) return { ...record, status: 'failed', message: `CoW rejected the source order: ${submission.error}` };
    if (submission) {
      if (nativeStore.getWallet()?.address.toLowerCase() !== record.owner.toLowerCase()) throw new Error('Wallet changed during CoW recovery');
      await cowProtocol.postSubmission(submission);
    }
    const checked = await withCowBridgeSdk<BridgeTransfer>(record.fromChainId, record.owner, async context => {
      if (record.nativeInput && !record.sourceHash && record.nativeOrder) {
        const stored = nativeStore.getItem(`haven_transactions_${record.owner.toLowerCase()}_${record.fromChainId}`);
        const transaction = stored ? JSON.parse(stored) : undefined;
        if (transaction && transaction.to.toLowerCase() === record.nativeOrder.to.toLowerCase() && transaction.data === record.nativeOrder.data && BigInt(transaction.value) === BigInt(record.nativeOrder.value)) {
          record = { ...record, sourceHash: transaction.hash };
          await this.put(record);
        }
      }
      if (record.nativeInput && record.sourceHash) {
        const receipt = await context.provider.getTransactionReceipt(record.sourceHash);
        if (receipt?.status === 0) return { ...record, status: 'failed', message: 'CoW native source transaction reverted' };
        if (!receipt) {
          const stored = nativeStore.getItem(`haven_transactions_${record.owner.toLowerCase()}_${record.fromChainId}`);
          const transaction = stored ? JSON.parse(stored) : undefined;
          if (transaction?.hash === record.sourceHash) {
            try { await context.provider.broadcastTransaction(transaction.raw); }
            catch (error) { if (!/already known|already imported/i.test(String(error))) throw error; }
          }
          return { ...record, stage: 'submitting', message: 'Native CoW source transaction is still pending' };
        }
      }
      const order = await context.api.getOrder(record.orderUid!);
      if (order.status === 'cancelled' || order.status === 'expired') {
        if (record.nativeInput && record.nativeOrder) return { ...record, stage: 'refund' };
        return { ...record, status: 'failed', message: `Source CoW order ${order.status}; no destination delivery` };
      }
      if (order.status !== 'fulfilled') return { ...record, stage: 'source', message: `CoW source order ${order.status}; awaiting settlement` };
      const result = await context.sdk.getOrder({ chainId: record.fromChainId, orderId: record.orderUid! });
      if (!result) throw new Error('CoW source settled but bridge status is not indexed yet');
      const updated: BridgeTransfer = { ...record, stage: 'bridge', sourceHash: result.tradeTxHash,
        destinationHash: result.statusResult.fillTxHash, message: `CoW bridge ${result.statusResult.status}` };
      const params = result.bridgingParams;
      const destinationConfig = getChainConfig(record.toChainId);
      const expectedOutput = record.nativeOutput ? destinationConfig.nativeToken.wrappedAddress : record.destinationToken!.address;
      if (params.destinationChainId !== record.toChainId || params.recipient.toLowerCase() !== record.owner.toLowerCase() ||
          !(params.outputTokenAddress.toLowerCase() === expectedOutput.toLowerCase() || record.nativeOutput && params.outputTokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')) throw new Error('CoW bridge destination identity mismatch');
      if (result.statusResult.status === 'refund') return { ...updated, status: 'refunded', message: 'Bridge provider confirmed refund; funds may be returned in the bridge intermediate token' };
      if (result.statusResult.status === 'expired') {
        // A bridge expiry is not proof of a refund, and may later resolve as a refund.
        if (record.message !== 'Bridge expired; awaiting refund confirmation') systemLogService.logWarning('BRIDGE', 'CoW bridge expired', `${record.hash}\nAwaiting confirmed refund.`, record.fromChainId);
        return { ...updated, message: 'Bridge expired; awaiting refund confirmation' };
      }
      if (result.statusResult.status !== 'executed') return updated;
      if (!updated.destinationHash) throw new Error('Bridge reports execution without a destination transaction');
      const destination = web3Service.getProvider(record.toChainId);
      try {
        const receipt = await destination.getTransactionReceipt(updated.destinationHash);
        if (!receipt || receipt.status !== 1) throw new Error('Destination receipt is not confirmed successful');
        const token = record.destinationToken!;
        const cfg = getChainConfig(record.toChainId);
        const nativeOutput = record.nativeOutput ?? (token.symbol === cfg.nativeToken.symbol && token.address.toLowerCase() === cfg.nativeToken.wrappedAddress.toLowerCase());
        if (!nativeOutput) {
          const topic = ethers.id('Transfer(address,address,uint256)');
          const recipient = ethers.zeroPadValue(record.owner, 32).toLowerCase();
          const received = receipt.logs.filter(log => log.address.toLowerCase() === token.address.toLowerCase() && log.topics[0] === topic && log.topics[2]?.toLowerCase() === recipient)
            .reduce((sum, log) => sum + BigInt(log.data), 0n);
          if (received < BigInt(record.minimumReceiveRaw!)) return { ...updated, status: 'partial', message: 'Confirmed destination tokens are below the quoted minimum; inspect destination transaction' };
        }
        return { ...updated, status: 'delivered', message: 'CoW source settlement and destination receipt confirmed' };
      } finally { destination.destroy(); }
    });
    // Do not wait for the execution lock while holding the SDK adapter queue.
    if (checked.stage === 'refund' && checked.status === 'pending') {
      const provider = web3Service.getProvider(record.fromChainId);
      try { return await this.refundNative(checked, provider); } finally { provider.destroy(); }
    }
    return checked;
  },
  async refundNative(record: BridgeTransfer, provider: ethers.Provider): Promise<BridgeTransfer> {
    const { exclusive } = await import('./executionEngine');
    const { confirmedTransaction } = await import('./transactionJournal');
    const { EthFlowAbi } = await import('@cowprotocol/sdk-common');
    const { estimateTransferGas, gasTransactionFields } = await import('./transferGas');
    return exclusive(async () => {
      if (nativeStore.getWallet()?.address.toLowerCase() !== record.owner.toLowerCase()) throw new Error('Wallet changed before CoW native refund');
      const iface = new ethers.Interface(EthFlowAbi);
      const original = iface.decodeFunctionData('createOrder', record.nativeOrder!.data);
      const data = iface.encodeFunctionData('invalidateOrder', [original[0]]);
      const signer = web3Service.getSigner(record.owner, record.fromChainId).connect(provider);
      const receipt = await confirmedTransaction(signer, record.fromChainId, record.nativeOrder!.to, data, {
        beforePrepare: async () => {
          const gas = await estimateTransferGas(provider, record.fromChainId, { from: record.owner, to: record.nativeOrder!.to, data });
          if (await provider.getBalance(record.owner, 'pending') < gas.reserveWei) throw new Error('Native CoW refund needs source-chain gas; deposit gas and reopen to retry');
          return gasTransactionFields(gas);
        }, onPrepared: async refundHash => this.put({ ...record, refundHash, stage: 'refund' }),
      });
      return { ...record, refundHash: receipt.hash, status: 'refunded', message: 'Unfilled native CoW order refunded on the source chain' };
    });
  },
};
