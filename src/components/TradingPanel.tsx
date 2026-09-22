import { useTradingQuotePrice } from '../hooks/useTradingQuotePrice';
import { assertTradingPair, tradingQuoteUsdPrice } from '../services/tradingQuote';
import { storageService } from '../services/storageService';
import { exclusive } from '../services/executionEngine';
import { bufferedMaxUsd, quantityForUsd } from '../utils/amounts';
import React, { useState, useEffect, useCallback } from 'react';
import { 
  Zap, 
  AlertTriangle, 
  Loader2, 
  ShieldCheck
} from 'lucide-react';
import { Balances, AllowanceState, WalletState, CowQuoteResponse, MarketPrice, TokenConfig, TradeOrder } from '../types/trading';
import { getChainConfig, getTradingQuoteToken, DEFAULT_CHAIN_ID } from '../types/chains';
import { cowProtocol } from '../services/cowProtocol';
import { web3Service } from '../services/web3Service';
import { systemLogService } from '../services/systemLogService';
import { ethers } from 'ethers';
import { formatTokenDisplay, formatUsdDisplay } from '../utils/displayFormat';

interface TradingPanelProps {
  embedded?: boolean;
  selectedToken: TokenConfig;
  chainId: number;
  wallet: WalletState | null;
  balances: Balances;
  allowances: AllowanceState;
  marketPrice: MarketPrice;
  slippage: number;
  onUpdateSlippage: (value: number) => void;
  onTradeSubmitted: (orderId: string, orderData: any) => void;
  onRefreshBalances: () => void;
  onRequireWallet: () => void;
}

export const TradingPanel: React.FC<TradingPanelProps> = ({
  embedded = false,
  selectedToken,
  chainId = DEFAULT_CHAIN_ID,
  wallet,
  balances,
  allowances,
  marketPrice,
  slippage,
  onUpdateSlippage,
  onTradeSubmitted,
  onRefreshBalances,
  onRequireWallet,
}) => {
  const chainConfig = getChainConfig(chainId);
  const quoteToken = getTradingQuoteToken(chainId);
  const { price: quotePrice, error: quotePriceError } = useTradingQuotePrice(chainId);
  const quoteBalance = balances.tokenBalances?.[quoteToken.address.toLowerCase()] || balances.wbnb || '0';
  const selfPair = selectedToken.address.toLowerCase() === quoteToken.address.toLowerCase();
  const tokenSymbol = selectedToken.symbol;
  const usdtSymbol = quoteToken.symbol;

  // Input states in USD
  const [tokenUsdAmount, setTokenUsdAmount] = useState<string>('0');
  const [usdtAmount, setUsdtAmount] = useState<string>('0');
  const [lastTokenAmount, setLastTokenAmount] = useState(() => storageService.getManualTradeAmount('sell'));
  const [lastUsdtAmount, setLastUsdtAmount] = useState(() => storageService.getManualTradeAmount('buy'));
  const [slippageInput, setSlippageInput] = useState(String(slippage));
  const validSlippage = slippageInput.trim() !== '' && Number.isFinite(Number(slippageInput)) && Number(slippageInput) >= 0 && Number(slippageInput) < 100;
  useEffect(() => { setSlippageInput(String(slippage)); }, [slippage]);
  const [tokenMaxSelected, setTokenMaxSelected] = useState(false);
  const [usdtMaxSelected, setUsdtMaxSelected] = useState(false);

  // Quote states
  const [tokenQuote, setTokenQuote] = useState<CowQuoteResponse | null>(null);
  const [usdtQuote, setUsdtQuote] = useState<CowQuoteResponse | null>(null);
  const [isQuotingToken, setIsQuotingToken] = useState(false);
  const [isQuotingUsdt, setIsQuotingUsdt] = useState(false);
  const [tokenQuoteError, setTokenQuoteError] = useState<string | null>(null);
  const [usdtQuoteError, setUsdtQuoteError] = useState<string | null>(null);

  // Execution states
  const [isExecutingTokenTrade, setIsExecutingTokenTrade] = useState(false);
  const [isExecutingUsdtTrade, setIsExecutingUsdtTrade] = useState(false);
  const [executionStep, setExecutionStep] = useState<string>('');

  const tradeBusy = React.useRef(false);
  const tokenRequest = React.useRef(0);
  const usdtRequest = React.useRef(0);
  const livePrice = Number.isFinite(marketPrice.price) && Date.now() - marketPrice.lastUpdated < 30000 ? marketPrice.price : 0;

  const formatButtonUsd = (val: string): string => {
    return formatUsdDisplay(val || 0);
  };

  // Ref for livePrice so computeTokenFromUsd uses latest price without causing quote refetch loops
  const livePriceRef = React.useRef(livePrice);
  React.useEffect(() => {
    livePriceRef.current = livePrice;
  }, [livePrice]);

  // Convert USD entered into token amount
  const computeTokenFromUsd = useCallback((usd: string): string => {
    try { return quantityForUsd(usd, livePriceRef.current, selectedToken.decimals); } catch { return '0'; }
  }, [selectedToken.decimals]);

  // Available balances in USD
  const canAutoWrap = storageService.getAutoWrap() && selectedToken.address.toLowerCase() === chainConfig.nativeToken.wrappedAddress.toLowerCase();
  const tokenRawBal = (canAutoWrap ? parseFloat(balances.bnb || '0') : 0) + parseFloat(balances.tokenBalances?.[selectedToken.address.toLowerCase()] || balances.tokenBalances?.[tokenSymbol] || '0');
  const tokenUsdBal = (tokenRawBal * livePrice).toFixed(2);
  const usdtBal = (Number(quoteBalance) * quotePrice).toFixed(2);
  const tokenBalanceParts = [
    balances.tokenBalances?.[selectedToken.address.toLowerCase()] || balances.tokenBalances?.[tokenSymbol] || '0',
    ...(canAutoWrap ? [balances.bnb || '0'] : []),
  ];
  const maxTokenUsd = () => bufferedMaxUsd(tokenBalanceParts, livePriceRef.current, selectedToken.decimals);
  const maxUsdtUsd = () => bufferedMaxUsd([quoteBalance], quotePrice, quoteToken.decimals);

  useEffect(() => {
    setTokenMaxSelected(false);
    setUsdtMaxSelected(false);
  }, [selectedToken.address, chainId]);

  // Fetch Token -> wrapped native Quote
  const fetchTokenQuote = useCallback(async () => {
    const request = ++tokenRequest.current;
    const rawToken = computeTokenFromUsd(tokenUsdAmount);
    if (parseFloat(rawToken) <= 0) {
      setTokenQuote(null);
      setTokenQuoteError(null);
      return;
    }

    setIsQuotingToken(true);
    setTokenQuoteError(null);

    try {
      assertTradingPair(selectedToken.address, chainId);
      const fromAddr = wallet?.address || ethers.ZeroAddress;
      const quote = await cowProtocol.getQuote({
        sellToken: selectedToken.address,
        buyToken: quoteToken.address,
        amount: rawToken,
        kind: 'sell',
        from: fromAddr,
        sellTokenDecimals: selectedToken.decimals,
        buyTokenDecimals: quoteToken.decimals,
        chainId,
      });
      if (request !== tokenRequest.current) return;
      setTokenQuote(quote);
    } catch (err: any) {
      if (request !== tokenRequest.current) return;
      console.warn(`Quote error (${tokenSymbol}->${quoteToken.symbol}):`, err.message);
      setTokenQuoteError(err.message || 'Failed to fetch quote');
      setTokenQuote(null);
    } finally {
      if (request === tokenRequest.current) setIsQuotingToken(false);
    }
  }, [tokenUsdAmount, computeTokenFromUsd, wallet?.address, selectedToken.address, selectedToken.decimals, quoteToken.address, quoteToken.decimals, chainId, tokenSymbol]);

  // Fetch wrapped native -> Token Quote
  const fetchUsdtQuote = useCallback(async () => {
    const request = ++usdtRequest.current;
    if (!usdtAmount || parseFloat(usdtAmount) <= 0) {
      setUsdtQuote(null);
      setUsdtQuoteError(null);
      return;
    }

    setIsQuotingUsdt(true);
    setUsdtQuoteError(null);

    try {
      assertTradingPair(selectedToken.address, chainId);
      const fromAddr = wallet?.address || ethers.ZeroAddress;
      const quote = await cowProtocol.getQuote({
        sellToken: quoteToken.address,
        buyToken: selectedToken.address,
        amount: quantityForUsd(usdtAmount, await tradingQuoteUsdPrice(chainId), quoteToken.decimals),
        kind: 'sell',
        from: fromAddr,
        sellTokenDecimals: quoteToken.decimals,
        buyTokenDecimals: selectedToken.decimals,
        chainId,
      });
      if (request !== usdtRequest.current) return;
      setUsdtQuote(quote);
    } catch (err: any) {
      if (request !== usdtRequest.current) return;
      console.warn(`Quote error (${quoteToken.symbol}->${tokenSymbol}):`, err.message);
      setUsdtQuoteError(err.message || 'Failed to fetch quote');
      setUsdtQuote(null);
    } finally {
      if (request === usdtRequest.current) setIsQuotingUsdt(false);
    }
  }, [usdtAmount, wallet?.address, selectedToken.address, selectedToken.decimals, quoteToken.address, quoteToken.decimals, chainId, tokenSymbol]);

  useEffect(() => {
    tokenRequest.current++; setTokenQuote(null); setTokenQuoteError(null);
    setIsQuotingToken(false);
    if (!Number.isFinite(Number(tokenUsdAmount)) || Number(tokenUsdAmount) <= 0 || selfPair || livePrice <= 0) return;
    const timer = setTimeout(fetchTokenQuote, 500);
    const refresh = setInterval(fetchTokenQuote, 15000);
    return () => { tokenRequest.current++; clearTimeout(timer); clearInterval(refresh); };
  }, [fetchTokenQuote, livePrice > 0, selfPair]);
  useEffect(() => {
    usdtRequest.current++; setUsdtQuote(null); setUsdtQuoteError(null);
    setIsQuotingUsdt(false);
    if (!Number.isFinite(Number(usdtAmount)) || Number(usdtAmount) <= 0 || selfPair) return;
    const timer = setTimeout(fetchUsdtQuote, 500);
    const refresh = setInterval(fetchUsdtQuote, 15000);
    return () => { usdtRequest.current++; clearTimeout(timer); clearInterval(refresh); };
  }, [fetchUsdtQuote, selfPair]);

  // Execute Trade: Token -> wrapped native
  const handleTradeTokenToUsdt = async () => {
    if (tradeBusy.current) return;
    if (!validSlippage) { systemLogService.logWarning('SWAP', 'Invalid Slippage', 'Enter a percentage from 0 to less than 100.', chainId); return; }
    if (!wallet) {
      onRequireWallet();
      return;
    }

    let effectiveUsdAmount = tokenUsdAmount;
    if (tokenMaxSelected) {
      effectiveUsdAmount = maxTokenUsd();
      if (effectiveUsdAmount !== tokenUsdAmount) setTokenUsdAmount(effectiveUsdAmount);
    }
    const tokenSellAmount = computeTokenFromUsd(effectiveUsdAmount);
    const tokenSellAmt = parseFloat(tokenSellAmount);
    if (!tokenSellAmt || tokenSellAmt <= 0) return;

    if (tokenRawBal < tokenSellAmt) {
      systemLogService.logWarning('SWAP', `Insufficient ${tokenSymbol} Balance`, `You have $${tokenUsdBal} USD / ${formatTokenDisplay(tokenRawBal)} ${tokenSymbol}.`, chainId);
      return;
    }

    setIsExecutingTokenTrade(true);
    tradeBusy.current = true;
    setExecutionStep('Preparing...');

    try {
      await exclusive(async () => {
      assertTradingPair(selectedToken.address, chainId);
      const quoteUsdPrice = await tradingQuoteUsdPrice(chainId);
      const signer = web3Service.getSigner(wallet.address, chainId);
      await web3Service.ensureAllowance(wallet.address, selectedToken.address, ethers.parseUnits(tokenSellAmount, selectedToken.decimals), chainId, true);

      setExecutionStep('Fetching CoW Route...');
      const quote = await cowProtocol.getQuote({
        sellToken: selectedToken.address,
        buyToken: quoteToken.address,
        amount: tokenSellAmount,
        kind: 'sell',
        from: wallet.address,
        sellTokenDecimals: selectedToken.decimals,
        buyTokenDecimals: quoteToken.decimals,
        chainId,
      });

      setExecutionStep('Signing Intent...');

      const buyFormatted = ethers.formatUnits(quote.quote.buyAmount, quoteToken.decimals);
      const pricePerToken = parseFloat(buyFormatted) * quoteUsdPrice / tokenSellAmt;

      const order: TradeOrder = {
        id: '', ownerAddress: wallet.address, orderCategory: 'market',
        timestamp: Date.now(),
        type: 'TOKEN_SWAP',
        tradeSide: 'sell', quoteTokenAddress: quoteToken.address, quoteUsdPrice,
        sellToken: selectedToken.address,
        buyToken: quoteToken.address,
        sellSymbol: tokenSymbol,
        buySymbol: usdtSymbol,
        sellAmount: tokenSellAmount,
        buyAmount: buyFormatted,
        sellDecimals: selectedToken.decimals,
        buyDecimals: quoteToken.decimals,
        executionPrice: pricePerToken,
        status: 'pending',
        feeAmount: '0',
        validTo: quote.quote.validTo,
        explorerUrl: '',
        chainId,
      };
      const orderUid = await cowProtocol.signAndSubmitOrder(quote, signer, slippage, chainId, async uid => {
        order.id = uid; order.explorerUrl = cowProtocol.getExplorerUrl(uid);
        storageService.addOrder(order); await storageService.flush();
      });
      onTradeSubmitted(orderUid, order);
      storageService.saveManualTradeAmount('sell', effectiveUsdAmount);
      setLastTokenAmount(effectiveUsdAmount);
      setTokenUsdAmount('0');
      setTokenMaxSelected(false);

      setExecutionStep('');
      onRefreshBalances();
      });
    } catch (error: any) {
      systemLogService.logError(
        'SWAP',
        `Trade Failed: ${tokenSymbol} → ${quoteToken.symbol}`,
        error?.message || String(error),
        chainId
      );
    } finally {
      tradeBusy.current = false;
      setIsExecutingTokenTrade(false);
      setExecutionStep('');
    }
  };

  // Execute Trade: wrapped native -> Token
  const handleTradeUsdtToToken = async () => {
    if (tradeBusy.current) return;
    if (!validSlippage) { systemLogService.logWarning('SWAP', 'Invalid Slippage', 'Enter a percentage from 0 to less than 100.', chainId); return; }
    if (!wallet) {
      onRequireWallet();
      return;
    }

    let effectiveUsdtAmount = usdtAmount;
    if (usdtMaxSelected) {
      effectiveUsdtAmount = maxUsdtUsd();
      if (effectiveUsdtAmount !== usdtAmount) setUsdtAmount(effectiveUsdtAmount);
    }
    const sellAmt = parseFloat(effectiveUsdtAmount);
    if (!sellAmt || sellAmt <= 0) return;


    setIsExecutingUsdtTrade(true);
    tradeBusy.current = true;
    setExecutionStep('Preparing...');

    try {
      await exclusive(async () => {
      assertTradingPair(selectedToken.address, chainId);
      const quoteUsdPrice = await tradingQuoteUsdPrice(chainId);
      const signer = web3Service.getSigner(wallet.address, chainId);
      const balanceWei = await web3Service.getTokenBalanceWei(wallet.address, quoteToken.address, chainId);
      const amountUsd = usdtMaxSelected ? bufferedMaxUsd([ethers.formatUnits(balanceWei, quoteToken.decimals)], quoteUsdPrice, quoteToken.decimals) : effectiveUsdtAmount;
      const quoteSellAmount = quantityForUsd(amountUsd, quoteUsdPrice, quoteToken.decimals);
      if (ethers.parseUnits(quoteSellAmount, quoteToken.decimals) > balanceWei) throw new Error(`Insufficient ${quoteToken.symbol} balance for USD ${amountUsd}`);
      await web3Service.ensureAllowance(wallet.address, quoteToken.address, ethers.parseUnits(quoteSellAmount, quoteToken.decimals), chainId);

      setExecutionStep('Fetching CoW Route...');
      const quote = await cowProtocol.getQuote({
        sellToken: quoteToken.address,
        buyToken: selectedToken.address,
        amount: quoteSellAmount,
        kind: 'sell',
        from: wallet.address,
        sellTokenDecimals: quoteToken.decimals,
        buyTokenDecimals: selectedToken.decimals,
        chainId,
      });

      setExecutionStep('Signing Intent...');

      const buyFormatted = ethers.formatUnits(quote.quote.buyAmount, selectedToken.decimals);
      const tokensBought = parseFloat(buyFormatted);
      const pricePerToken = tokensBought > 0 ? Number(quoteSellAmount) * quoteUsdPrice / tokensBought : livePrice;

      const order: TradeOrder = {
        id: '', ownerAddress: wallet.address, orderCategory: 'market',
        timestamp: Date.now(),
        type: 'TOKEN_SWAP',
        tradeSide: 'buy', quoteTokenAddress: quoteToken.address, quoteUsdPrice,
        sellToken: quoteToken.address,
        buyToken: selectedToken.address,
        sellSymbol: usdtSymbol,
        buySymbol: tokenSymbol,
        sellAmount: quoteSellAmount,
        buyAmount: buyFormatted,
        sellDecimals: quoteToken.decimals,
        buyDecimals: selectedToken.decimals,
        executionPrice: pricePerToken,
        status: 'pending',
        feeAmount: '0',
        validTo: quote.quote.validTo,
        explorerUrl: '',
        chainId,
      };
      const orderUid = await cowProtocol.signAndSubmitOrder(quote, signer, slippage, chainId, async uid => {
        order.id = uid; order.explorerUrl = cowProtocol.getExplorerUrl(uid);
        storageService.addOrder(order); await storageService.flush();
      });
      onTradeSubmitted(orderUid, order);
      storageService.saveManualTradeAmount('buy', amountUsd);
      setLastUsdtAmount(amountUsd);
      setUsdtAmount('0');
      setUsdtMaxSelected(false);

      setExecutionStep('');
      onRefreshBalances();
      });
    } catch (error: any) {
      systemLogService.logError(
        'SWAP',
        `Trade Failed: ${quoteToken.symbol} → ${tokenSymbol}`,
        error?.message || String(error),
        chainId
      );
    } finally {
      tradeBusy.current = false;
      setIsExecutingUsdtTrade(false);
      setExecutionStep('');
    }
  };

  const fillTokenPercent = (pct: number) => {
    if (pct === 100) {
      if (livePriceRef.current <= 0) {
        systemLogService.logWarning('SWAP', `${tokenSymbol} Price Unavailable`, 'MAX cannot be calculated until a fresh market price is available.', chainId);
        return;
      }
      const spendableUsd = maxTokenUsd();
      if (parseFloat(spendableUsd) <= 0) {
        systemLogService.logWarning('SWAP', `No Spendable ${tokenSymbol} Balance`, 'The available balance does not exceed the $0.05 MAX-trade buffer.', chainId);
        return;
      }
      setTokenMaxSelected(true);
      setTokenUsdAmount(spendableUsd);
      return;
    }
    setTokenMaxSelected(false);
    const totalUsd = parseFloat(tokenUsdBal);
    if (totalUsd <= 0) return;
    setTokenUsdAmount((totalUsd * (pct / 100)).toFixed(2));
  };

  const fillUsdtPercent = (pct: number) => {
    if (quotePrice <= 0) { systemLogService.logWarning('SWAP', 'USD conversion unavailable', quotePriceError, chainId); return; }
    if (pct === 100) {
      const spendableUsd = maxUsdtUsd();
      if (parseFloat(spendableUsd) <= 0) {
        systemLogService.logWarning('SWAP', `No Spendable ${quoteToken.symbol} Balance`, 'The available balance does not exceed the $0.05 MAX-trade buffer.', chainId);
        return;
      }
      setUsdtMaxSelected(true);
      setUsdtAmount(spendableUsd);
      return;
    }
    setUsdtMaxSelected(false);
    const totalUsdt = Number(quoteBalance) * quotePrice;
    if (totalUsdt <= 0) return;
    setUsdtAmount((totalUsdt * (pct / 100)).toFixed(2));
  };

  const currentTokenCalculated = computeTokenFromUsd(tokenUsdAmount);

  return (
    <div className={embedded ? 'p-3 flex flex-col border-t border-surface-border' : 'bg-surface/90 border border-surface-border rounded-xl p-3 shadow-lg flex flex-col justify-between h-full min-h-0 overflow-y-auto'}>
      
      {/* Header */}
      <div className={`flex items-center justify-between gap-2 pb-2 mb-2 border-b border-surface-border shrink-0 ${embedded ? 'flex-wrap' : ''}`}>
        <div className="flex items-center gap-1.5">
          <div className="p-1 rounded-lg bg-blue-500/10 text-blue-400">
            <Zap className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
              Manual Trade
            </h2>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono">
          <span>1 {tokenSymbol} ≈ ${formatTokenDisplay(livePrice)}</span>
          <span>|</span>
          <label className="flex items-center gap-1" title="Minimum received tolerance. Uses the same setting as Settings.">
            Slippage
            <input type="number" min="0" max="99.99" step="0.01" aria-label="Slippage percent"
              value={slippageInput} aria-invalid={!validSlippage}
              disabled={isExecutingTokenTrade || isExecutingUsdtTrade}
              onChange={e => {
                const value = e.target.value;
                setSlippageInput(value);
                if (value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) < 100) onUpdateSlippage(Number(value));
              }}
              className="w-16 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-white" />%
          </label>
        </div>
      </div>

      {(selfPair || quotePriceError) && <div className="text-xs text-rose-400">{selfPair ? 'Select a token other than the wrapped native trading asset.' : quotePriceError}</div>}
      {/* BOTH TRADE BOXES (USD-FIRST DISPLAY & ENTRY) */}
      <div className={embedded ? 'wallet-trade-columns grid gap-2.5' : 'grid grid-cols-1 md:grid-cols-2 gap-2.5 flex-1 min-h-0'}>
        
        {/* BOX 1: TRADE TOKEN -> wrapped native (THEME SECONDARY) */}
        <div className="bg-slate-950/90 border border-theme-secondary-30 rounded-xl p-3 flex flex-col justify-between shadow-sm">
          <div>
            {/* Header & Balance in USD */}
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-theme-secondary"></span>
                <span className="font-bold text-xs text-white">Trade {tokenSymbol} → {quoteToken.symbol}</span>
              </div>
              <div className="text-[10px] text-slate-400 font-mono text-right">
                <span className="text-theme-secondary font-bold">${tokenUsdBal} USD</span>
                <span className="text-slate-500 text-[9px] block">({formatTokenDisplay(tokenRawBal)} {tokenSymbol})</span>
              </div>
            </div>

            {/* Input in USD */}
            <div className="bg-slate-900 border border-slate-700 rounded-lg p-2.5 focus-within:border-theme-secondary transition-colors mb-2">
              <div className="flex items-center justify-between text-[9px] text-slate-400 mb-0.5">
                <span>You Sell (in USD)</span>
                <span className="font-mono text-theme-secondary">≈ {currentTokenCalculated} {tokenSymbol}</span>
              </div>
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1 w-full">
                  <span className="text-sm font-bold text-slate-400 font-mono">$</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={tokenUsdAmount}
                    onChange={(e) => { setTokenMaxSelected(false); setTokenUsdAmount(e.target.value); }}
                    placeholder="0.00"
                    className="w-full bg-transparent text-base font-bold font-mono text-white focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-1 shrink-0 px-2 py-0.5 rounded bg-slate-800 border border-slate-700">
                  <span className="text-[10px] font-bold text-white font-mono">USD</span>
                </div>
              </div>
            </div>

            {/* Quick % and USD Chips */}
            <div className="flex items-center gap-1 font-mono mb-2">
              {[25, 50, 75, 100].map((pct) => (
                <button
                  key={pct}
                  onClick={() => fillTokenPercent(pct)}
                  className="btn-tactile flex-1 py-1 rounded-md bg-slate-900 border border-slate-700 hover:border-theme-secondary text-[10px] text-slate-300 hover:text-white transition-colors cursor-pointer"
                >
                  {pct === 100 ? 'MAX' : `${pct}%`}
                </button>
              ))}
              {lastTokenAmount && (
                <button
                  onClick={() => { setTokenMaxSelected(false); setTokenUsdAmount(lastTokenAmount); }}
                  className="btn-tactile px-2 py-1 rounded-md bg-slate-900 border border-slate-700 hover:border-theme-secondary text-[10px] text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  Last ${formatUsdDisplay(lastTokenAmount)}
                </button>
              )}
            </div>

            {/* Quote Estimation */}
            <div className="bg-surface/50 border border-surface-border/60 rounded-lg p-2 space-y-0.5 text-[11px] font-mono mb-2">
              <div className="flex items-center justify-between text-slate-400">
                <span>Expected Return:</span>
                <span className="font-bold text-theme-secondary">
                  {isQuotingToken ? (
                    <span className="flex items-center gap-1 text-slate-400 text-[10px]">
                      <Loader2 className="w-2.5 h-2.5 animate-spin" /> Quoting...
                    </span>
                  ) : tokenQuote ? (
                    `≈ $${formatUsdDisplay(Number(ethers.formatUnits(tokenQuote.quote.buyAmount, quoteToken.decimals)) * quotePrice)} USD`
                  ) : (
                    `--.-- USD`
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between text-[10px] text-slate-500">
                <span>Effective Rate:</span>
                <span>
                  {tokenQuote && parseFloat(currentTokenCalculated) > 0
                    ? `1 ${tokenSymbol} ≈ $${formatTokenDisplay(parseFloat(ethers.formatUnits(tokenQuote.quote.buyAmount, quoteToken.decimals)) * quotePrice / parseFloat(currentTokenCalculated))}`
                    : `1 ${tokenSymbol} ≈ $${formatTokenDisplay(livePrice)}`}
                </span>
              </div>
              {tokenQuoteError && (
                <div className="text-[9px] text-rose-400 flex items-center gap-1 pt-0.5">
                  <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                  <span className="truncate">{tokenQuoteError}</span>
                </div>
              )}
            </div>
          </div>

          {/* BUTTON 1: SELL TOKEN */}
          <button
            onClick={handleTradeTokenToUsdt}
            disabled={!validSlippage || selfPair || quotePrice <= 0 || isExecutingUsdtTrade || livePrice <= 0 || balances.isLoading || isExecutingTokenTrade || !tokenUsdAmount || parseFloat(tokenUsdAmount) <= 0}
            className="btn-tactile w-full py-2.5 rounded-xl bg-theme-gradient-reverse text-white font-extrabold text-xs tracking-wide flex items-center justify-center gap-1.5 transition-all shadow-glow-secondary disabled:opacity-50 disabled:cursor-not-allowed uppercase shrink-0 cursor-pointer"
          >
            {isExecutingTokenTrade ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="text-[11px]">{executionStep || 'Processing...'}</span>
              </>
            ) : (
              <>
                <Zap className="w-3.5 h-3.5 fill-white" />
                <span>Trade {tokenSymbol} → {quoteToken.symbol} (${formatButtonUsd(tokenUsdAmount)})</span>
              </>
            )}
          </button>
        </div>

        {/* BOX 2: TRADE WRAPPED NATIVE -> TOKEN (THEME PRIMARY) */}
        <div className="bg-slate-950/90 border border-theme-primary-30 rounded-xl p-3 flex flex-col justify-between shadow-sm">
          <div>
            {/* Header & Balance in USD */}
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-theme-primary"></span>
                <span className="font-bold text-xs text-white">Trade {quoteToken.symbol} → {tokenSymbol}</span>
              </div>
              <div className="text-[10px] text-slate-400 font-mono text-right">
                <span className="text-theme-primary font-bold">${usdtBal} USD</span>
                <span className="text-slate-500 text-[9px] block">({formatTokenDisplay(quoteBalance)} {quoteToken.symbol})</span>
              </div>
            </div>

            {/* Input in USD */}
            <div className="bg-slate-900 border border-slate-700 rounded-lg p-2.5 focus-within:border-theme-primary transition-colors mb-2">
              <div className="flex items-center justify-between text-[9px] text-slate-400 mb-0.5">
                <span>You Sell (in USD)</span>
                <span className="text-theme-primary font-mono">Batch Settled</span>
              </div>
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1 w-full">
                  <span className="text-sm font-bold text-slate-400 font-mono">$</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={usdtAmount}
                    onChange={(e) => { setUsdtMaxSelected(false); setUsdtAmount(e.target.value); }}
                    placeholder="0.00"
                    className="w-full bg-transparent text-base font-bold font-mono text-white focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-1 shrink-0 px-2 py-0.5 rounded bg-slate-800 border border-slate-700">
                  <span className="text-[10px] font-bold text-white font-mono">USD</span>
                </div>
              </div>
            </div>

            {/* Quick % and USD Chips */}
            <div className="flex items-center gap-1 font-mono mb-2">
              {[25, 50, 75, 100].map((pct) => (
                <button
                  key={pct}
                  onClick={() => fillUsdtPercent(pct)}
                  className="btn-tactile flex-1 py-1 rounded-md bg-slate-900 border border-slate-700 hover:border-theme-primary text-[10px] text-slate-300 hover:text-white transition-colors cursor-pointer"
                >
                  {pct === 100 ? 'MAX' : `${pct}%`}
                </button>
              ))}
              {lastUsdtAmount && (
                <button
                  onClick={() => { setUsdtMaxSelected(false); setUsdtAmount(lastUsdtAmount); }}
                  className="btn-tactile px-2 py-1 rounded-md bg-slate-900 border border-slate-700 hover:border-theme-primary text-[10px] text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  Last ${formatUsdDisplay(lastUsdtAmount)}
                </button>
              )}
            </div>

            {/* Quote Estimation in USD & Token */}
            <div className="bg-surface/50 border border-surface-border/60 rounded-lg p-2 space-y-0.5 text-[11px] font-mono mb-2">
              <div className="flex items-center justify-between text-slate-400">
                <span>Expected Return:</span>
                <span className="font-bold text-theme-primary">
                  {isQuotingUsdt ? (
                    <span className="flex items-center gap-1 text-slate-400 text-[10px]">
                      <Loader2 className="w-2.5 h-2.5 animate-spin" /> Quoting...
                    </span>
                  ) : usdtQuote ? (
                    `≈ $${formatUsdDisplay(Number(ethers.formatUnits(usdtQuote.quote.buyAmount, selectedToken.decimals)) * livePrice)} USD (${formatTokenDisplay(ethers.formatUnits(usdtQuote.quote.buyAmount, selectedToken.decimals))} ${tokenSymbol})`
                  ) : (
                    `--.---- ${tokenSymbol}`
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between text-[10px] text-slate-500">
                <span>Effective Rate:</span>
                <span>
                  {usdtQuote && parseFloat(usdtAmount) > 0
                    ? `1 ${tokenSymbol} ≈ $${formatTokenDisplay(parseFloat(usdtAmount) / parseFloat(ethers.formatUnits(usdtQuote.quote.buyAmount, selectedToken.decimals)))}`
                    : `1 ${tokenSymbol} ≈ $${formatTokenDisplay(livePrice)}`}
                </span>
              </div>
              {usdtQuoteError && (
                <div className="text-[9px] text-rose-400 flex items-center gap-1 pt-0.5">
                  <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                  <span className="truncate">{usdtQuoteError}</span>
                </div>
              )}
            </div>
          </div>

          {/* BUTTON 2: BUY TOKEN */}
          <button
            onClick={handleTradeUsdtToToken}
            disabled={!validSlippage || selfPair || quotePrice <= 0 || isExecutingTokenTrade || isExecutingUsdtTrade || !usdtAmount || parseFloat(usdtAmount) <= 0}
            className="btn-tactile w-full py-2.5 rounded-xl bg-theme-gradient text-slate-950 font-extrabold text-xs tracking-wide flex items-center justify-center gap-1.5 transition-all shadow-glow-primary disabled:opacity-50 disabled:cursor-not-allowed uppercase shrink-0 cursor-pointer"
          >
            {isExecutingUsdtTrade ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="text-[11px]">{executionStep || 'Processing...'}</span>
              </>
            ) : (
              <>
                <Zap className="w-3.5 h-3.5 fill-slate-950" />
                <span>Trade {quoteToken.symbol} → {tokenSymbol} (${formatButtonUsd(usdtAmount)})</span>
              </>
            )}
          </button>
        </div>

      </div>

      {/* Safety info footer */}
      <div className="pt-2 mt-2 border-t border-surface-border text-[9px] text-slate-400 flex items-center justify-between font-mono shrink-0">
        <span className="flex items-center gap-1 text-theme-primary">
          <ShieldCheck className="w-3 h-3 text-theme-primary" /> CoW Protocol MEV Protected
        </span>
        <span className="text-slate-500">CoW Protocol · DEKXDIS fee {(cowProtocol.getPartnerFeeBps() / 100).toFixed(2)}%</span>
      </div>

    </div>
  );
};
