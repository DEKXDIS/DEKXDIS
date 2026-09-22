import { ethers } from 'ethers';
import { ETH_ADDRESS, cowBridgeSdk, withCowBridgeSdk, type CowBridgeQuote, type CowBridgeContext } from './cowBridgeSdk';
import { confirmedTransaction } from './transactionJournal';
import { bridgeJournal, type BridgeTransfer } from './bridgeJournal';
import { quantityForUsd } from '../utils/amounts';
import { nativeStore } from './nativeStore';
import { getChainConfig } from '../types/chains';
import { web3Service } from './web3Service';
import { marketDataService } from './marketDataService';
import { systemLogService } from './systemLogService';
import { approvalGasReserve, estimateTransferGas, gasTransactionFields, spendableNative } from './transferGas';
import { cowProtocol } from './cowProtocol';
import { orderJournal } from './orderJournal';
import type { TokenConfig } from '../types/trading';

export interface BridgeQuote {
  owner?: string; quotedAt?: number; fromAmountRaw?: string; bridgeTool?: string;
  fromChainId: number; toChainId: number; fromTokenAddress: string; toTokenAddress: string;
  fromAmount: string; toAmount: string; fromAmountUsd: number; toAmountUsd: number;
  bridgeFeeUsd: number; gasCostUsd: number; estimatedDurationSeconds: number; bridgeName: string; bridgeLogo?: string;
  approvalAddress?: string; nativeRequiredWei?: string; gasReserveWei?: string;
  cowBridge?: CowBridgeQuote; sourceToken?: TokenConfig; destinationToken?: TokenConfig;
  quoteId?: string; nativeInput?: boolean; minimumReceiveRaw?: string;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const consumed = new Map<string, string>();
const executing = new Set<string>();
const isNative = (address: string) => same(address, ETH_ADDRESS);
function tokenForSdk(token: TokenConfig, chainId: number, category?: string) {
  if (category !== undefined) return category === 'native' ? ETH_ADDRESS : token.address;
  const chain = getChainConfig(chainId);
  return category === 'native' || (token.symbol === chain.nativeToken.symbol && same(token.address, chain.nativeToken.wrappedAddress)) ? ETH_ADDRESS : token.address;
}
function assertWallet(owner: string) {
  if (!nativeStore.isHealthy() || !same(nativeStore.getWallet()?.address || '', owner)) throw new Error('Wallet changed or secure storage unavailable');
}
function assertFresh(quote: BridgeQuote, owner: string) {
  if (!quote.quotedAt || Date.now() - quote.quotedAt > 60000 || !same(quote.owner || '', owner)) throw new Error('Bridge quote expired or wallet changed. Request a fresh quote.');
  if (!quote.cowBridge || !quote.quoteId || !quote.fromAmountRaw || BigInt(quote.fromAmountRaw) <= 0n || !quote.sourceToken || !quote.destinationToken) throw new Error('CoW bridge quote is incomplete');
  if (quote.cowBridge.swap.orderToSign.validTo * 1000 <= Date.now()) throw new Error('CoW order quote expired');
}
export function validateCowBridgeQuote(quote: BridgeQuote) {
  const result = quote.cowBridge!;
  const bridge = result.bridge.tradeParameters;
  const source = result.swap.orderToSign;
  if (!quote.nativeInput && !same(quote.approvalAddress || '', getChainConfig(quote.fromChainId).cowVaultRelayer)) throw new Error('CoW approval spender mismatch');
  if (quote.fromChainId === quote.toChainId || bridge.sellTokenChainId !== quote.fromChainId || bridge.buyTokenChainId !== quote.toChainId ||
      !same(bridge.buyTokenAddress, quote.toTokenAddress) || !same(bridge.bridgeRecipient || bridge.receiver || '', quote.owner!) ||
      !same(result.swap.tradeParameters.owner || '', quote.owner!) || !same(result.swap.tradeParameters.sellToken, quote.fromTokenAddress) ||
      result.swap.tradeParameters.sellTokenDecimals !== quote.sourceToken!.decimals || bridge.buyTokenDecimals !== quote.destinationToken!.decimals) throw new Error('CoW quote token, chain, decimals, or recipient mismatch');
  const expectedSell = quote.nativeInput ? getChainConfig(quote.fromChainId).nativeToken.wrappedAddress : quote.fromTokenAddress;
  if (!(same(source.sellToken, quote.fromTokenAddress) || same(source.sellToken, expectedSell)) ||
      source.kind !== 'sell' || source.partiallyFillable || source.feeAmount !== '0' || BigInt(source.sellAmount) !== BigInt(quote.fromAmountRaw!) ||
      BigInt(source.buyAmount) <= 0n || BigInt(quote.minimumReceiveRaw!) <= 0n ||
      result.bridge.amountsAndCosts.afterSlippage.buyAmount.toString() !== quote.minimumReceiveRaw) throw new Error('CoW quote changed the authorized quantities or source order');
  const app = result.swap.appDataInfo;
  if (ethers.keccak256(ethers.toUtf8Bytes(app.fullAppData)) !== app.appDataKeccak256) throw new Error('CoW bridge app-data hash mismatch');
}
async function verifiedDecimals(context: CowBridgeContext, token: TokenConfig, chainId: number, native: boolean) {
  if (native) { if (token.decimals !== getChainConfig(chainId).nativeToken.decimals) throw new Error('Native token decimals mismatch'); return; }
  const provider = chainId === context.chainId ? context.provider : web3Service.getProvider(chainId);
  try {
    const contract = new ethers.Contract(token.address, ['function decimals() view returns(uint8)'], provider);
    if (Number(await contract.decimals()) !== token.decimals) throw new Error('Selected token decimals do not match its contract');
  } finally { if (provider !== context.provider) provider.destroy(); }
}
async function funding(context: CowBridgeContext, quote: BridgeQuote) {
  if (!quote.cowBridge || !quote.fromAmountRaw) throw new Error('CoW quote missing for gas calculation');
  if (quote.nativeInput) {
    const result = await cowBridgeSdk.nativeTransaction(context, quote.cowBridge, quote.cowBridge.swap.appDataInfo.appDataKeccak256,
      quote.cowBridge.swap.tradeParameters.receiver || context.owner, new ethers.VoidSigner(context.owner, context.provider));
    const gas = await estimateTransferGas(context.provider, quote.fromChainId, { ...result.transaction, from: context.owner });
    return { reserveWei: gas.reserveWei, requiredWei: gas.reserveWei + BigInt(result.transaction.value) };
  }
  const reserveWei = await approvalGasReserve(context.provider, quote.fromChainId, context.owner, quote.fromTokenAddress,
    getChainConfig(quote.fromChainId).cowVaultRelayer, BigInt(quote.fromAmountRaw));
  return { reserveWei, requiredWei: reserveWei };
}

export const crossChainBridgeService = {
  async fetchBridgeQuote(fromChainId: number, toChainId: number, amountUsd: number, owner: string,
    source?: TokenConfig, destination?: TokenConfig, options: { max?: boolean; amountRaw?: string; sourceCategory?: string; destinationCategory?: string } = {}): Promise<BridgeQuote> {
    if (fromChainId === toChainId) throw new Error('Source chain and destination chain must be different');
    if (!ethers.isAddress(owner) || !source || !destination) throw new Error('A valid wallet and explicit source/destination assets are required');
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('Bridge USD amount must be positive');
    const fromAddress = tokenForSdk(source, fromChainId, options.sourceCategory), toAddress = tokenForSdk(destination, toChainId, options.destinationCategory);
    return withCowBridgeSdk(fromChainId, owner, async context => {
      await Promise.all([verifiedDecimals(context, source, fromChainId, isNative(fromAddress)), verifiedDecimals(context, destination, toChainId, isNative(toAddress))]);
      const sourcePrice = isNative(fromAddress) ? await marketDataService.fetchNativeTokenPrice(fromChainId) : (await marketDataService.fetchTokenPrice(source.address, fromChainId)).price;
      const destinationPrice = isNative(toAddress) ? await marketDataService.fetchNativeTokenPrice(toChainId) : (await marketDataService.fetchTokenPrice(destination.address, toChainId)).price;
      if (!Number.isFinite(sourcePrice) || sourcePrice <= 0 || !Number.isFinite(destinationPrice) || destinationPrice <= 0) throw new Error('Source or destination USD price unavailable');
      const nativeBalance = await context.provider.getBalance(owner, 'pending');
      let amount = options.max ? (isNative(fromAddress) ? nativeBalance : await web3Service.getTokenBalanceWei(owner, source.address, fromChainId))
        : options.amountRaw ? BigInt(options.amountRaw) : ethers.parseUnits(quantityForUsd(amountUsd.toFixed(18), sourcePrice, source.decimals), source.decimals);
      if (options.max && isNative(fromAddress)) {
        const fees = await context.provider.getFeeData(); const rate = fees.maxFeePerGas ?? fees.gasPrice;
        if (!rate || rate <= 0n) throw new Error('Native gas price unavailable');
        amount = spendableNative(nativeBalance, rate * 500000n);
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        if (amount <= 0n) throw new Error('No spendable source token balance');
        const result = await cowBridgeSdk.quote(context, toChainId, fromAddress, toAddress, source.decimals, destination.decimals, amount);
        const received = result.bridge.amountsAndCosts.afterFee.buyAmount;
        const quote: BridgeQuote = { owner: owner.toLowerCase(), quotedAt: Date.now(), quoteId: crypto.randomUUID(), fromChainId, toChainId,
          fromTokenAddress: fromAddress, toTokenAddress: toAddress, fromAmountRaw: amount.toString(), fromAmount: ethers.formatUnits(amount, source.decimals),
          toAmount: ethers.formatUnits(received, destination.decimals), fromAmountUsd: Number(ethers.formatUnits(amount, source.decimals)) * sourcePrice,
          toAmountUsd: Number(ethers.formatUnits(received, destination.decimals)) * destinationPrice,
          bridgeFeeUsd: Number(ethers.formatUnits(result.bridge.amountsAndCosts.costs.bridgingFee.amountInBuyCurrency, destination.decimals)) * destinationPrice,
          gasCostUsd: 0, estimatedDurationSeconds: result.bridge.expectedFillTimeSeconds || 0, bridgeName: `CoW Protocol via ${result.bridge.providerInfo.name}`,
          bridgeTool: result.bridge.providerInfo.dappId, bridgeLogo: result.bridge.providerInfo.logoUrl, cowBridge: result, nativeInput: isNative(fromAddress),
          sourceToken: { ...source }, destinationToken: { ...destination }, minimumReceiveRaw: result.bridge.amountsAndCosts.afterSlippage.buyAmount.toString(),
          approvalAddress: isNative(fromAddress) ? undefined : getChainConfig(fromChainId).cowVaultRelayer };
        validateCowBridgeQuote(quote);
        const gas = await funding(context, quote);
        if (options.max && quote.nativeInput) {
          const spendable = spendableNative(nativeBalance, gas.reserveWei);
          if (spendable < amount || (attempt === 0 && spendable > amount)) { amount = spendable; continue; }
        }
        if (gas.requiredWei > nativeBalance) throw new Error('Insufficient native balance for CoW transfer and approval gas');
        const nativePrice = await marketDataService.fetchNativeTokenPrice(fromChainId);
        if (!Number.isFinite(nativePrice) || nativePrice <= 0) throw new Error('Native gas USD price unavailable');
        return { ...quote, gasReserveWei: gas.reserveWei.toString(), nativeRequiredWei: gas.requiredWei.toString(),
          gasCostUsd: Number(ethers.formatUnits(gas.reserveWei, getChainConfig(fromChainId).nativeToken.decimals)) * nativePrice };
      }
      throw new Error('Native MAX gas reserve changed repeatedly. Request a fresh quote.');
    });
  },
  async bridgeFunding(owner: string, quote: BridgeQuote) { return withCowBridgeSdk(quote.fromChainId, owner, context => funding(context, quote)); },
  async executeBridge(owner: string, quote: BridgeQuote, onPrepared?: (uid: string) => void): Promise<string> {
    assertFresh(quote, owner); assertWallet(owner); validateCowBridgeQuote(quote);
    const prior = consumed.get(quote.quoteId!) || bridgeJournal.all(owner).find(record => record.quoteId === quote.quoteId)?.hash;
    if (prior) { onPrepared?.(prior); throw new Error(`This quote was already submitted as ${prior}; its original transfer is being tracked`); }
    if (executing.has(quote.quoteId!)) throw new Error('This CoW transfer is already being submitted');
    executing.add(quote.quoteId!);
    try {
      return await withCowBridgeSdk(quote.fromChainId, owner, async context => {
        assertFresh(quote, owner); assertWallet(owner);
        const signer = web3Service.getSigner(owner, quote.fromChainId).connect(context.provider);
        const needed = await funding(context, quote);
        if (await context.provider.getBalance(owner, 'pending') < needed.requiredWei) throw new Error('Native balance no longer covers the CoW transfer gas reserve');
        if (!quote.nativeInput) {
          if (await web3Service.getTokenBalanceWei(owner, quote.fromTokenAddress, quote.fromChainId) < BigInt(quote.fromAmountRaw!)) throw new Error('Insufficient source token balance');
          const contract = new ethers.Contract(quote.fromTokenAddress, ['function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)'], context.provider);
          const allowance = BigInt(await contract.allowance(owner, quote.approvalAddress!));
          const approve = async (amount: bigint) => {
            const data = contract.interface.encodeFunctionData('approve', [quote.approvalAddress, amount]);
            await confirmedTransaction(signer, quote.fromChainId, quote.fromTokenAddress, data, { beforePrepare: async () => {
              assertWallet(owner); const gas = await estimateTransferGas(context.provider, quote.fromChainId, { from: owner, to: quote.fromTokenAddress, data });
              if (await context.provider.getBalance(owner, 'pending') < gas.reserveWei) throw new Error('Insufficient native balance for CoW approval');
              return gasTransactionFields(gas);
            } });
          };
          if (allowance < BigInt(quote.fromAmountRaw!)) { if (allowance > 0n) await approve(0n); await approve(BigInt(quote.fromAmountRaw!)); }
        }
        assertFresh(quote, owner); assertWallet(owner);
        if (!quote.nativeInput && await web3Service.getTokenBalanceWei(owner, quote.fromTokenAddress, quote.fromChainId) < BigInt(quote.fromAmountRaw!)) throw new Error('Source balance changed during approval');
        const finalized = await cowBridgeSdk.finalize(context, quote.cowBridge!, signer);
        assertFresh(quote, owner); assertWallet(owner);
        await context.api.uploadAppData(finalized.appData.appDataKeccak256, finalized.appData.fullAppData);
        assertFresh(quote, owner); assertWallet(owner);
        const save = async (uid: string, extra: Partial<BridgeTransfer> = {}) => {
          consumed.set(quote.quoteId!, uid);
          await bridgeJournal.put({ hash: uid, owner: owner.toLowerCase(), protocol: 'cow', orderUid: uid, quoteId: quote.quoteId,
            fromChainId: quote.fromChainId, toChainId: quote.toChainId, tool: quote.bridgeTool, createdAt: Date.now(), status: 'pending', stage: 'submitting',
            sourceToken: quote.sourceToken, destinationToken: quote.destinationToken, fromAmountRaw: quote.fromAmountRaw, minimumReceiveRaw: quote.minimumReceiveRaw,
            nativeInput: quote.nativeInput, nativeOutput: isNative(quote.toTokenAddress), validTo: finalized.order.validTo,
            nextCheckAt: Date.now() + 30000, message: 'CoW order prepared; awaiting submission confirmation', ...extra });
          onPrepared?.(uid);
        };
        let uid: string;
        if (quote.nativeInput) {
          const native = await cowBridgeSdk.nativeTransaction(context, quote.cowBridge!, finalized.appData.appDataKeccak256, finalized.order.receiver, signer);
          if (BigInt(native.transaction.value) !== BigInt(quote.fromAmountRaw!)) throw new Error('CoW native order changed the authorized spending amount');
          uid = native.orderId;
          // Persist transfer intent before transaction bytes, so a crash between journal writes
          // can recover the transaction hash from the matching native order calldata.
          await save(uid, { nativeOrder: { to: native.transaction.to, data: native.transaction.data, value: native.transaction.value } });
          await confirmedTransaction(signer, quote.fromChainId, native.transaction.to, native.transaction.data, {
            value: BigInt(native.transaction.value), beforePrepare: async () => {
              assertFresh(quote, owner); assertWallet(owner);
              const gas = await estimateTransferGas(context.provider, quote.fromChainId, { ...native.transaction, from: owner });
              if (await context.provider.getBalance(owner, 'pending') < BigInt(native.transaction.value) + gas.reserveWei) throw new Error('Native balance changed; refresh MAX');
              return gasTransactionFields(gas);
            }, onPrepared: async sourceHash => save(uid, { sourceHash, nativeOrder: { to: native.transaction.to, data: native.transaction.data, value: native.transaction.value } }),
          });
        } else {
          const signature = await signer.signTypedData(cowProtocol.getEip712Domain(quote.fromChainId), quote.cowBridge!.swap.orderTypedData.types, finalized.order);
          assertFresh(quote, owner); assertWallet(owner);
          uid = await cowProtocol.persistAndPost({ ...finalized.order, signature, signingScheme: 'eip712', from: owner.toLowerCase(),
            appData: finalized.appData.fullAppData, appDataHash: finalized.appData.appDataKeccak256, quoteId: quote.cowBridge!.swap.quoteResponse.id },
          quote.fromChainId, owner, async uid => save(uid), 'bridge');
        }
        const record = bridgeJournal.all(owner).find(item => item.hash === uid)!;
        await bridgeJournal.put({ ...record, stage: 'source', message: 'CoW order submitted; awaiting source settlement' });
        systemLogService.addLog({ level: 'info', category: 'BRIDGE', title: 'CoW cross-chain order submitted',
          details: `${quote.fromAmount} ${quote.sourceToken!.symbol} ($${quote.fromAmountUsd.toFixed(2)} USD)\n${quote.bridgeName}\nOrder: ${uid}\nAwaiting source settlement and destination delivery.`,
          chainId: quote.fromChainId, explorerUrl: cowProtocol.getExplorerUrl(uid) });
        return uid;
      });
    } catch (error) {
      const uid = consumed.get(quote.quoteId!); const record = uid && bridgeJournal.all(owner).find(item => item.hash === uid);
      if (record && orderJournal.all().find(item => item.uid === uid)?.rejected) await bridgeJournal.put({ ...record, status: 'failed', message: String(error) });
      systemLogService.logError('BRIDGE', 'CoW cross-chain submission failed', `${quote.bridgeName}\n${uid ? `Original order remains tracked: ${uid}\n` : ''}${String(error)}`, quote.fromChainId);
      throw error;
    } finally { executing.delete(quote.quoteId!); }
  },
};
