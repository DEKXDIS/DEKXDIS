import { ethers } from 'ethers';
import { getChainConfig } from '../types/chains';
import { TokenConfig, CowQuoteResponse } from '../types/trading';
import { quantityForUsd } from '../utils/amounts';
import { web3Service } from './web3Service';
import { marketDataService } from './marketDataService';
import { cowProtocol } from './cowProtocol';
import { BridgeQuote, crossChainBridgeService } from './crossChainBridgeService';
import { approvalGasReserve, estimateTransferGas, spendableNative } from './transferGas';

interface Asset { token: TokenConfig; chainId: number; category: 'native' | 'wrapped' | 'usdt' | 'custom' }
export type AssetTransferQuote = BridgeQuote & { cowQuote?: CowQuoteResponse; inputKey?: string };

export async function assetTransferQuote(owner: string, source: Asset, destination: Asset, usd: string, max: boolean): Promise<AssetTransferQuote> {
  const chain = getChainConfig(source.chainId);
  const provider = web3Service.getProvider(source.chainId);
  try {
    if (source.category !== 'native') {
      const token = new ethers.Contract(source.token.address, ['function decimals() view returns (uint8)'], provider);
      if (Number(await token.decimals()) !== source.token.decimals) throw new Error('Source token decimals do not match its contract');
    }
    if (source.chainId !== destination.chainId) {
      return await crossChainBridgeService.fetchBridgeQuote(source.chainId, destination.chainId, max ? 1 : Number(usd), owner,
        source.token, destination.token, { max, sourceCategory: source.category, destinationCategory: destination.category });
    }
    const isWrap = source.category === 'native' && destination.category === 'wrapped';
    const isUnwrap = source.category === 'wrapped' && destination.category === 'native';
    if (!isWrap && !isUnwrap && (source.category === 'native' || destination.category === 'native')) throw new Error('Wrap the native token before swapping, or select wrapped output and unwrap after settlement.');
    if (!isWrap && !isUnwrap && source.token.address.toLowerCase() === destination.token.address.toLowerCase()) throw new Error('Cannot swap a token for itself');
    const nativeBalance = await provider.getBalance(owner, 'pending');
    const sourcePrice = isWrap || isUnwrap ? await marketDataService.fetchNativeTokenPrice(source.chainId)
      : (await marketDataService.fetchTokenPrice(source.token.address, source.chainId, source.token.binanceSymbol)).price;
    if (!Number.isFinite(sourcePrice) || sourcePrice <= 0) throw new Error('Source USD price unavailable');
    let amount = max ? (isWrap ? nativeBalance : await web3Service.getTokenBalanceWei(owner, source.token.address, source.chainId))
      : ethers.parseUnits(quantityForUsd(usd, sourcePrice, source.token.decimals), source.token.decimals);
    if (amount <= 0n) throw new Error('No spendable source token balance');
    let reserve: bigint, cowQuote: CowQuoteResponse | undefined;
    let receive: string, destinationPrice: number;
    if (isWrap || isUnwrap) {
      const iface = new ethers.Interface(['function deposit() payable', 'function withdraw(uint256)']);
      const request = (value: bigint) => ({ from: owner, to: chain.nativeToken.wrappedAddress,
        data: iface.encodeFunctionData(isWrap ? 'deposit' : 'withdraw', isWrap ? [] : [value]), value: isWrap ? value : 0n });
      const seed = await estimateTransferGas(provider, source.chainId, request(isWrap && max ? 1n : amount));
      if (isWrap && max) amount = spendableNative(nativeBalance, seed.reserveWei);
      const gas = await estimateTransferGas(provider, source.chainId, request(amount));
      reserve = gas.reserveWei;
      if (isWrap && max && amount + reserve > nativeBalance) amount = spendableNative(nativeBalance, reserve);
      receive = ethers.formatUnits(amount, source.token.decimals); destinationPrice = sourcePrice;
    } else {
      cowQuote = await cowProtocol.getQuote({ sellToken: source.token.address, buyToken: destination.token.address,
        amount: ethers.formatUnits(amount, source.token.decimals), kind: 'sell', from: owner,
        sellTokenDecimals: source.token.decimals, buyTokenDecimals: destination.token.decimals, chainId: source.chainId });
      reserve = await approvalGasReserve(provider, source.chainId, owner, source.token.address, chain.cowVaultRelayer, amount);
      receive = ethers.formatUnits(cowQuote.quote.buyAmount, destination.token.decimals);
      destinationPrice = (await marketDataService.fetchTokenPrice(destination.token.address, destination.chainId, destination.token.binanceSymbol)).price;
      if (!Number.isFinite(destinationPrice) || destinationPrice <= 0) throw new Error('Destination USD price unavailable');
    }
    const required = reserve + (isWrap ? amount : 0n);
    if (nativeBalance < required) throw new Error(`Insufficient native ${chain.nativeToken.symbol} for the transfer gas reserve`);
    const nativePrice = isWrap || isUnwrap ? sourcePrice : await marketDataService.fetchNativeTokenPrice(source.chainId);
    const fromAmount = ethers.formatUnits(amount, source.token.decimals);
    return { owner, quotedAt: Date.now(), fromChainId: source.chainId, toChainId: destination.chainId,
      fromTokenAddress: source.token.address, toTokenAddress: destination.token.address, fromAmountRaw: amount.toString(),
      fromAmount, toAmount: receive, fromAmountUsd: Number(fromAmount) * sourcePrice, toAmountUsd: Number(receive) * destinationPrice,
      gasReserveWei: reserve.toString(), nativeRequiredWei: required.toString(), gasCostUsd: Number(ethers.formatEther(reserve)) * nativePrice,
      bridgeFeeUsd: 0, estimatedDurationSeconds: cowQuote ? 15 : 3,
      bridgeName: isWrap ? 'Native Contract Wrap (1:1)' : isUnwrap ? 'Native Contract Unwrap (1:1)' : 'CoW Protocol Settlement', cowQuote };
  } finally { provider.destroy(); }
}
