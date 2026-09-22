import { ethers } from 'ethers';
import { nativeStore } from './nativeStore';
import { NativeSigner } from './nativeSigner';
import { confirmedTransaction } from './transactionJournal';
import { exclusive } from './executionEngine';
import { estimateTransferGas, gasTransactionFields, spendableNative } from './transferGas';
import { marketDataService } from './marketDataService';
import { rpcService } from './rpcService';
import { systemLogService } from './systemLogService';
import { sendRead, sendErrorText, sendFailureReported, rememberSendCooldown, assertSendRpcReady } from './assetSendRequests';
import { SUPPORTED_CHAINS, getChainConfig } from '../types/chains';
import { assertDecimals, quantityForUsd } from '../utils/amounts';

export type SendAsset = { chainId: number; symbol: string; decimals: number } &
  ({ kind: 'native' } | { kind: 'erc20'; address: string });
export interface AssetSendReview {
  id: string; from: string; to: string; asset: SendAsset; amountRaw: string; gasReserveWei: string;
  amountUsd?: number; inputUsd?: string; max: boolean; createdAt: number; expiresAt: number;
}
export interface AssetSendRecord extends AssetSendReview {
  state: 'preparing' | 'pending' | 'confirmed' | 'failed' | 'receipt-mismatch';
  hash?: string; error?: string;
}
const KEY = 'haven_asset_sends_v1';
const issued = new Map<string, AssetSendReview>();
const operations = new Map<string, Promise<AssetSendRecord>>();
const abi = new ethers.Interface([
  'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const pending = (record: AssetSendRecord) => record.state === 'preparing' || record.state === 'pending';
const journalKey = (record: Pick<AssetSendReview, 'from' | 'asset'>) => `haven_transactions_${record.from.toLowerCase()}_${record.asset.chainId}`;

export function sendRecipient(input: string, from: string): string {
  const address = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Enter the full wallet address: 0x followed by 40 hexadecimal characters');
  let normalized: string;
  try { normalized = ethers.getAddress(address); } catch { throw new Error('Wallet address checksum is invalid; copy the address again from your receiving wallet'); }
  if (normalized === ethers.ZeroAddress) throw new Error('The zero address cannot receive this transfer');
  if (normalized.toLowerCase() === from.toLowerCase()) throw new Error('Choose a recipient different from the sending wallet');
  return normalized;
}
function active(from: string) {
  if (!nativeStore.isHealthy() || nativeStore.getWallet()?.address.toLowerCase() !== from.toLowerCase()) {
    throw new Error('Active wallet changed or secure storage unavailable; reopen Send from the active wallet');
  }
}
function assetIdentity(asset: SendAsset): SendAsset {
  if (!SUPPORTED_CHAINS[asset.chainId]) throw new Error('Unsupported transfer network');
  const chain = getChainConfig(asset.chainId);
  if (asset.kind === 'native') return { kind: 'native', chainId: asset.chainId, symbol: chain.nativeToken.symbol, decimals: chain.nativeToken.decimals };
  assertDecimals(asset.decimals);
  const address = ethers.getAddress(asset.address);
  if (address === ethers.ZeroAddress) throw new Error('Invalid token contract');
  return { ...asset, address };
}
function all(): AssetSendRecord[] {
  const records = JSON.parse(nativeStore.getItem(KEY) || '[]');
  if (!Array.isArray(records)) throw new Error('Stored asset transfer history is invalid');
  return records;
}
async function save(record: AssetSendRecord) {
  nativeStore.setItem(KEY, JSON.stringify([...all().filter(item => item.id !== record.id), record]));
  await nativeStore.flush();
}
function context(record: Pick<AssetSendReview, 'from' | 'to' | 'asset'>): string {
  return `${record.from} → ${record.to}; ${record.asset.symbol}; ${record.asset.kind === 'native' ? 'native currency' : record.asset.address}`;
}
function report(title: string, error: unknown, chainId: number, details: string) {
  if (!sendFailureReported(error)) systemLogService.logError('WALLET', title, `${details}; ${sendErrorText(error)}`, chainId);
}
async function providerRead<T>(chainId: number, load: (provider: ethers.JsonRpcProvider) => Promise<T>): Promise<T> {
  assertSendRpcReady(chainId);
  const endpoint = rpcService.getRpcUrls(chainId)[0];
  if (!endpoint) throw new Error('No RPC endpoint configured for this network');
  const request = new ethers.FetchRequest(endpoint);
  request.timeout = 12000;
  // Retry/cooldown belongs to sendRead; ethers must not add a second retry budget.
  request.retryFunc = async () => false;
  const provider = new ethers.JsonRpcProvider(request, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  try {
    if (Number((await provider.getNetwork()).chainId) !== chainId) throw new Error('Transfer RPC network does not match the selected network');
    return await load(provider);
  } catch (error) { rememberSendCooldown(chainId, error); throw error; }
  finally { provider.destroy(); }
}

export function sendTransactionRequest(review: Pick<AssetSendReview, 'from' | 'to' | 'asset' | 'amountRaw'>): ethers.TransactionRequest {
  const amount = BigInt(review.amountRaw);
  if (amount <= 0n) throw new Error('Transfer amount must be positive');
  return review.asset.kind === 'native'
    ? { from: review.from, to: review.to, data: '0x', value: amount }
    : { from: review.from, to: review.asset.address, data: abi.encodeFunctionData('transfer', [review.to, amount]), value: 0n };
}
async function balances(provider: ethers.Provider, from: string, asset: SendAsset) {
  const native = await provider.getBalance(from, 'pending');
  if (asset.kind === 'native') return { native, token: native };
  const contract = new ethers.Contract(asset.address, abi, provider);
  const decimals = Number(await contract.decimals());
  if (decimals !== asset.decimals) throw new Error('Selected token decimals do not match its contract');
  return { native, token: BigInt(await contract.balanceOf(from, { blockTag: 'pending' })) };
}
async function preflight(provider: ethers.Provider, review: Pick<AssetSendReview, 'from' | 'to' | 'asset' | 'amountRaw'>) {
  active(review.from);
  const balance = await balances(provider, review.from, review.asset);
  const amount = BigInt(review.amountRaw);
  if (amount > balance.token) throw new Error(`Insufficient ${review.asset.symbol} balance`);
  const transaction = sendTransactionRequest(review);
  if (review.asset.kind === 'erc20') {
    const result = await provider.call(transaction);
    // Some established ERC-20 contracts return no data. Explicit false is always failure.
    if (result !== '0x' && !abi.decodeFunctionResult('transfer', result)[0]) throw new Error('Token contract rejected the transfer');
  }
  const gas = await estimateTransferGas(provider, review.asset.chainId, transaction);
  const required = gas.reserveWei + (review.asset.kind === 'native' ? amount : 0n);
  if (required > balance.native) throw new Error(`Insufficient ${getChainConfig(review.asset.chainId).nativeToken.symbol} for transfer and network gas`);
  active(review.from);
  return gas;
}

export function matchesAssetSend(receipt: ethers.TransactionReceipt, tx: Pick<ethers.TransactionResponse, 'from' | 'to' | 'value' | 'data' | 'chainId' | 'hash'>, record: AssetSendRecord): boolean {
  const request = sendTransactionRequest(record);
  if (receipt.status !== 1 || receipt.hash !== record.hash || tx.hash !== record.hash || Number(tx.chainId) !== record.asset.chainId ||
    tx.from.toLowerCase() !== record.from.toLowerCase() || tx.to?.toLowerCase() !== String(request.to).toLowerCase() ||
    tx.value !== request.value || tx.data !== request.data) return false;
  if (record.asset.kind === 'native') return true;
  const token = record.asset.address.toLowerCase();
  let received = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token || log.topics[0] !== abi.getEvent('Transfer')!.topicHash) continue;
    const event = abi.parseLog(log);
    if (event?.args[0].toLowerCase() === record.from.toLowerCase() && event.args[1].toLowerCase() === record.to.toLowerCase()) received += event.args[2];
  }
  return received === BigInt(record.amountRaw);
}
async function settle(provider: ethers.Provider, record: AssetSendRecord, receipt: ethers.TransactionReceipt) {
  if (receipt.hash !== record.hash) throw new Error('Transfer receipt hash mismatch');
  if (receipt.status === 0) { record.state = 'failed'; record.error = 'Transaction reverted on-chain'; }
  else {
    const tx = await provider.getTransaction(record.hash!);
    if (!tx) throw new Error('Confirmed transaction details unavailable; check the original transaction again');
    if (matchesAssetSend(receipt, tx, record)) { record.state = 'confirmed'; record.error = undefined; }
    else { record.state = 'receipt-mismatch'; record.error = 'Transaction completed, but its receipt does not show the exact requested transfer. Inspect the original transaction before any further send.'; }
  }
  await save(record);
  if (record.state === 'confirmed') systemLogService.logSuccess('WALLET', 'External wallet transfer confirmed',
    `${context(record)}; ${ethers.formatUnits(record.amountRaw, record.asset.decimals)} ${record.asset.symbol}`, record.hash, getChainConfig(record.asset.chainId).txUrl(record.hash!), record.asset.chainId);
  else report('External wallet transfer failed', record.error, record.asset.chainId, `${context(record)}; transaction ${record.hash}`);
}
function originalJournal(record: AssetSendRecord) {
  const raw = nativeStore.getItem(journalKey(record));
  if (!raw) return null;
  const journal = JSON.parse(raw);
  if (journal.operationId !== record.id) return null;
  const tx = ethers.Transaction.from(journal.raw);
  const request = sendTransactionRequest(record);
  if (!tx.isSigned() || tx.hash !== journal.hash || (record.hash && record.hash !== tx.hash) ||
    Number(tx.chainId) !== record.asset.chainId || tx.from?.toLowerCase() !== record.from.toLowerCase() ||
    tx.to?.toLowerCase() !== String(request.to).toLowerCase() || tx.data !== request.data || tx.value !== request.value) {
    throw new Error('Stored signed transaction does not match this transfer; recovery stopped');
  }
  return journal as { hash: string; raw: string; operationId: string };
}
function single(id: string, work: () => Promise<AssetSendRecord>): Promise<AssetSendRecord> {
  const existing = operations.get(id);
  if (existing) return existing;
  const next = work().finally(() => operations.delete(id));
  operations.set(id, next);
  return next;
}

export const assetSendService = {
  all(from: string) { return all().filter(record => record.from.toLowerCase() === from.toLowerCase()); },
  async review(from: string, inputAsset: SendAsset, recipient: string, usd: string, max: boolean): Promise<AssetSendReview> {
    try {
      active(from);
      const asset = assetIdentity(inputAsset);
      const to = sendRecipient(recipient, from);
      if (!max && (!/^\d+(\.\d{1,18})?$/.test(usd) || ethers.parseUnits(usd, 18) <= 0n)) throw new Error('Enter a positive USD amount');
      if (all().some(record => record.from.toLowerCase() === from.toLowerCase() && record.asset.chainId === asset.chainId && pending(record))) {
        throw new Error('Check the pending transfer on this network before starting another');
      }
      const key = `review:${JSON.stringify([from, asset, to, max ? 'MAX' : usd])}`;
      const result = await sendRead(key, asset.chainId, () => providerRead(asset.chainId, async provider => {
        const balance = await balances(provider, from, asset);
        let price: number | undefined;
        if (!max) {
          if (asset.kind === 'native') price = await marketDataService.fetchNativeTokenPrice(asset.chainId);
          else {
            const quote = await marketDataService.fetchTokenPrice(asset.address, asset.chainId);
            if (!Number.isFinite(quote.lastUpdated) || Date.now() - quote.lastUpdated > 30000) throw new Error('Fresh token USD price unavailable');
            price = quote.price;
          }
          if (!Number.isFinite(price) || price! <= 0) throw new Error('Fresh positive USD price unavailable');
        }
        let amount = max ? balance.token : ethers.parseUnits(quantityForUsd(usd, price!, asset.decimals), asset.decimals);
        if (amount <= 0n) throw new Error('No spendable token balance');
        if (max && asset.kind === 'native') {
          const seed = await estimateTransferGas(provider, asset.chainId, { from, to, data: '0x', value: 1n });
          amount = spendableNative(balance.native, seed.reserveWei);
          for (let attempt = 0; attempt < 3; attempt++) {
            const gas = await estimateTransferGas(provider, asset.chainId, { from, to, data: '0x', value: amount });
            const affordable = spendableNative(balance.native, gas.reserveWei);
            if (amount <= affordable) break;
            amount = affordable;
            if (attempt === 2) throw new Error('Network gas changed while calculating MAX; review again');
          }
        }
        const draft = { from: ethers.getAddress(from), to, asset, amountRaw: amount.toString() };
        const gas = await preflight(provider, draft);
        const createdAt = Date.now();
        return { ...draft, id: crypto.randomUUID(), gasReserveWei: gas.reserveWei.toString(), max,
          inputUsd: max ? undefined : usd, amountUsd: price === undefined ? undefined : Number(ethers.formatUnits(amount, asset.decimals)) * price,
          createdAt, expiresAt: createdAt + 30000 };
      }), true);
      for (const [id, review] of issued) if (review.expiresAt < Date.now()) issued.delete(id);
      issued.set(result.id, structuredClone(result));
      return result;
    } catch (error) { report('Unable to review external transfer', error, inputAsset.chainId, `${from} → ${recipient}`); throw error; }
  },
  discard(id: string) { issued.delete(id); },
  send(id: string): Promise<AssetSendRecord> {
    return single(id, () => exclusive(async () => {
      const existing = all().find(record => record.id === id);
      if (existing) return existing; // An authorization is never reused, even after failure.
      const review = issued.get(id);
      if (!review) {
        systemLogService.logError('WALLET', 'External transfer review unavailable', `Operation ${id}; review again before sending`);
        throw new Error('Transfer review is no longer available; review again');
      }
      issued.delete(id);
      const record: AssetSendRecord = { ...review, state: 'preparing' };
      try {
        active(review.from);
        if (Date.now() >= review.expiresAt) throw new Error('Transfer review expired; review again');
        if (all().some(item => item.from.toLowerCase() === review.from.toLowerCase() && item.asset.chainId === review.asset.chainId && pending(item))) throw new Error('Check the pending transfer before sending another');
        await save(record);
        await providerRead(review.asset.chainId, async provider => {
          const request = sendTransactionRequest(review);
          await confirmedTransaction(new NativeSigner(review.from, provider, review.asset.chainId), review.asset.chainId, String(request.to), String(request.data), {
            operationId: id, value: BigInt(request.value!.toString()),
            onBroadcastError: error => { rememberSendCooldown(review.asset.chainId, error); assertSendRpcReady(review.asset.chainId); },
            beforePrepare: async () => {
              active(review.from);
              const gas = await preflight(provider, review);
              if (Date.now() >= review.expiresAt) throw new Error('Transfer review expired; review again');
              if (gas.reserveWei > BigInt(review.gasReserveWei)) throw new Error('Network gas increased; review the updated fee before sending');
              return gasTransactionFields(gas);
            },
            onPrepared: async hash => { record.hash = hash; record.state = 'pending'; await save(record); },
            onConfirmed: receipt => settle(provider, record, receipt),
          });
        });
        return record;
      } catch (error) {
        report('External wallet send interrupted', error, review.asset.chainId, `${context(review)}; operation ${id}${record.hash ? `; transaction ${record.hash}` : ''}`);
        if (record.state !== 'confirmed' && record.state !== 'receipt-mismatch' && record.state !== 'failed') {
          try {
            const journal = originalJournal(record);
            if (journal) record.hash = journal.hash;
            record.state = record.hash ? 'pending' : 'failed';
            record.error = sendErrorText(error);
            await save(record);
          } catch (storageError) {
            report('Unable to save transfer recovery state', storageError, review.asset.chainId, `${context(review)}; operation ${id}`);
            throw new Error(`${sendErrorText(error)}; recovery state: ${sendErrorText(storageError)}`);
          }
        }
        throw error;
      }
    }));
  },
  check(id: string, manual = false): Promise<AssetSendRecord> {
    return single(id, async () => {
      const record = all().find(item => item.id === id);
      if (!record) throw new Error('Transfer record not found');
      if (!pending(record)) return record;
      try {
        const journal = originalJournal(record);
        if (!record.hash && journal) { record.hash = journal.hash; record.state = 'pending'; await save(record); }
        if (!record.hash) {
          record.state = 'failed'; record.error = 'Transfer stopped before signing. Create a new review to try again.';
          await save(record); report('External transfer was not signed', record.error, record.asset.chainId, context(record));
          return record;
        }
        return await sendRead(`check:${record.id}`, record.asset.chainId, () => providerRead(record.asset.chainId, async provider => {
          const receipt = await provider.getTransactionReceipt(record.hash!);
          if (!receipt) return record;
          return exclusive(async () => {
            await settle(provider, record, receipt);
            const current = originalJournal(record);
            if (current?.hash === record.hash) { nativeStore.removeItem(journalKey(record)); await nativeStore.flush(); }
            return record;
          });
        }), manual);
      } catch (error) { report('Unable to check external transfer', error, record.asset.chainId, `${context(record)}; ${record.hash || id}`); throw error; }
    });
  },
  resume(id: string): Promise<AssetSendRecord> {
    return single(id, () => exclusive(async () => {
      const record = all().find(item => item.id === id);
      if (!record) throw new Error('Transfer record not found');
      if (!pending(record)) return record;
      try {
        active(record.from);
        const journal = originalJournal(record);
        if (!journal) throw new Error('Original signed bytes are unavailable. Use Check status; this transfer will not be signed again.');
        await providerRead(record.asset.chainId, async provider => {
          const request = sendTransactionRequest(record);
          await confirmedTransaction(new NativeSigner(record.from, provider, record.asset.chainId), record.asset.chainId, String(request.to), String(request.data), {
            operationId: id, value: BigInt(request.value!.toString()),
            onBroadcastError: error => { rememberSendCooldown(record.asset.chainId, error); assertSendRpcReady(record.asset.chainId); },
            beforePrepare: async () => { throw new Error('Original transaction is missing; replacement signing blocked'); },
            onPrepared: async hash => { record.hash = hash; record.state = 'pending'; await save(record); },
            onConfirmed: receipt => settle(provider, record, receipt),
          });
        });
        return record;
      } catch (error) { report('Unable to resume original transfer', error, record.asset.chainId, `${context(record)}; ${record.hash || id}`); throw error; }
    }));
  },
};
