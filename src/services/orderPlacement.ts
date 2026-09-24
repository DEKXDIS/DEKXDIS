import { ethers } from 'ethers';
import type { TokenConfig, TradeOrder, WalletState } from '../types/trading';
import { getTradingQuoteToken } from '../types/chains';
import { storageService as store } from './storageService';
import { nativeStore } from './nativeStore';
import { exclusive } from './executionEngine';
import { assertTradingPair, tradingQuoteUsdPrice } from './tradingQuote';
import { web3Service } from './web3Service';
import { cowProtocol } from './cowProtocol';
import { quantityForUsd, quoteForQuantityUsd } from '../utils/amounts';
import { getNextOcoTag, recordAllocatedOcoTag } from '../utils/ocoUtils';
import { positionLots } from '../utils/positions';

/** The same command is used by the manual order form and automation. Prices are USD display prices. */
export interface OrderCommand {
  side: 'buy' | 'sell'; price: number; amount?: string; amountUnit?: 'usd' | 'token';
  positionId?: string; // A sell may identify the confirmed buy whose remaining tokens it closes.
  takeProfitPrice?: number; stopLossPrice?: number;
  sellKind?: 'limit' | 'stop';
}
export interface PlacementContext {
  wallet: WalletState; token: TokenConfig; chainId: number; candleTime?: number;
  requestId?: string; // Automation correlation, stored only on actual orders.
  checkCurrent?: () => void;
  checkBuyAmount?: (amountWei: bigint, quoteDecimals: number, quoteUsdPrice: number) => void;
  sellFromPosition?: boolean;
}
export const isWorkingOrder = (order: TradeOrder) => order.status === 'pending' || order.status === 'open';

/** OCO legs reserve one position, not two. A filled buy awaiting protection also reserves its tokens. */
export function reservedAmount(orders: TradeOrder[], owner: string, chainId: number, asset: string, decimals: number): bigint {
  const groups = new Map<string, bigint>();
  for (const order of orders) {
    if (order.chainId !== chainId || (order.ownerAddress && order.ownerAddress.toLowerCase() !== owner.toLowerCase())) continue;
    let amount = 0n;
    if (isWorkingOrder(order) && order.sellToken.toLowerCase() === asset.toLowerCase()) {
      amount = ethers.parseUnits(order.sellAmount, decimals) - ethers.parseUnits(order.executedSellAmount || '0', decimals);
    } else if (order.status === 'fulfilled' && order.buyToken.toLowerCase() === asset.toLowerCase() &&
      order.bracket && !order.bracket.isCompleted && (order.bracket.tpEnabled || order.bracket.slEnabled) && order.executedBuyAmount) {
      const sold = orders.filter(exit => exit.parentOrderId === order.id && exit.executedSellAmount)
        .reduce((sum, exit) => sum + ethers.parseUnits(exit.executedSellAmount!, decimals), 0n);
      amount = ethers.parseUnits(order.executedBuyAmount, decimals) - sold;
    }
    const key = order.ocoGroupId || order.parentOrderId || order.id;
    if (amount > (groups.get(key) || 0n)) groups.set(key, amount);
  }
  return [...groups.values()].reduce((sum, value) => sum + value, 0n);
}

export async function placeOrder(context: PlacementContext, input: OrderCommand): Promise<TradeOrder[]> {
  const command = { ...input }, token = { ...context.token }, wallet = { ...context.wallet };
  const { chainId } = context;
  let buySpend: { amount: bigint; decimals: number; rate: number } | undefined;
  let exitPosition: { id: string; amount: bigint } | undefined;
  const lots = () => positionLots(store.getAccountingOrders(), { owner: wallet.address, token, chainId });
  const check = () => {
    if (!nativeStore.isHealthy() || nativeStore.getWallet()?.address.toLowerCase() !== wallet.address.toLowerCase() || wallet.needsBackup) {
      throw new Error('Active wallet is unavailable or needs its backup');
    }
    context.checkCurrent?.();
    if (buySpend) context.checkBuyAmount?.(buySpend.amount, buySpend.decimals, buySpend.rate);
    if (exitPosition && (lots().find(lot => lot.order.id === exitPosition!.id)?.available ?? 0n) < exitPosition.amount) {
      throw new Error('This buy’s remaining tokens are already sold or reserved for an exit');
    }
  };
  check();
  assertTradingPair(token.address, chainId);
  if (token.chainId !== chainId || !['buy', 'sell'].includes(command.side)) throw new Error('Invalid order identity');
  if (!Number.isFinite(command.price) || command.price <= 0) throw new Error('Order price must be positive');
  if (command.positionId && command.side !== 'sell') throw new Error('Only a sell can close a bought position');
  for (const value of [command.takeProfitPrice, command.stopLossPrice]) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error('Protection prices must be positive');
  if (command.side === 'buy' && ((command.takeProfitPrice !== undefined && command.takeProfitPrice <= command.price) ||
    (command.stopLossPrice !== undefined && command.stopLossPrice >= command.price))) throw new Error('Take-profit must be above entry and stop-loss below entry');
  if (command.sellKind && !['limit', 'stop'].includes(command.sellKind)) throw new Error('Invalid sell order type');
  return exclusive(async () => {
    check();
    if (context.requestId) {
      const prior = store.getOrders().filter(order => order.automationRequestId === context.requestId && order.ownerAddress?.toLowerCase() === wallet.address.toLowerCase());
      if (prior.length) return prior;
    }
    if (command.side === 'sell' && (context.sellFromPosition || command.positionId)) {
      const lot = command.positionId ? lots().find(lot => lot.order.id === command.positionId) : lots().find(lot => lot.available > 0n);
      if (!lot || lot.available <= 0n) throw new Error('No unsold buy is available; its tokens may already be reserved for TP, SL or another sell');
      exitPosition = { id: lot.order.id, amount: lot.available };
      command.amount = ethers.formatUnits(lot.available, token.decimals);
      command.amountUnit = 'token';
    }
    const amount = command.amount, amountUnit = command.amountUnit;
    if (typeof amount !== 'string' || !/^\d+(\.\d+)?$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new Error('Order amount must be positive');
    if (amountUnit !== 'usd' && amountUnit !== 'token') throw new Error('Invalid order amount unit');
    const quote = getTradingQuoteToken(chainId);
    const rate = await tradingQuoteUsdPrice(chainId);
    check();
    const quantity = amountUnit === 'token' ? amount : quantityForUsd(amount, command.price, token.decimals);
    const tokenWei = ethers.parseUnits(quantity, token.decimals);
    const quoteQuantity = amountUnit === 'usd' && command.side === 'buy'
      ? quantityForUsd(amount, rate, quote.decimals)
      : quoteForQuantityUsd(quantity, command.price, rate, token.decimals, quote.decimals);
    const quoteWei = ethers.parseUnits(quoteQuantity, quote.decimals);
    if (tokenWei <= 0n || quoteWei <= 0n) throw new Error('Order amount is below token precision');
    const buying = command.side === 'buy', asset = buying ? quote : token;
    const spend = buying ? quoteWei : tokenWei;
    if (buying) buySpend = { amount: spend, decimals: quote.decimals, rate };
    check();
    const balance = await web3Service.getTokenBalanceWei(wallet.address, asset.address, chainId);
    check();
    if (spend + reservedAmount(store.getOrders(), wallet.address, chainId, asset.address, asset.decimals) > balance) throw new Error(`Insufficient unreserved ${asset.symbol} balance`);
    await web3Service.ensureAllowance(wallet.address, asset.address, spend, chainId);
    check();
    const tag = getNextOcoTag(store.getOrders());
    const base: TradeOrder = {
      id: '', ownerAddress: wallet.address, chainId, timestamp: Date.now(), candleTime: context.candleTime,
      automationRequestId: context.requestId, tradeSide: command.side, quoteTokenAddress: quote.address, quoteUsdPrice: rate,
      parentOrderId: exitPosition?.id,
      type: 'TOKEN_SWAP', orderCategory: buying ? 'limit' : 'limit_sell', ocoGroupId: tag,
      limitPrice: command.price, executionPrice: command.price,
      sellToken: asset.address, buyToken: buying ? token.address : quote.address,
      sellSymbol: asset.symbol, buySymbol: buying ? token.symbol : quote.symbol,
      sellDecimals: asset.decimals, buyDecimals: buying ? token.decimals : quote.decimals,
      sellAmount: buying ? quoteQuantity : quantity, buyAmount: buying ? quantity : quoteQuantity,
      status: 'pending', feeAmount: '0', validTo: Math.floor(Date.now() / 1000) + 30 * 86400, explorerUrl: '',
    };
    if (buying && (command.takeProfitPrice !== undefined || command.stopLossPrice !== undefined)) base.bracket = {
      tpEnabled: command.takeProfitPrice !== undefined, tpPrice: command.takeProfitPrice || 0, tpPercent: 0,
      slEnabled: command.stopLossPrice !== undefined, slPrice: command.stopLossPrice || 0, slPercent: 0,
      ocoGroupId: tag, isTriggered: false, isCompleted: false,
    };
    const orders: TradeOrder[] = [];
    let submitted = base;
    if (!buying) {
      const stopPrice = command.sellKind === 'stop' ? command.price : command.stopLossPrice;
      const limit = command.sellKind === 'stop' ? command.takeProfitPrice : command.price;
      if (stopPrice !== undefined && limit !== undefined && stopPrice >= limit) throw new Error('Connected stop-loss must be below take-profit');
      if (stopPrice !== undefined) orders.push({ ...base, id: `sl_${crypto.randomUUID()}`, status: 'open',
        orderCategory: 'stop_loss', isConditional: true, triggerPrice: stopPrice, limitPrice: stopPrice,
        buyAmount: quoteForQuantityUsd(quantity, stopPrice, rate, token.decimals, quote.decimals) });
      if (limit === undefined) {
        check(); store.addOrders(orders); recordAllocatedOcoTag(tag); await store.flush(); return orders;
      }
      submitted = { ...base, limitPrice: limit, orderCategory: stopPrice !== undefined ? 'take_profit' : 'limit_sell',
        buyAmount: quoteForQuantityUsd(quantity, limit, rate, token.decimals, quote.decimals), connectedOrderId: orders[0]?.id };
    }
    const signer = web3Service.getSigner(wallet.address, chainId);
    await cowProtocol.submitLimitOrder({ sellToken: submitted.sellToken, buyToken: submitted.buyToken,
      sellAmountWei: ethers.parseUnits(submitted.sellAmount, submitted.sellDecimals).toString(),
      buyAmountWei: ethers.parseUnits(submitted.buyAmount, submitted.buyDecimals).toString(), signer, chainId, validTo: submitted.validTo,
      onPrepared: async uid => {
        check(); submitted.id = uid; submitted.explorerUrl = cowProtocol.getExplorerUrl(uid);
        if (orders[0]) orders[0].connectedOrderId = uid;
        orders.push(submitted); store.addOrders(orders); recordAllocatedOcoTag(tag); await store.flush();
      } });
    return orders;
  });
}
