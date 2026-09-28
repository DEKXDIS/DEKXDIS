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

async function assetUsdPrice(asset: Asset): Promise<number> {
  const chain = getChainConfig(asset.chainId);
  const address = asset.token.address.toLowerCase();
  if (address === chain.usdtToken.address.toLowerCase()) return 1;
  if (address === chain.nativeToken.wrappedAddress.toLowerCase()) return marketDataService.fetchNativeTokenPrice(asset.chainId);
  return (await marketDataService.fetchTokenPrice(asset.token.address, asset.chainId, asset.token.binanceSymbol)).price;
}

export function nativeSwapMessage(source: Asset, destination: Asset): string | undefined {
  if (source.chainId !== destination.chainId) return;
  const chain = getChainConfig(source.chainId);
  if (source.category === 'native' && destination.category !== 'wrapped') {
    return `Wrap ${chain.nativeToken.symbol} to ${chain.nativeToken.wrappedSymbol} before swapping it to ${destination.token.symbol}.`;
  }
  if (destination.category === 'native' && source.category !== 'wrapped') {
    return `Select ${chain.nativeToken.wrappedSymbol} as the output, then unwrap it to ${chain.nativeToken.symbol} after the swap fills. ${source.token.symbol} does not need wrapping.`;
  }
}

export async function assetTransferQuote(owner: string, source: Asset, destination: Asset, usd: string, max: boolean): Promise<AssetTransferQuote> {
  const chain = getChainConfig(source.chainId);
  // Retry only chain reads, never the entire quote or a transaction.
  const read = <T>(operation: (provider: ethers.JsonRpcProvider) => Promise<T>) =>
    web3Service.executeWithRpcFallback(source.chainId, async provider => {
      if (Number((await provider.getNetwork()).chainId) !== source.chainId) throw new Error('RPC chain mismatch');
      return operation(provider);
    });
  let stage = 'Checking swap route';
  try {
    if (source.chainId !== destination.chainId) {
      return await crossChainBridgeService.fetchBridgeQuote(source.chainId, destination.chainId, max ? 1 : Number(usd), owner,
        source.token, destination.token, { max, sourceCategory: source.category, destinationCategory: destination.category });
    }
    const isWrap = source.category === 'native' && destination.category === 'wrapped';
    const isUnwrap = source.category === 'wrapped' && destination.category === 'native';
    const routeError = nativeSwapMessage(source, destination);
    if (routeError) throw new Error(routeError);
    if (!isWrap && !isUnwrap && source.token.address.toLowerCase() === destination.token.address.toLowerCase()) throw new Error('Cannot swap a token for itself');
    stage = `Reading ${source.token.symbol} decimals on ${chain.name}`;
    if (source.category !== 'native') {
      const decimals = await read(async provider => Number(await new ethers.Contract(source.token.address, ['function decimals() view returns (uint8)'], provider).decimals()));
      if (decimals !== source.token.decimals) throw new Error('Source token decimals do not match its contract');
    }
    stage = `Reading ${chain.nativeToken.symbol} gas balance`;
    const nativeBalance = await read(provider => provider.getBalance(owner, 'pending'));
    stage = `Fetching ${source.token.symbol} USD price`;
    const sourcePrice = await assetUsdPrice(source);
    if (!Number.isFinite(sourcePrice) || sourcePrice <= 0) throw new Error('Source USD price unavailable');
    stage = `Calculating ${source.token.symbol} amount`;
    let amount = max ? (isWrap ? nativeBalance : await web3Service.getTokenBalanceWei(owner, source.token.address, source.chainId))
      : ethers.parseUnits(quantityForUsd(usd, sourcePrice, source.token.decimals), source.token.decimals);
    if (amount <= 0n) throw new Error('No spendable source token balance');
    let reserve: bigint, cowQuote: CowQuoteResponse | undefined;
    let receive: string, destinationPrice: number;
    if (isWrap || isUnwrap) {
      stage = `Estimating ${isWrap ? 'wrap' : 'unwrap'} gas`;
      const iface = new ethers.Interface(['function deposit() payable', 'function withdraw(uint256)']);
      const request = (value: bigint) => ({ from: owner, to: chain.nativeToken.wrappedAddress,
        data: iface.encodeFunctionData(isWrap ? 'deposit' : 'withdraw', isWrap ? [] : [value]), value: isWrap ? value : 0n });
      const seed = await read(provider => estimateTransferGas(provider, source.chainId, request(isWrap && max ? 1n : amount)));
      if (isWrap && max) amount = spendableNative(nativeBalance, seed.reserveWei);
      const gas = await read(provider => estimateTransferGas(provider, source.chainId, request(amount)));
      reserve = gas.reserveWei;
      if (isWrap && max && amount + reserve > nativeBalance) amount = spendableNative(nativeBalance, reserve);
      receive = ethers.formatUnits(amount, source.token.decimals); destinationPrice = sourcePrice;
    } else {
      stage = `Requesting CoW quote for ${source.token.symbol} to ${destination.token.symbol}`;
      cowQuote = await cowProtocol.getQuote({ sellToken: source.token.address, buyToken: destination.token.address,
        amount: ethers.formatUnits(amount, source.token.decimals), kind: 'sell', from: owner,
        sellTokenDecimals: source.token.decimals, buyTokenDecimals: destination.token.decimals, chainId: source.chainId });
      stage = `Checking ${source.token.symbol} approval gas`;
      reserve = await read(provider => approvalGasReserve(provider, source.chainId, owner, source.token.address, chain.cowVaultRelayer, amount));
      receive = ethers.formatUnits(cowQuote.quote.buyAmount, destination.token.decimals);
      stage = `Fetching ${destination.token.symbol} USD price`;
      destinationPrice = await assetUsdPrice(destination);
      if (!Number.isFinite(destinationPrice) || destinationPrice <= 0) throw new Error('Destination USD price unavailable');
    }
    const required = reserve + (isWrap ? amount : 0n);
    stage = 'Checking transfer gas reserve';
    if (nativeBalance < required) throw new Error(`Insufficient native ${chain.nativeToken.symbol} for the transfer gas reserve`);
    stage = `Fetching ${chain.nativeToken.symbol} gas price in USD`;
    const nativePrice = reserve === 0n ? 0 : isWrap || isUnwrap ? sourcePrice
      : source.token.address.toLowerCase() === chain.nativeToken.wrappedAddress.toLowerCase() ? sourcePrice
      : destination.token.address.toLowerCase() === chain.nativeToken.wrappedAddress.toLowerCase() ? destinationPrice
      : await marketDataService.fetchNativeTokenPrice(source.chainId);
    const fromAmount = ethers.formatUnits(amount, source.token.decimals);
    return { owner, quotedAt: Date.now(), fromChainId: source.chainId, toChainId: destination.chainId,
      fromTokenAddress: source.token.address, toTokenAddress: destination.token.address, fromAmountRaw: amount.toString(),
      fromAmount, toAmount: receive, fromAmountUsd: Number(fromAmount) * sourcePrice, toAmountUsd: Number(receive) * destinationPrice,
      gasReserveWei: reserve.toString(), nativeRequiredWei: required.toString(), gasCostUsd: Number(ethers.formatEther(reserve)) * nativePrice,
      bridgeFeeUsd: 0, estimatedDurationSeconds: cowQuote ? 15 : 3,
      bridgeName: isWrap ? 'Native Contract Wrap (1:1)' : isUnwrap ? 'Native Contract Unwrap (1:1)' : 'CoW Protocol Settlement', cowQuote };
  } catch (error) {
    throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
