import { cowFetch, sharedQuote, OrderStatusQueryError } from './cowRequests';
import { web3Service } from './web3Service';
import { storageService } from './storageService';
import { ethers } from 'ethers';
import { CowQuoteRequest, CowQuoteResponse, TradeOrder } from '../types/trading';
import { getChainConfig, DEFAULT_CHAIN_ID } from '../types/chains';
import { systemLogService } from './systemLogService';
import { orderJournal, Submission } from './orderJournal';
import { nativeStore } from './nativeStore';

const EIP712_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
};

export const DEKXDIS_APP_CODE = 'DEKXDIS';
export const DEKXDIS_PARTNER_SURPLUS_BPS = 2500; // 25% of surplus, never a flat volume charge
export const DEKXDIS_PARTNER_MAX_VOLUME_BPS = 100; // Cap the partner fee at 1% of volume
export const DEKXDIS_PARTNER_FEE_RECIPIENT = '0xfC3f2f30F3b31A828F0DE3565094C74a884e71c0';
export const DEKXDIS_PARTNER_FEE = { recipient: DEKXDIS_PARTNER_FEE_RECIPIENT,
  surplusBps: DEKXDIS_PARTNER_SURPLUS_BPS, maxVolumeBps: DEKXDIS_PARTNER_MAX_VOLUME_BPS };

// Quotes, signed orders and registration share the same fee data and hash.
export const DEKXDIS_APP_DATA_CONTENT = JSON.stringify({
  appCode: DEKXDIS_APP_CODE,
  metadata: { partnerFee: DEKXDIS_PARTNER_FEE },
  version: '1.15.0',
});
export const DEKXDIS_APP_DATA_HEX = ethers.keccak256(ethers.toUtf8Bytes(DEKXDIS_APP_DATA_CONTENT));

const registeredAppDataChains = new Set<number>();

export const cowProtocol = {
  async postSubmission(record: Submission): Promise<string> {
    const response = await cowFetch(`${getChainConfig(record.chainId).cowApiBase}/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record.payload), timeoutMs: 20000,
    });
    if (!response.ok) {
      const message = await response.text();
      // An exact replay is safe. A duplicate response acknowledges this same UID.
      if (/DuplicatedOrder/i.test(message)) { await orderJournal.remove(record.uid); return record.uid; }
      const rejected = response.status >= 400 && response.status < 500 && response.status !== 429;
      await orderJournal.put({ ...record, error: message, rejected });
      throw new Error(`CoW submission ${rejected ? 'rejected' : 'unconfirmed'} (${response.status}): ${message}`);
    }
    const uid = await response.json();
    if (String(uid).toLowerCase() !== record.uid.toLowerCase()) throw new Error('CoW returned an unexpected order UID');
    await orderJournal.remove(record.uid);
    return uid;
  },
  async persistAndPost(payload: Record<string, any>, chainId: number, signerAddress: string, onPrepared?: (uid: string) => Promise<void>, purpose?: 'bridge') {
    // A cross-chain transfer can hand the same source-chain asset to a bridge hook.
    // The selected destination asset is on another chain; ordinary same-token swaps remain invalid.
    const bridgeDestination = purpose === 'bridge' && onPrepared ? Number(JSON.parse(payload.appData).metadata?.bridging?.destinationChainId) : chainId;
    const crossChain = purpose === 'bridge' && Number.isSafeInteger(bridgeDestination) && bridgeDestination > 0 && bridgeDestination !== chainId;
    if (purpose === 'bridge' && !crossChain) throw new Error('Cross-chain order is missing its destination metadata');
    if (!crossChain && String(payload.sellToken).toLowerCase() === String(payload.buyToken).toLowerCase()) throw new Error('Cannot trade a token for itself');
    const checkOwner = () => { if (nativeStore.getWallet()?.address.toLowerCase() !== signerAddress.toLowerCase()) throw new Error('Wallet changed before order submission'); };
    checkOwner();
    const signed = { ...payload, appData: payload.appDataHash };
    const uid = ethers.solidityPacked(['bytes32', 'address', 'uint32'], [ethers.TypedDataEncoder.hash(this.getEip712Domain(chainId), EIP712_TYPES, signed), signerAddress, payload.validTo]);
    const record = { uid, chainId, payload, ...(purpose ? { purpose } : {}) };
    // Persist local identity/intent before any network submission. Callbacks must be durable.
    if (onPrepared) await onPrepared(uid);
    else {
      const sell = await web3Service.getTokenMetadata(payload.sellToken, chainId);
      const buy = await web3Service.getTokenMetadata(payload.buyToken, chainId);
      if (!sell || !buy) throw new Error('Cannot persist order without token metadata');
      checkOwner();
      storageService.addOrder({ id: uid, ownerAddress: signerAddress, chainId, timestamp: Date.now(), type: 'TOKEN_SWAP', orderCategory: 'market',
        sellToken: sell.address, buyToken: buy.address, sellSymbol: sell.symbol, buySymbol: buy.symbol, sellDecimals: sell.decimals, buyDecimals: buy.decimals,
        sellAmount: ethers.formatUnits(payload.sellAmount, sell.decimals), buyAmount: ethers.formatUnits(payload.buyAmount, buy.decimals), executionPrice: 0,
        status: 'pending', validTo: payload.validTo, feeAmount: '0', explorerUrl: this.getExplorerUrl(uid) });
      await storageService.flush();
    }
    checkOwner();
    await orderJournal.put(record);
    checkOwner();
    const accepted = await this.postSubmission(record);
    checkOwner();
    return accepted;
  },
  getEip712Domain(chainId: number = DEFAULT_CHAIN_ID) {
    const chainConfig = getChainConfig(chainId);
    return {
      name: 'Gnosis Protocol',
      version: 'v2',
      chainId,
      verifyingContract: chainConfig.cowSettlement,
    };
  },

  async ensureAppDataRegistered(chainId: number = DEFAULT_CHAIN_ID): Promise<void> {
    if (registeredAppDataChains.has(chainId)) return;
    try {
      const chainConfig = getChainConfig(chainId);
      const res = await cowFetch(`${chainConfig.cowApiBase}/app_data/${DEKXDIS_APP_DATA_HEX}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullAppData: DEKXDIS_APP_DATA_CONTENT }),
        timeoutMs: 12000,
      });
      if (res.ok || res.status === 200 || res.status === 201 || res.status === 409) {
        registeredAppDataChains.add(chainId);
      } else {
        const errBody = await res.text();
        systemLogService.logWarning(
          'ORDER',
          `CoW AppData Registration Note on ${chainConfig.name}`,
          `HTTP ${res.status}: ${errBody.slice(0, 120)}`,
          chainId
        );
      }
    } catch (e: any) {
      systemLogService.logWarning(
        'ORDER',
        `CoW AppData Registration Note on Chain ${chainId}`,
        e?.message || String(e),
        chainId
      );
    }
  },

  async getQuote(req: {
    sellToken: string;
    buyToken: string;
    amount: string; // human readable string
    kind: 'sell' | 'buy';
    from: string;
    sellTokenDecimals?: number;
    buyTokenDecimals?: number;
    chainId?: number;
    fresh?: boolean;
  }): Promise<CowQuoteResponse> {
    if (req.sellToken.toLowerCase() === req.buyToken.toLowerCase()) throw new Error('Cannot trade a token for itself');
    const chainId = req.chainId || DEFAULT_CHAIN_ID;
    const chainConfig = getChainConfig(chainId);
    const isSell = req.kind === 'sell';
    const decimals = isSell ? (req.sellTokenDecimals ?? 18) : (req.buyTokenDecimals ?? 18);
    const amountWei = ethers.parseUnits(req.amount, decimals).toString();

    await this.ensureAppDataRegistered(chainId);

    const payload: CowQuoteRequest = {
      sellToken: req.sellToken.toLowerCase(),
      buyToken: req.buyToken.toLowerCase(),
      kind: req.kind,
      from: req.from.toLowerCase(),
      partiallyFillable: false,
      appData: DEKXDIS_APP_DATA_CONTENT,
      appDataHash: DEKXDIS_APP_DATA_HEX,
    };

    if (isSell) {
      payload.sellAmountBeforeFee = amountWei;
    } else {
      payload.buyAmountAfterFee = amountWei;
    }

    const fetchQuote = async (): Promise<CowQuoteResponse> => {
    let response: Response;
    try {
      response = await cowFetch(`${chainConfig.cowApiBase}/quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        timeoutMs: 20000,
      });
    } catch (fetchErr: any) {
      const msg = `CoW Quote network request failed on ${chainConfig.name}: ${fetchErr?.message || fetchErr}`;
      systemLogService.logError('ORDER', `CoW Quote Network Error (${chainConfig.name})`, msg, chainId);
      throw new Error(msg);
    }

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson: any;
      try {
        errorJson = JSON.parse(errorText);
      } catch {
        errorJson = { description: errorText };
      }
      const desc = errorJson.description || errorJson.errorType || errorText || response.statusText;
      const fullError = `Failed to get quote on ${chainConfig.name} (HTTP ${response.status}): ${desc}`;
      systemLogService.logError('ORDER', `CoW Quote Rejected (${chainConfig.name})`, desc, chainId);
      throw new Error(fullError);
    }

    const data: CowQuoteResponse = await response.json();
    return data;
    };
    // Stops must price the position now, not reuse a swap-preview quote.
    return req.fresh ? fetchQuote() : sharedQuote<CowQuoteResponse>(`${chainId}:${JSON.stringify(payload)}`, fetchQuote);
  },

  async signAndSubmitOrder(
    quoteData: CowQuoteResponse,
    signer: ethers.Signer & { address: string },
    slippageTolerancePercent: number = 0.5,
    chainId: number = DEFAULT_CHAIN_ID,
    onPrepared?: (uid: string) => Promise<void>
  ): Promise<string> {
    if (!Number.isFinite(slippageTolerancePercent) || slippageTolerancePercent < 0 || slippageTolerancePercent >= 100) throw new Error('Invalid slippage');
    const { quote } = quoteData;
    if (quote.sellToken.toLowerCase() === quote.buyToken.toLowerCase()) throw new Error('Cannot trade a token for itself');
    const chainConfig = getChainConfig(chainId);

    await this.ensureAppDataRegistered(chainId);

    // Apply slippage tolerance to buyAmount (for sell orders) or sellAmount (for buy orders)
    let adjustedBuyAmount = BigInt(quote.buyAmount);
    let adjustedSellAmount = BigInt(quote.sellAmount);

    const slippageBps = BigInt(Math.floor(slippageTolerancePercent * 100)); // e.g. 0.5% = 50 bps
    const bpsBase = 10000n;

    if (quote.kind === 'sell') {
      adjustedBuyAmount = (adjustedBuyAmount * (bpsBase - slippageBps)) / bpsBase;
    } else {
      adjustedSellAmount = (adjustedSellAmount * (bpsBase + slippageBps)) / bpsBase;
    }

    const receiverAddress = quote.receiver && quote.receiver !== ethers.ZeroAddress 
      ? quote.receiver.toLowerCase() 
      : signer.address.toLowerCase();

    const orderToSign = {
      sellToken: quote.sellToken.toLowerCase(),
      buyToken: quote.buyToken.toLowerCase(),
      receiver: receiverAddress,
      sellAmount: adjustedSellAmount.toString(),
      buyAmount: adjustedBuyAmount.toString(),
      validTo: quote.validTo,
      appData: quote.appDataHash || DEKXDIS_APP_DATA_HEX,
      feeAmount: '0', // MANDATORY PROTOCOL INVARIANT: feeAmount must explicitly be '0'
      kind: quote.kind,
      partiallyFillable: false,
      sellTokenBalance: quote.sellTokenBalance || 'erc20',
      buyTokenBalance: quote.buyTokenBalance || 'erc20',
    };

    const domain = this.getEip712Domain(chainId);

    // Sign the EIP-712 structured typed data
    const signature = await signer.signTypedData(
      domain,
      EIP712_TYPES,
      orderToSign
    );

    const orderPayload = {
      ...orderToSign,
      appData: DEKXDIS_APP_DATA_CONTENT,
      appDataHash: DEKXDIS_APP_DATA_HEX,
      signingScheme: 'eip712',
      signature,
      from: signer.address.toLowerCase(),
      quoteId: quoteData.id,
    };

    return this.persistAndPost(orderPayload, chainId, signer.address, onPrepared);
  },

  // Helper to extract a canonical 56-byte hex order UID from any prefixed internal ID
  normalizeOrderUid(rawUid: string): string | null {
    if (!rawUid) return null;
    let uid = rawUid.trim();
    if (uid.startsWith('ladder_')) {
      uid = uid.slice(7);
    }
    // Valid CoW order UID is 56 bytes hex = 112 hex chars without 0x, or 114 chars with 0x
    const hexRegex = /^(0x)?[0-9a-fA-F]{112}$/;
    if (!hexRegex.test(uid)) {
      return null;
    }
    return uid.startsWith('0x') ? uid : `0x${uid}`;
  },

  async getOrderStatus(
    orderUid: string,
    chainId: number = DEFAULT_CHAIN_ID,
    sellDecimals: number = 18,
    buyDecimals: number = 18,
    options: { includeSettlement?: boolean; reportErrors?: boolean } = {}
  ): Promise<{
    status: TradeOrder['status'];
    executedSellAmount?: string;
    executedBuyAmount?: string;
    settlementTimestamp?: number;
    txHash?: string;
  }> {
    const chainConfig = getChainConfig(chainId);
    const cleanUid = this.normalizeOrderUid(orderUid);
    if (!cleanUid) {
      throw new Error('No valid CoW UID exists for this order; remote status cannot be verified');
    }

    let res: Response;
    try {
      res = await cowFetch(`${chainConfig.cowApiBase}/orders/${cleanUid}`, { timeoutMs: 12000 });
    } catch (netErr: any) {
      const msg = `Network error querying status for order ${cleanUid} on ${chainConfig.name}: ${netErr?.message || netErr}`;
      if (options.reportErrors !== false) systemLogService.logWarning('ORDER', `Order Status Poll Network Warning (${chainConfig.name})`, msg, chainId);
      throw new OrderStatusQueryError(msg);
    }

    if (!res.ok) {
      const desc = `CoW API HTTP ${res.status} when querying status for order ${cleanUid} on ${chainConfig.name}`;
      if (options.reportErrors !== false) systemLogService.logWarning('ORDER', `Order Status Query Warning (${chainConfig.name})`, desc, chainId);
      const retryAfter = res.headers.get('Retry-After');
      const retryAfterMs = retryAfter === null ? undefined : /^\d+(\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
      throw new OrderStatusQueryError(desc, res.status, retryAfterMs);
    }
    const data = await res.json();
    
    let status: TradeOrder['status'] = 'pending';
    if (data.status === 'fulfilled') status = 'fulfilled';
    else if (data.status === 'cancelled') status = 'cancelled';
    else if (data.status === 'expired') status = 'expired';
    else if (data.status === 'presignaturePending' || data.status === 'open') status = 'open';

    const settlement = data.status === 'fulfilled' && options.includeSettlement !== false
      ? await this.getOrderSettlement(cleanUid, chainId) : {};
    return {
      status,
      executedSellAmount: data.executedSellAmount ? ethers.formatUnits(data.executedSellAmount, sellDecimals ?? 18) : undefined,
      executedBuyAmount: data.executedBuyAmount ? ethers.formatUnits(data.executedBuyAmount, buyDecimals ?? 18) : undefined,
      ...settlement,
    };
  },

  async getOrderSettlement(orderUid: string, chainId: number = DEFAULT_CHAIN_ID): Promise<{ txHash?: string; settlementTimestamp?: number }> {
    const cleanUid = this.normalizeOrderUid(orderUid);
    if (!cleanUid) throw new Error('No valid CoW UID exists for settlement lookup');
    const chainConfig = getChainConfig(chainId);
    let txHash: string | undefined;
    let settlementTimestamp: number | undefined;
      try {
        const tradesRes = await cowFetch(`${chainConfig.cowApiBase}/trades?orderUid=${cleanUid}`, { timeoutMs: 12000 });
        if (tradesRes.ok) {
          const trades = await tradesRes.json();
          if (Array.isArray(trades) && trades.length > 0 && trades[0].txHash) {
            txHash = trades[0].txHash;
            // Use the final settlement block, never the time the poll observed it.
            const times = await Promise.all(trades.map((trade: { txHash: string }) =>
              web3Service.executeWithRpcFallback(chainId, async provider => {
                const receipt = await provider.getTransactionReceipt(trade.txHash);
                if (!receipt || receipt.status !== 1) throw new Error('Settlement receipt unavailable');
                const block = await provider.getBlock(receipt.blockNumber);
                if (!block) throw new Error('Settlement block unavailable');
                return block.timestamp * 1000;
              })));
            settlementTimestamp = Math.max(...times);
          }
        }
      } catch (err: any) {
        console.warn(`[CoW Protocol] Failed to fetch trade settlement txHash for order ${cleanUid}:`, err);
      }
    return { txHash, settlementTimestamp };
  },

  async submitLimitOrder(params: {
    sellToken: string;
    buyToken: string;
    sellAmountWei: string;
    buyAmountWei: string;
    signer: ethers.Signer & { address: string };
    validTo?: number;
    chainId?: number;
    onPrepared?: (uid: string) => Promise<void>;
  }): Promise<string> {
    if (params.sellToken.toLowerCase() === params.buyToken.toLowerCase()) throw new Error('Cannot trade a token for itself');
    const { sellToken, buyToken, sellAmountWei, buyAmountWei, signer } = params;
    const chainId = params.chainId || DEFAULT_CHAIN_ID;
    const chainConfig = getChainConfig(chainId);
    const validTo = params.validTo || Math.floor(Date.now() / 1000) + 30 * 86400;

    await this.ensureAppDataRegistered(chainId);

    const orderToSign = {
      sellToken: sellToken.toLowerCase(),
      buyToken: buyToken.toLowerCase(),
      receiver: signer.address.toLowerCase(),
      sellAmount: sellAmountWei,
      buyAmount: buyAmountWei,
      validTo,
      appData: DEKXDIS_APP_DATA_HEX,
      feeAmount: '0', // MANDATORY PROTOCOL INVARIANT: feeAmount must explicitly be '0'
      kind: 'sell',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    };

    const domain = this.getEip712Domain(chainId);

    const signature = await signer.signTypedData(
      domain,
      EIP712_TYPES,
      orderToSign
    );

    const orderPayload = {
      ...orderToSign,
      appData: DEKXDIS_APP_DATA_CONTENT,
      appDataHash: DEKXDIS_APP_DATA_HEX,
      signingScheme: 'eip712',
      signature,
      from: signer.address.toLowerCase(),
    };

    return this.persistAndPost(orderPayload, chainId, signer.address, params.onPrepared);
  },

  getPartnerFee() {
    return { ...DEKXDIS_PARTNER_FEE };
  },

  getPartnerFeeRecipient(): string {
    return DEKXDIS_PARTNER_FEE_RECIPIENT;
  },

  getAppCode(): string {
    return DEKXDIS_APP_CODE;
  },

  getAppDataHex(): string {
    return DEKXDIS_APP_DATA_HEX;
  },

  getAppDataContent(): string {
    return DEKXDIS_APP_DATA_CONTENT;
  },

  async cancelOrder(
    orderUid: string,
    signer: ethers.Signer & { address: string },
    chainId: number = DEFAULT_CHAIN_ID
  ): Promise<boolean> {
    const chainConfig = getChainConfig(chainId);
    const cleanUid = this.normalizeOrderUid(orderUid);
    if (!cleanUid) {
      throw new Error('Invalid remote order UID');
    }

    try {
      const cancellationTypes = {
        OrderCancellation: [
          { name: 'orderUid', type: 'bytes' },
        ],
      };

      const cancellationData = {
        orderUid: cleanUid,
      };

      const domain = this.getEip712Domain(chainId);

      const signature = await signer.signTypedData(
        domain,
        cancellationTypes,
        cancellationData
      );

      const response = await cowFetch(`${chainConfig.cowApiBase}/orders/${cleanUid}`, {
        method: 'DELETE',
        timeoutMs: 12000,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          signature,
          signingScheme: 'eip712',
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        let errObj: any;
        try {
          errObj = JSON.parse(errText);
        } catch {
          errObj = { description: errText };
        }
        const desc = errObj.description || errObj.errorType || errText || response.statusText;
        systemLogService.logError(
          'ORDER',
          `Order Cancellation Failed on ${chainConfig.name}`,
          `Order ${cleanUid.slice(0, 12)}... (HTTP ${response.status}): ${desc}`,
          chainId
        );
        throw new Error(`CoW cancellation failed (HTTP ${response.status}): ${desc}`);
      }

      systemLogService.logSuccess(
        'ORDER',
        `Cancellation accepted on ${chainConfig.name}`,
        `Order UID: ${cleanUid.slice(0, 18)}...`,
        cleanUid,
        `https://explorer.cow.fi/orders/${cleanUid}`,
        chainId
      );
      return true;
    } catch (e: any) {
      systemLogService.logError(
        'ORDER',
        `Order Cancellation Exception on ${chainConfig.name}`,
        `Order ${cleanUid.slice(0, 12)}...: ${e?.message || String(e)}`,
        chainId
      );
      throw e;
    }
  },

  getExplorerUrl(orderUid: string): string {
    const cleanUid = this.normalizeOrderUid(orderUid);
    return `https://explorer.cow.fi/orders/${cleanUid || orderUid}`;
  },

  getBscScanTxUrl(txHash: string, chainId: number = DEFAULT_CHAIN_ID): string {
    return getChainConfig(chainId).txUrl(txHash);
  },

  getBscScanAddressUrl(address: string, chainId: number = DEFAULT_CHAIN_ID): string {
    return getChainConfig(chainId).addressUrl(address);
  },
};
