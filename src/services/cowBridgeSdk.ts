import { ethers } from 'ethers';
import { AcrossBridgeProvider, NearIntentsBridgeProvider, BridgingSdk, isBridgeQuoteAndPost,
  isHookBridgeProvider, type BridgeQuoteAndPost, type BridgeProvider, type BridgeQuoteResult } from '@cowprotocol/sdk-bridging';
import { EthersV6Adapter } from '@cowprotocol/sdk-ethers-v6-adapter';
import { setGlobalAdapter } from '@cowprotocol/sdk-common';
import { OrderBookApi, OrderKind, type OrderQuoteRequest } from '@cowprotocol/sdk-order-book';
import { TradingSdk, getEthFlowTransaction, mergeAppDataDoc, swapParamsToLimitOrderParams } from '@cowprotocol/sdk-trading';
import { ETH_ADDRESS, type SupportedChainId, type TargetChainId } from '@cowprotocol/sdk-config';
import { web3Service } from './web3Service';
import { cowProtocol } from './cowProtocol';
import { cowFetch } from './cowRequests';
import { getChainConfig } from '../types/chains';
import { bridgeFetch, BridgeRequestError, installBridgeRequestTimeouts } from './bridgeRequests';

export { ETH_ADDRESS };
export type CowBridgeQuote = BridgeQuoteAndPost;
class DekxdisNearProvider extends NearIntentsBridgeProvider {
  constructor(adapter: EthersV6Adapter) {
    super({}, adapter);
    const json = async (path: string, body?: unknown) => (await bridgeFetch(`https://1click.chaindefuser.com/v0/${path}`,
      body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    // Replace the provider's unbounded axios transport; keep CoW's quote construction,
    // attestation verification, deposit address, and status interpretation unchanged.
    let tokens: ReturnType<typeof this.api.getTokens> | undefined;
    this.api.getTokens = () => tokens ??= json('tokens').then(result => {
      if (!Array.isArray(result)) throw new Error('Invalid NEAR Intents token response');
      return result.filter(token => ['eth', 'arb', 'base', 'bsc', 'gnosis'].includes(token.blockchain));
    });
    this.api.getQuote = request => json('quote', request);
    this.api.getStatus = deposit => json(`status?depositAddress=${encodeURIComponent(deposit)}`);
  }
}
// SDK components consult a global provider adapter during asynchronous work. Serialize complete
// operations (including every provider quote) before changing it to another account/network.
let sdkTail: Promise<unknown> = Promise.resolve();
export function withCowBridgeSdk<T>(chainId: number, owner: string, operation: (context: CowBridgeContext) => Promise<T>): Promise<T> {
  const run = async () => {
    installBridgeRequestTimeouts();
    const provider = web3Service.getProvider(chainId);
    const adapter = new EthersV6Adapter({ provider });
    setGlobalAdapter(adapter);
    const api = new OrderBookApi({ chainId: chainId as SupportedChainId });
    const request = async (path: string, init?: RequestInit) => {
      try { return await (await bridgeFetch(`${getChainConfig(chainId).cowApiBase}${path}`, init,
        (input, options) => cowFetch(String(input), { ...options, retryLimit: 0 }))).json(); }
      catch (error) {
        if (error instanceof BridgeRequestError && error.httpStatus === 404 && path.startsWith('/orders/')) throw new BridgeRequestError(`CoW order is not indexed yet: ${error.message}`, true);
        throw error;
      }
    };
    api.getQuote = (body: OrderQuoteRequest) => request('/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    api.getOrder = uid => request(`/orders/${uid}`);
    api.getTrades = params => request(`/trades?${new URLSearchParams(params as Record<string, string>)}`);
    api.uploadAppData = async (hash, fullAppData) => {
      await request(`/app_data/${hash}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullAppData }) });
      return { fullAppData };
    };
    // Submission always goes through DEKXDIS's durable boundary, never the SDK's direct POST.
    api.sendOrder = async () => { throw new Error('Cross-chain orders require DEKXDIS durable submission'); };
    // Bungee's endpoint in SDK 4.4.5 returns HTTP 410 (verified 2026-09-11).
    const providers: BridgeProvider<BridgeQuoteResult>[] = [new AcrossBridgeProvider({}, adapter), new DekxdisNearProvider(adapter)];
    const tradingSdk = new TradingSdk({ chainId: chainId as SupportedChainId, appCode: cowProtocol.getAppCode() }, { orderBookApi: api, enableLogging: false }, adapter);
    const sdk = new BridgingSdk({ providers, tradingSdk, orderBookApi: api, enableLogging: false }, adapter);
    try { return await operation({ provider, adapter, api, sdk, providers, owner, chainId }); }
    finally { provider.destroy(); }
  };
  const result = sdkTail.then(run, run);
  sdkTail = result.catch(() => undefined);
  return result;
}
export interface CowBridgeContext {
  provider: ethers.JsonRpcProvider; adapter: EthersV6Adapter; api: OrderBookApi; sdk: BridgingSdk;
  providers: BridgeProvider<BridgeQuoteResult>[]; owner: string; chainId: number;
}

/** A quote may need a placeholder hook signature; it must never use the native wallet key. */
class QuoteSigner extends ethers.VoidSigner {
  private readonly disposableKey = ethers.Wallet.createRandom();
  signTypedData(domain: ethers.TypedDataDomain, types: Record<string, ethers.TypedDataField[]>, value: Record<string, unknown>) {
    return this.disposableKey.signTypedData(domain, types, value);
  }
}

export const cowBridgeSdk = {
  async quote(context: CowBridgeContext, destinationChain: number, sellToken: string, buyToken: string, sellDecimals: number, buyDecimals: number, amount: bigint): Promise<CowBridgeQuote> {
    const { owner, adapter, providers, chainId, api } = context;
    const signer = adapter.createSigner(new QuoteSigner(owner, context.provider));
    const request = { kind: OrderKind.SELL, amount, sellTokenChainId: chainId as SupportedChainId,
      buyTokenChainId: destinationChain as TargetChainId, sellTokenAddress: sellToken, buyTokenAddress: buyToken,
      sellTokenDecimals: sellDecimals, buyTokenDecimals: buyDecimals, account: owner as `0x${string}`, owner: owner as `0x${string}`, receiver: owner, bridgeRecipient: owner,
      signer, appCode: cowProtocol.getAppCode(), swapSlippageBps: 50, bridgeSlippageBps: 50, validFor: 1200,
      partiallyFillable: false, partnerFee: { recipient: cowProtocol.getPartnerFeeRecipient(), volumeBps: cowProtocol.getPartnerFeeBps() } };
    // Await all actual calls, not the SDK's timeout race which can leave calls using a later adapter.
    const results = await Promise.allSettled(providers.map(async bridgeProvider => {
      const tradingSdk = new TradingSdk({ chainId: chainId as SupportedChainId, appCode: cowProtocol.getAppCode() }, { orderBookApi: api, enableLogging: false });
      const sdk = new BridgingSdk({ providers: [bridgeProvider], tradingSdk, enableLogging: false });
      // Keep the existing 0.5% total tolerance. Across fixes its bridge output (0 bps);
      // a variable-output provider shares the budget between swap and bridge.
      const variableOutput = bridgeProvider.type === 'ReceiverAccountBridgeProvider';
      const result = await sdk.getQuote({ ...request, swapSlippageBps: variableOutput ? 25 : 50, bridgeSlippageBps: variableOutput ? 25 : 0 },
        { quoteSigner: signer, allowIntermediateEqSellToken: false });
      if (!isBridgeQuoteAndPost(result)) throw new Error('CoW did not return a cross-chain quote');
      return result;
    }));
    const quotes: CowBridgeQuote[] = [];
    const failures: string[] = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') quotes.push(result.value);
      else failures.push(`${providers[i].info.name}: ${String(result.reason)}${result.reason?.body ? ` ${JSON.stringify(result.reason.body)}` : ''}`);
    });
    if (!quotes.length) throw new Error(`CoW cross-chain route unavailable. ${failures.join('; ')}`);
    if (failures.length) console.info('CoW bridge quote discovery:', failures.join('; '));
    return quotes.reduce((best, next) => next.bridge.amountsAndCosts.afterSlippage.buyAmount > best.bridge.amountsAndCosts.afterSlippage.buyAmount ? next : best);
  },
  async finalize(context: CowBridgeContext, quoted: CowBridgeQuote, signer: ethers.Signer) {
    const provider = context.providers.find(candidate => candidate.info.dappId === quoted.bridge.providerInfo.dappId);
    if (!provider) throw new Error('Unknown CoW bridge provider');
    let appData = quoted.swap.appDataInfo;
    let receiver = quoted.bridge.bridgeReceiverOverride;
    if (isHookBridgeProvider(provider)) {
      const call = quoted.bridge.bridgeCallDetails;
      if (!call) throw new Error('CoW bridge quote is missing its unsigned hook');
      const deadline = BigInt(quoted.swap.orderToSign.validTo);
      const nonce = ethers.solidityPackedKeccak256(['bytes', 'uint256'], [call.unsignedBridgeCall.data, deadline]);
      const hook = await provider.getSignedHook(context.chainId as SupportedChainId, call.unsignedBridgeCall, nonce, deadline,
        Number(call.preAuthorizedBridgingHook.postHook.gasLimit), context.adapter.createSigner(signer));
      receiver = hook.recipient;
      const previous = appData.doc.metadata.hooks;
      appData = await mergeAppDataDoc(appData.doc, { metadata: { hooks: {
        pre: previous?.pre,
        post: [...(previous?.post || []).filter(item => !item.dappId?.startsWith('cow-sdk://bridging/providers')), hook.postHook],
      } } });
    }
    if (!receiver || !ethers.isAddress(receiver)) throw new Error('CoW bridge receiver is invalid');
    const order = { ...quoted.swap.orderToSign, receiver, appData: appData.appDataKeccak256 };
    return { appData, order };
  },
  async nativeTransaction(context: CowBridgeContext, quoted: CowBridgeQuote, appDataHash: string, receiver: string, signer: ethers.Signer) {
    const params = { ...swapParamsToLimitOrderParams(quoted.swap.tradeParameters, quoted.swap.quoteResponse),
      sellToken: ETH_ADDRESS, receiver, validTo: quoted.swap.orderToSign.validTo, slippageBps: quoted.swap.tradeParameters.slippageBps };
    return getEthFlowTransaction(appDataHash, params, context.chainId as SupportedChainId, {
      networkCostsAmount: quoted.swap.quoteResponse.quote.feeAmount,
      protocolFeeBps: quoted.swap.quoteResponse.protocolFeeBps ? Number(quoted.swap.quoteResponse.protocolFeeBps) : undefined,
      checkEthFlowOrderExists: async (_uid, digest) => {
        const { ETH_FLOW_ADDRESSES } = await import('@cowprotocol/sdk-config');
        const contract = new ethers.Contract(ETH_FLOW_ADDRESSES[context.chainId as SupportedChainId], ['function orders(bytes32) view returns(address owner,uint32 validTo)'], context.provider);
        if ((await contract.orders(digest)).owner !== ethers.ZeroAddress) throw new Error('This native CoW order already exists; refusing a replacement');
        return false;
      },
    }, context.adapter.createSigner(signer));
  },
};
