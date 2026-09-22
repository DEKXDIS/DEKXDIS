import { ethers } from 'ethers';
import { nativeStore } from './nativeStore';
import { web3Service } from './web3Service';
import { confirmedTransaction } from './transactionJournal';
import { exclusive } from './executionEngine';
import { getChainConfig } from '../types/chains';

const chain = getChainConfig(56);
const token = chain.usdtToken;
const abi = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
const KEY = 'haven_wallet_transfers_v1';
export interface WalletTransfer {
  id: string; from: string; to: string; amount: string; test: boolean;
  state: 'preparing' | 'pending' | 'confirmed' | 'verified' | 'failed';
  hash?: string; createdAt: number; error?: string;
}
export interface TransferReview { from: string; to: string; amount: string; test: boolean; balance: string; gasBnb: string }
export function transferAmount(value: string) {
  if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error('Enter a positive USDT amount with at most 18 decimals');
  const amount = ethers.parseUnits(value, token.decimals);
  if (amount <= 0n) throw new Error('Amount must be greater than zero');
  return amount;
}
function active(address: string) {
  if (!nativeStore.isHealthy() || nativeStore.getWallet()?.address.toLowerCase() !== address.toLowerCase()) throw new Error('Active wallet changed or secure storage unavailable');
}
function save(record: WalletTransfer) {
  nativeStore.setItem(KEY, JSON.stringify([...walletTransfers.all().filter(t => t.id !== record.id), record]));
  return nativeStore.flush();
}
export function matchesTransfer(receipt: ethers.TransactionReceipt, record: WalletTransfer) {
  return receipt.status === 1 && receipt.logs.some(log => {
    if (log.address.toLowerCase() !== token.address.toLowerCase()) return false;
    try {
      const event = abi.parseLog(log);
      return event?.name === 'Transfer' && event.args[0].toLowerCase() === record.from.toLowerCase() &&
        event.args[1].toLowerCase() === record.to.toLowerCase() && event.args[2] === transferAmount(record.amount);
    } catch { return false; }
  });
}
export const walletTransfers = {
  all(): WalletTransfer[] { return JSON.parse(nativeStore.getItem(KEY) || '[]'); },
  verified(from: string, to: string) { return this.all().some(t => t.test && t.state === 'verified' && t.from.toLowerCase() === from.toLowerCase() && t.to.toLowerCase() === to.toLowerCase()); },
  async review(from: string, to: string, input: string): Promise<TransferReview> {
    active(from);
    to = ethers.getAddress(to);
    if (from.toLowerCase() === to.toLowerCase()) throw new Error('Choose a different destination wallet');
    const destination = (await nativeStore.listWallets()).find(w => w.address.toLowerCase() === to.toLowerCase());
    if (!destination) throw new Error('Destination is not a saved wallet');
    if (destination.needsBackup) throw new Error('Switch to the destination and complete its recovery backup before funding it');
    const test = !this.verified(from, to);
    const amount = transferAmount(input);
    if (test && amount !== transferAmount('1')) throw new Error('First send the 1 USDT test, then switch to the destination to verify receipt');
    if (this.all().some(t => t.from.toLowerCase() === from.toLowerCase() && ['preparing', 'pending'].includes(t.state))) throw new Error('Check the pending transfer before sending another');
    return web3Service.executeWithRpcFallback(56, async provider => {
      if (Number((await provider.getNetwork()).chainId) !== 56) throw new Error('RPC is not connected to BSC');
      const contract = new ethers.Contract(token.address, abi, provider);
      const [balance, bnb, fees, gas] = await Promise.all([
        contract.balanceOf(from) as Promise<bigint>, provider.getBalance(from), provider.getFeeData(),
        provider.estimateGas({ from, to: token.address, data: abi.encodeFunctionData('transfer', [to, amount]) }),
      ]);
      if (balance < amount) throw new Error('Insufficient BSC USDT');
      const rate = fees.maxFeePerGas ?? fees.gasPrice;
      if (!rate) throw new Error('Gas estimate unavailable');
      const gasCost = gas * 120n / 100n * rate;
      if (bnb < gasCost) throw new Error('Insufficient BNB for gas on BSC');
      active(from);
      return { from, to, amount: ethers.formatUnits(amount, token.decimals), test, balance: ethers.formatUnits(balance, token.decimals), gasBnb: ethers.formatEther(gasCost) };
    });
  },
  async send(review: TransferReview) {
    return exclusive(async () => {
      const fresh = await this.review(review.from, review.to, review.amount);
      const record: WalletTransfer = { id: crypto.randomUUID(), from: fresh.from, to: fresh.to, amount: fresh.amount, test: fresh.test, state: 'preparing', createdAt: Date.now() };
      await save(record);
      try {
        active(record.from);
        const receipt = await confirmedTransaction(web3Service.getSigner(record.from, 56), 56, token.address,
          abi.encodeFunctionData('transfer', [record.to, transferAmount(record.amount)]),
          { onPrepared: async hash => { record.hash = hash; record.state = 'pending'; await save(record); } });
        if (!matchesTransfer(receipt, record)) throw new Error('Expected USDT transfer was not found in the receipt');
        record.state = 'confirmed'; await save(record);
        return record;
      } catch (error) {
        record.error = String(error);
        record.state = record.hash ? 'pending' : 'failed';
        await save(record); throw error;
      }
    });
  },
  async check(id: string, verify = false) {
    return exclusive(async () => {
      const record = this.all().find(t => t.id === id);
      if (!record) throw new Error('Transfer not found');
      const journalKey = `haven_transactions_${record.from.toLowerCase()}_56`;
      const journal = JSON.parse(nativeStore.getItem(journalKey) || 'null');
      if (!record.hash) {
        const data = abi.encodeFunctionData('transfer', [record.to, transferAmount(record.amount)]);
        if (journal?.to?.toLowerCase() === token.address.toLowerCase() && journal.data === data) {
          record.hash = journal.hash; record.state = 'pending'; await save(record);
        } else {
          record.state = 'failed'; record.error = 'Transfer was interrupted before signing. You can review and try again.';
          await save(record); throw new Error(record.error);
        }
      }
      if (verify) active(record.to);
      const receipt = await web3Service.executeWithRpcFallback(56, async provider => {
        if (Number((await provider.getNetwork()).chainId) !== 56) throw new Error('RPC is not connected to BSC');
        const receipt = await provider.getTransactionReceipt(record.hash!);
        if (!receipt) throw new Error('Transfer is still pending. Check again shortly.');
        if (receipt.status === 0) return receipt;
        if (await receipt.confirmations() < 3) throw new Error('Waiting for 3 BSC confirmations. Check again shortly.');
        return receipt;
      });
      // A receipt check can recover a send whose response was lost. Retire only
      // its own signed journal so an identical later transfer gets a fresh nonce.
      if (journal?.hash === record.hash) { nativeStore.removeItem(journalKey); await nativeStore.flush(); }
      if (!matchesTransfer(receipt, record)) {
        record.state = 'failed'; record.error = 'Transaction reverted or expected USDT receipt was missing'; await save(record); throw new Error(record.error);
      }
      if (verify) active(record.to);
      record.state = verify && record.test || record.state === 'verified' ? 'verified' : 'confirmed';
      record.error = undefined; await save(record);
    });
  },
};
