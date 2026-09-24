import { placeOrder } from '../services/orderPlacement';
import { useTradingQuotePrice } from '../hooks/useTradingQuotePrice';
import { quantityForUsd } from '../utils/amounts';
import React, { useState, useEffect, useMemo } from 'react';
import { 
  X, 
  Target, 
  ShieldAlert, 
  TrendingUp, 
  TrendingDown, 
  Loader2, 
  AlertTriangle,
  Link,
  Layers
} from 'lucide-react';
import { 
  WalletState, 
  Balances, 
  AllowanceState, 
  TradeOrder, 
  LimitOrderSettings,
  TokenConfig,
  DEFAULT_BSC_TOKENS
} from '../types/trading';
import { getChainConfig, getTradingQuoteToken, DEFAULT_CHAIN_ID } from '../types/chains';
import { storageService } from '../services/storageService';
import { systemLogService } from '../services/systemLogService';
import { getNextOcoTag } from '../utils/ocoUtils';
import { formatTokenDisplay, formatUsdDisplay } from '../utils/displayFormat';

interface LimitOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  clickedPrice: number;
  candleTime?: number;
  wallet: WalletState | null;
  balances: Balances;
  allowances: AllowanceState;
  onOrderPlaced: (order: TradeOrder) => void;
  onOrdersPlaced?: (orders: TradeOrder[]) => void;
  onRefreshBalances: () => void;
  onRequireWallet: () => void;
  targetToken?: TokenConfig;
  chainId?: number;
  livePrice?: number;
  existingOrders?: TradeOrder[];
}

export const LimitOrderModal: React.FC<LimitOrderModalProps> = ({
  isOpen,
  onClose,
  clickedPrice,
  candleTime,
  wallet,
  balances,
  allowances,
  onOrderPlaced,
  onOrdersPlaced,
  onRefreshBalances,
  onRequireWallet,
  targetToken,
  chainId = DEFAULT_CHAIN_ID,
  livePrice,
  existingOrders = [],
}) => {
  const chainConfig = getChainConfig(chainId);
  const quoteToken = getTradingQuoteToken(chainId);
  const { price: quotePrice, error: quotePriceError } = useTradingQuotePrice(chainId);
  const token = targetToken || DEFAULT_BSC_TOKENS[0];

  // Order Side: BUY (wrapped native -> Token) or SELL (Token -> wrapped native)
  const [orderSide, setOrderSide] = useState<'BUY' | 'SELL'>('BUY');

  // Load saved persistent limit settings
  const [savedSettings, setSavedSettings] = useState<LimitOrderSettings>(() => storageService.getLimitSettings());

  // Input states
  const [priceInput, setPriceInput] = useState<string>('0');
  const [usdAmount, setUsdAmount] = useState<string>(savedSettings.defaultUsdAmount || '50');
  
  // Bracket states (for BUY side)
  const [tpEnabled, setTpEnabled] = useState<boolean>(savedSettings.tpEnabled);
  const [tpPercent, setTpPercent] = useState<number>(savedSettings.tpPercent || 2.0);
  const [tpPriceManual, setTpPriceManual] = useState<string | null>(null);

  const [slEnabled, setSlEnabled] = useState<boolean>(savedSettings.slEnabled);
  const [slPercent, setSlPercent] = useState<number>(savedSettings.slPercent || 2.0);
  const [slPriceManual, setSlPriceManual] = useState<string | null>(null);

  // OCO Connected Order state (for SELL side)
  const [addConnectedOrder, setAddConnectedOrder] = useState<boolean>(true);
  const [connectedPercent, setConnectedPercent] = useState<number>(2.0);
  const [connectedPriceManual, setConnectedPriceManual] = useState<string | null>(null);

  // Processing state
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [stepMsg, setStepMsg] = useState<string>('');

  // When modal opens or clickedPrice changes, update price inputs
  useEffect(() => {
    if (isOpen && clickedPrice > 0) {
      const formatted = formatTokenDisplay(clickedPrice);
      setPriceInput(formatted);
      setTpPriceManual(null);
      setSlPriceManual(null);
      setConnectedPriceManual(null);
      setErrorMsg(null);
    }
  }, [isOpen, clickedPrice]);

  // Sync settings to persistent storage whenever they change
  useEffect(() => {
    const newSettings: LimitOrderSettings = {
      defaultUsdAmount: usdAmount,
      tpEnabled,
      tpPercent,
      slEnabled,
      slPercent,
    };
    storageService.saveLimitSettings(newSettings);
    setSavedSettings(newSettings);
  }, [usdAmount, tpEnabled, tpPercent, slEnabled, slPercent]);

  // Derived price numbers
  const limitPrice = parseFloat(priceInput) || 0;
  const currentMarketPrice = livePrice && livePrice > 0 ? livePrice : (clickedPrice > 0 ? clickedPrice : 700);
  const isSellAbove = limitPrice >= currentMarketPrice;

  const parsedUsd = parseFloat(usdAmount) || 0;

  // Available balances
  const availableUsdt = Number(balances.tokenBalances?.[quoteToken.address.toLowerCase()] || balances.wbnb || '0') * quotePrice;
  const availableTokenBal = useMemo(() => {
    const lower = token.address.toLowerCase();
    return parseFloat(balances.tokenBalances?.[lower] || balances.tokenBalances?.[token.symbol] || '0');
  }, [balances, token]);

  const totalTokenUsd = useMemo(() => {
    if (limitPrice > 0) return availableTokenBal * limitPrice;
    if (currentMarketPrice > 0) return availableTokenBal * currentMarketPrice;
    return 0;
  }, [availableTokenBal, limitPrice, currentMarketPrice]);

  const activePoolUsd = orderSide === 'BUY' ? availableUsdt : totalTokenUsd;
  const percentOfAvailable = activePoolUsd > 0 && parsedUsd > 0 ? (parsedUsd / activePoolUsd) * 100 : 0;

  const tokenBuyUnits = useMemo(() => { try { return quantityForUsd(usdAmount, limitPrice, token.decimals); } catch { return '0'; } }, [usdAmount, limitPrice, token.decimals]);
  const tokenUnitsToSell = limitPrice > 0 && parsedUsd > 0 ? (parsedUsd / limitPrice) : 0;

  // Calculated TP / SL prices (for Buy orders)
  const calculatedTpPrice = useMemo(() => {
    const manual = parseFloat(tpPriceManual ?? '');
    if (!isNaN(manual) && manual > 0) return manual;
    if (limitPrice > 0 && tpPercent > 0) {
      return limitPrice * (1 + tpPercent / 100);
    }
    return 0;
  }, [limitPrice, tpPercent, tpPriceManual]);

  const calculatedSlPrice = useMemo(() => {
    const manual = parseFloat(slPriceManual ?? '');
    if (!isNaN(manual) && manual > 0) return manual;
    if (limitPrice > 0 && slPercent > 0) {
      return limitPrice * (1 - slPercent / 100);
    }
    return 0;
  }, [limitPrice, slPercent, slPriceManual]);

  // Calculated Connected Order Price (for SELL orders)
  const calculatedConnectedPrice = useMemo(() => {
    const manual = parseFloat(connectedPriceManual ?? '');
    if (!isNaN(manual) && manual > 0) return manual;
    if (currentMarketPrice > 0 && connectedPercent > 0) {
      if (isSellAbove) {
        return currentMarketPrice * (1 - connectedPercent / 100);
      } else {
        return currentMarketPrice * (1 + connectedPercent / 100);
      }
    }
    return 0;
  }, [currentMarketPrice, connectedPercent, connectedPriceManual, isSellAbove]);

  const usdtToReceiveConnected = calculatedConnectedPrice > 0 && tokenUnitsToSell > 0 ? (tokenUnitsToSell * calculatedConnectedPrice) : 0;
  const nextOcoTag = useMemo(() => getNextOcoTag(existingOrders), [existingOrders, isOpen]);

  if (!isOpen) return null;

  const handlePlaceLimitOrder = async () => {
    if (isSubmitting) return;
    if (!wallet) { onRequireWallet(); return; }
    setIsSubmitting(true); setErrorMsg(null); setStepMsg('Preparing order…');
    try {
      const placed = await placeOrder({ wallet, token, chainId, candleTime }, {
        side: orderSide === 'BUY' ? 'buy' : 'sell', price: limitPrice, amount: usdAmount, amountUnit: 'usd',
        sellKind: orderSide === 'SELL' && !isSellAbove ? 'stop' : 'limit',
        takeProfitPrice: orderSide === 'BUY' ? (tpEnabled ? calculatedTpPrice : undefined)
          : (!isSellAbove && addConnectedOrder ? calculatedConnectedPrice : undefined),
        stopLossPrice: orderSide === 'BUY' ? (slEnabled ? calculatedSlPrice : undefined)
          : (isSellAbove && addConnectedOrder ? calculatedConnectedPrice : undefined),
      });
      if (onOrdersPlaced) onOrdersPlaced(placed); else placed.forEach(onOrderPlaced);
      onRefreshBalances(); onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      systemLogService.logError('ORDER', 'Order placement failed: ' + token.symbol, message, chainId);
      setErrorMsg(message);
    } finally { setIsSubmitting(false); setStepMsg(''); }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150 select-text">
      <div className="bg-surface border border-surface-border rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[92vh] font-mono">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-surface-border bg-surface-header">
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-xl border ${
              orderSide === 'BUY' 
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' 
                : isSellAbove 
                  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' 
                  : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
            }`}>
              <Target className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                {orderSide === 'BUY' ? 'Chart Limit Buy' : isSellAbove ? 'Take-Profit Sell Order' : 'Stop-Loss Sell Order'}
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-950 text-cow-cyan border border-cow-cyan/30">
                  {chainConfig.shortName}
                </span>
              </h2>
              <p className="text-[11px] text-slate-400">
                {orderSide === 'BUY' 
                  ? `Buy ${token.symbol} at target limit price` 
                  : isSellAbove 
                    ? `Selling ${token.symbol} above market ($${formatTokenDisplay(currentMarketPrice)}) for profit`
                    : `Protective exit for ${token.symbol} below market ($${formatTokenDisplay(currentMarketPrice)})`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-surface transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-3.5 overflow-y-auto min-h-0">
          
          {/* 1. BUY / SELL SIDE SWITCHER */}
          <div className="flex items-center gap-1 bg-background border border-surface-border rounded-xl p-1 shrink-0">
            <button
              type="button"
              onClick={() => {
                setOrderSide('BUY');
                setErrorMsg(null);
                if (limitPrice > 0) {
                  setTpPriceManual((limitPrice * (1 + tpPercent / 100)).toFixed(2));
                  setSlPriceManual((limitPrice * (1 - slPercent / 100)).toFixed(2));
                }
              }}
              className={`flex-1 py-2 px-3 rounded-lg text-xs font-extrabold transition-all flex items-center justify-center gap-1.5 ${
                orderSide === 'BUY'
                  ? 'bg-emerald-500 text-slate-950 shadow-glow-green'
                  : 'text-slate-400 hover:text-white hover:bg-surface'
              }`}
            >
              <TrendingUp className="w-4 h-4" />
              <span>LIMIT BUY ({quoteToken.symbol} → {token.symbol})</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setOrderSide('SELL');
                setErrorMsg(null);
                if (currentMarketPrice > 0) {
                  const connP = isSellAbove
                    ? currentMarketPrice * (1 - connectedPercent / 100)
                    : currentMarketPrice * (1 + connectedPercent / 100);
                  setConnectedPriceManual(String(connP));
                }
              }}
              className={`flex-1 py-2 px-3 rounded-lg text-xs font-extrabold transition-all flex items-center justify-center gap-1.5 ${
                orderSide === 'SELL'
                  ? isSellAbove ? 'bg-emerald-600 text-white shadow-glow-green' : 'bg-rose-600 text-white shadow-glow-red'
                  : 'text-slate-400 hover:text-white hover:bg-surface'
              }`}
            >
              <TrendingDown className="w-4 h-4" />
              <span>LIMIT SELL ({token.symbol} → {quoteToken.symbol})</span>
            </button>
          </div>

          {/* 2. Target Limit Price */}
          <div className={`border rounded-xl p-3 transition-colors ${
            orderSide === 'BUY'
              ? 'bg-background/80 border-surface-border focus-within:border-amber-400'
              : isSellAbove
                ? 'bg-emerald-950/20 border-emerald-500/40 focus-within:border-emerald-400'
                : 'bg-rose-950/20 border-rose-500/40 focus-within:border-rose-400'
          }`}>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                {orderSide === 'BUY' ? (
                  <span>Target Limit Price ($)</span>
                ) : isSellAbove ? (
                  <span className="text-emerald-400 flex items-center gap-1 font-bold">
                    <TrendingUp className="w-3.5 h-3.5" />
                    Take-Profit (TP) Target Price ($)
                  </span>
                ) : (
                  <span className="text-rose-400 flex items-center gap-1 font-bold">
                    <ShieldAlert className="w-3.5 h-3.5" />
                    Stop-Loss (SL) Trigger Price ($)
                  </span>
                )}
              </label>
              
              <div className="text-[10px] font-bold">
                {orderSide === 'BUY' ? (
                  <span className="text-amber-400">Buy @ or below</span>
                ) : isSellAbove ? (
                  <span className="text-emerald-400">
                    +{(((limitPrice - currentMarketPrice) / currentMarketPrice) * 100).toFixed(1)}% above market
                  </span>
                ) : (
                  <span className="text-rose-400">
                    {(((limitPrice - currentMarketPrice) / currentMarketPrice) * 100).toFixed(1)}% below market
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold text-slate-500 font-mono">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={priceInput}
                onChange={(e) => {
                  const val = e.target.value;
                  setPriceInput(val);
                  const parsed = parseFloat(val);
                  if (parsed > 0) {
                    setTpPriceManual((parsed * (1 + tpPercent / 100)).toFixed(2));
                    setSlPriceManual((parsed * (1 - slPercent / 100)).toFixed(2));
                  }
                }}
                className="w-full bg-transparent text-lg font-bold font-mono text-white focus:outline-none"
                placeholder="0.00"
              />
            </div>
            
            <div className="text-[10px] text-slate-400 mt-1 flex items-center justify-between">
              <span>Market Price: ${formatTokenDisplay(currentMarketPrice)}</span>
              <span className="text-slate-500">Right-clicked chart price</span>
            </div>
          </div>

          {/* 3. ORDER SIZING INPUT */}
          <div className={`bg-background/80 border rounded-xl p-3 transition-colors ${
            orderSide === 'BUY' ? 'border-surface-border focus-within:border-emerald-400' : 'border-surface-border focus-within:border-rose-400'
          }`}>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5">
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  {orderSide === 'BUY' ? 'Spend Amount (USD)' : 'Sell Amount (in USD)'}
                </label>
                {percentOfAvailable > 0 && (
                  <span className="text-[10px] text-amber-400 font-mono">
                    ({percentOfAvailable > 100 ? '100%+' : percentOfAvailable.toFixed(1)}% of avail)
                  </span>
                )}
              </div>
              <div className="text-[10px] text-slate-400 font-mono text-right">
                {orderSide === 'BUY' ? (
                  <span>Avail: <strong className="text-white">${formatUsdDisplay(availableUsdt)} USD</strong></span>
                ) : (
                  <span>Avail: <strong className="text-white">${formatUsdDisplay(totalTokenUsd)} USD</strong> <span className="text-slate-500 text-[9px]">({formatTokenDisplay(availableTokenBal)} {token.symbol})</span></span>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5 w-full">
                <span className="text-base font-bold text-slate-500 font-mono">$</span>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={usdAmount}
                  onChange={(e) => setUsdAmount(e.target.value)}
                  className="w-full bg-transparent text-lg font-bold font-mono text-white focus:outline-none"
                  placeholder="0.00"
                />
              </div>
              <div className="flex items-center gap-1 shrink-0 px-2 py-0.5 rounded bg-surface border border-surface-border">
                <span className="text-[10px] font-bold text-slate-300 font-mono">USD</span>
              </div>
            </div>

            {/* Token Equivalent Subtitle */}
            <div className="text-[10px] mt-1 flex items-center justify-between">
              {orderSide === 'BUY' ? (
                <span className="text-emerald-400 font-mono">≈ {formatTokenDisplay(tokenBuyUnits)} {token.symbol} to receive</span>
              ) : (
                <span className="text-rose-300 font-mono">≈ {formatTokenDisplay(tokenUnitsToSell)} {token.symbol} to sell</span>
              )}
            </div>

            {/* 5%, 10%, 25%, 50%, 100% Quick Percentage Buttons */}
            <div className="grid grid-cols-5 gap-1.5 mt-2.5">
              {[5, 10, 25, 50, 100].map((pct) => {
                const chipUsd = activePoolUsd * (pct / 100);
                const isSelected = Math.abs(parsedUsd - chipUsd) < 0.02 && parsedUsd > 0;

                return (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => {
                      if (activePoolUsd > 0) {
                        setUsdAmount(chipUsd.toFixed(2));
                      }
                    }}
                    className={`py-1.5 px-1 rounded-lg border text-center transition-all flex flex-col items-center justify-center ${
                      isSelected
                        ? orderSide === 'BUY'
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50 shadow-sm'
                          : 'bg-rose-500/20 text-rose-300 border-rose-500/50 shadow-sm'
                        : 'bg-surface/80 border-surface-border text-slate-300 hover:text-white hover:border-slate-500'
                    }`}
                  >
                    <span className="text-[11px] font-bold tracking-tight">
                      {pct === 100 ? '100% MAX' : `${pct}%`}
                    </span>
                    <span className="text-[9px] text-slate-400 font-mono mt-0.5">
                      ${chipUsd >= 1000 ? (chipUsd / 1000).toFixed(2) + 'k' : chipUsd.toFixed(2)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 4. OCO CONNECTED ORDER FOR SELL SIDE */}
          {orderSide === 'SELL' && (
            <div className={`p-3 rounded-xl border transition-all ${
              addConnectedOrder
                ? isSellAbove
                  ? 'bg-rose-950/20 border-rose-500/40'
                  : 'bg-emerald-950/20 border-emerald-500/40'
                : 'bg-background/40 border-surface-border opacity-75'
            }`}>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={addConnectedOrder}
                    onChange={(e) => setAddConnectedOrder(e.target.checked)}
                    className="w-4 h-4 rounded text-amber-500 accent-amber-500 cursor-pointer"
                  />
                  <span className="text-xs font-bold text-white flex items-center gap-1.5">
                    <Link className="w-3.5 h-3.5 text-amber-400" />
                    {isSellAbove ? 'Add Connected Stop-Loss (SL)' : 'Add Connected Take-Profit (TP)'}
                  </span>
                </label>

                {addConnectedOrder && (
                  <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1">
                    <Layers className="w-3 h-3" />
                    OCO Tag: [{nextOcoTag}]
                  </span>
                )}
              </div>

              {addConnectedOrder && (
                <div className="mt-2.5 pt-2.5 border-t border-surface-border/50 space-y-2">
                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span>Target {isSellAbove ? 'Stop Price' : 'Profit Price'}:</span>
                    <span className="font-bold text-white font-mono">
                      ${formatTokenDisplay(calculatedConnectedPrice)} ({isSellAbove ? `-${connectedPercent}%` : `+${connectedPercent}%`})
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 bg-surface border border-surface-border rounded-lg px-2.5 py-1 flex-1 min-w-0">
                      <span className="text-xs font-bold text-slate-500">$</span>
                      <input
                        type="number"
                        step="any"
                        aria-label="Connected TP/SL price"
                        value={connectedPriceManual ?? formatTokenDisplay(calculatedConnectedPrice)}
                        onChange={(e) => {
                          const val = e.target.value;
                          setConnectedPriceManual(val);
                          const parsed = parseFloat(val);
                          if (parsed > 0 && currentMarketPrice > 0) {
                            const diff = Math.abs(parsed - currentMarketPrice);
                            setConnectedPercent(parseFloat(((diff / currentMarketPrice) * 100).toFixed(2)));
                          }
                        }}
                        onBlur={() => {
                          if (!Number.isFinite(parseFloat(connectedPriceManual ?? '')) || Number(connectedPriceManual) <= 0) {
                            setConnectedPriceManual(null);
                          }
                        }}
                        className="w-full bg-transparent text-xs font-bold font-mono text-white focus:outline-none"
                        placeholder={formatTokenDisplay(calculatedConnectedPrice)}
                      />
                    </div>
                    <div className="flex items-center gap-1 bg-surface border border-surface-border rounded-lg px-2 py-1 w-20 shrink-0">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        aria-label="Connected TP/SL percent"
                        value={connectedPercent || ''}
                        onChange={(e) => {
                          setConnectedPercent(Number(e.target.value));
                          setConnectedPriceManual(null);
                        }}
                        className="w-full min-w-0 bg-transparent text-xs font-bold font-mono text-white focus:outline-none"
                      />
                      <span className="text-xs text-white">%</span>
                    </div>

                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 5].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => {
                            setConnectedPercent(pct);
                            setConnectedPriceManual(null);
                          }}
                          className={`px-2 py-1 rounded text-[10px] font-bold font-mono transition-colors ${
                            Math.abs(connectedPercent - pct) < 0.05
                              ? 'bg-amber-500/30 text-amber-300 border border-amber-500/40'
                              : 'bg-surface border border-surface-border text-slate-400 hover:text-white'
                          }`}
                        >
                          {isSellAbove ? `-${pct}%` : `+${pct}%`}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 5. BRACKET ORDERS FOR BUY SIDE */}
          {orderSide === 'BUY' && (
            <div className="space-y-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center justify-between">
                <span>Automated Bracket Exits (OCO Pair [{nextOcoTag}])</span>
                <span className="text-slate-500 text-[9px]">Executes automatically when Buy fills</span>
              </div>

              {/* Take-Profit Control */}
              <div className={`p-2.5 rounded-xl border transition-all ${
                tpEnabled ? 'bg-emerald-950/20 border-emerald-500/30' : 'bg-background/40 border-surface-border opacity-70'
              }`}>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-200 font-bold text-[11px]">
                    <input
                      type="checkbox"
                      checked={tpEnabled}
                      onChange={(e) => setTpEnabled(e.target.checked)}
                      className="w-3.5 h-3.5 accent-emerald-500 rounded"
                    />
                    <span className="text-emerald-400">Take-Profit (TP) Limit Sell</span>
                  </label>
                  {tpEnabled && (
                    <span className="text-[10px] font-mono text-emerald-400 font-bold">
                      ${formatTokenDisplay(calculatedTpPrice)} (+{tpPercent}%)
                    </span>
                  )}
                </div>

                {tpEnabled && (
                  <div className="flex items-center gap-2 mt-2 pt-2 border-t border-emerald-500/20">
                    <div className="flex items-center gap-1 bg-surface border border-surface-border rounded-lg px-2 py-1 flex-1 min-w-0">
                      <span className="text-xs font-bold text-emerald-400">$</span>
                      <input
                        type="number"
                        step="any"
                        aria-label="TP price"
                        value={tpPriceManual ?? formatTokenDisplay(calculatedTpPrice)}
                        onChange={(e) => {
                          const val = e.target.value;
                          setTpPriceManual(val);
                          const parsed = parseFloat(val);
                          if (parsed > 0 && limitPrice > 0) {
                            setTpPercent(parseFloat((((parsed - limitPrice) / limitPrice) * 100).toFixed(2)));
                          }
                        }}
                        onBlur={() => {
                          if (!Number.isFinite(parseFloat(tpPriceManual ?? '')) || Number(tpPriceManual) <= 0) {
                            setTpPriceManual(null);
                          }
                        }}
                        className="w-full bg-transparent text-xs font-bold font-mono text-emerald-400 focus:outline-none"
                        placeholder={formatTokenDisplay(calculatedTpPrice)}
                      />
                    </div>
                    <div className="flex items-center gap-1 bg-surface border border-surface-border rounded-lg px-2 py-1 w-20 shrink-0">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        aria-label="TP percent"
                        value={tpPercent || ''}
                        onChange={(e) => {
                          setTpPercent(Number(e.target.value));
                          setTpPriceManual(null);
                        }}
                        className="w-full min-w-0 bg-transparent text-xs font-bold font-mono text-emerald-400 focus:outline-none"
                      />
                      <span className="text-xs text-emerald-400">%</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 5].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => {
                            setTpPercent(pct);
                            setTpPriceManual(null);
                          }}
                          className={`px-2 py-1 rounded text-[10px] font-bold font-mono transition-colors ${
                            Math.abs(tpPercent - pct) < 0.05
                              ? 'bg-emerald-500/30 text-emerald-300 border border-emerald-500/40'
                              : 'bg-surface border border-surface-border text-slate-400 hover:text-white'
                          }`}
                        >
                          +{pct}%
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Stop-Loss Control */}
              <div className={`p-2.5 rounded-xl border transition-all ${
                slEnabled ? 'bg-rose-950/20 border-rose-500/30' : 'bg-background/40 border-surface-border opacity-70'
              }`}>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-200 font-bold text-[11px]">
                    <input
                      type="checkbox"
                      checked={slEnabled}
                      onChange={(e) => setSlEnabled(e.target.checked)}
                      className="w-3.5 h-3.5 accent-rose-500 rounded"
                    />
                    <span className="text-rose-400">Stop-Loss (SL) Trigger Sell</span>
                  </label>
                  {slEnabled && (
                    <span className="text-[10px] font-mono text-rose-400 font-bold">
                      ${formatTokenDisplay(calculatedSlPrice)} (-{slPercent}%)
                    </span>
                  )}
                </div>

                {slEnabled && (
                  <div className="flex items-center gap-2 mt-2 pt-2 border-t border-rose-500/20">
                    <div className="flex items-center gap-1 bg-surface border border-surface-border rounded-lg px-2 py-1 flex-1 min-w-0">
                      <span className="text-xs font-bold text-rose-400">$</span>
                      <input
                        type="number"
                        step="any"
                        aria-label="SL price"
                        value={slPriceManual ?? formatTokenDisplay(calculatedSlPrice)}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSlPriceManual(val);
                          const parsed = parseFloat(val);
                          if (parsed > 0 && limitPrice > 0) {
                            setSlPercent(parseFloat((((limitPrice - parsed) / limitPrice) * 100).toFixed(2)));
                          }
                        }}
                        onBlur={() => {
                          if (!Number.isFinite(parseFloat(slPriceManual ?? '')) || Number(slPriceManual) <= 0) {
                            setSlPriceManual(null);
                          }
                        }}
                        className="w-full bg-transparent text-xs font-bold font-mono text-rose-400 focus:outline-none"
                        placeholder={formatTokenDisplay(calculatedSlPrice)}
                      />
                    </div>
                    <div className="flex items-center gap-1 bg-surface border border-surface-border rounded-lg px-2 py-1 w-20 shrink-0">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        aria-label="SL percent"
                        value={slPercent || ''}
                        onChange={(e) => {
                          setSlPercent(Number(e.target.value));
                          setSlPriceManual(null);
                        }}
                        className="w-full min-w-0 bg-transparent text-xs font-bold font-mono text-rose-400 focus:outline-none"
                      />
                      <span className="text-xs text-rose-400">%</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {[1, 1.5, 2, 3].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => {
                            setSlPercent(pct);
                            setSlPriceManual(null);
                          }}
                          className={`px-2 py-1 rounded text-[10px] font-bold font-mono transition-colors ${
                            Math.abs(slPercent - pct) < 0.05
                              ? 'bg-rose-500/30 text-rose-300 border border-rose-500/40'
                              : 'bg-surface border border-surface-border text-slate-400 hover:text-white'
                          }`}
                        >
                          -{pct}%
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Status / Error Message */}
          {errorMsg && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-start gap-2 text-xs text-rose-400">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3.5 border-t border-surface-border bg-surface-header flex items-center justify-between">
          <div className="text-[10px] text-slate-400">
            {stepMsg && (
              <span className="flex items-center gap-1.5 text-amber-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{stepMsg}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={isSubmitting}
              className="btn-tactile px-3.5 py-2 rounded-xl border border-surface-border text-xs text-slate-300 hover:text-white hover:bg-surface transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handlePlaceLimitOrder}
              disabled={isSubmitting || limitPrice <= 0 || parsedUsd <= 0}
              className={`btn-tactile px-5 py-2 rounded-xl text-xs font-bold uppercase transition-all shadow-lg flex items-center gap-1.5 cursor-pointer ${
                orderSide === 'BUY'
                  ? 'bg-theme-gradient text-slate-950 font-extrabold shadow-glow-primary'
                  : 'bg-theme-gradient-reverse text-white font-extrabold shadow-glow-secondary'
              }`}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Submitting...</span>
                </>
              ) : (
                <span>
                  {orderSide === 'BUY' 
                    ? `Submit Limit Buy ($${parsedUsd})` 
                    : `Submit Limit Sell ($${parsedUsd})`}
                </span>
              )}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
