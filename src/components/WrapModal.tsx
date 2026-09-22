import { exclusive } from '../services/executionEngine';
import React, { useState } from 'react';
import { X, ArrowRightLeft, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Balances, WalletState } from '../types/trading';
import { getChainConfig, DEFAULT_CHAIN_ID } from '../types/chains';
import { web3Service } from '../services/web3Service';
import { formatTokenDisplay, formatUsdDisplay } from '../utils/displayFormat';

interface WrapModalProps {
  isOpen: boolean;
  onClose: () => void;
  wallet: WalletState | null;
  balances: Balances;
  chainId?: number;
  nativePrice?: number;
  onRefreshBalances: () => void;
}

export const WrapModal: React.FC<WrapModalProps> = ({
  isOpen,
  onClose,
  wallet,
  balances,
  chainId = DEFAULT_CHAIN_ID,
  nativePrice,
  onRefreshBalances,
}) => {
  const [direction, setDirection] = useState<'WRAP' | 'UNWRAP'>('WRAP');
  const [usdAmount, setUsdAmount] = useState('25');
  const [isLoading, setIsLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !wallet) return null;

  const chainConfig = getChainConfig(chainId);
  const nativeSymbol = chainConfig.nativeToken.symbol;
  const wrappedSymbol = chainConfig.nativeToken.wrappedSymbol;

  const isWrap = direction === 'WRAP';
  const effectiveNativePrice = (nativePrice && nativePrice > 0) ? nativePrice : 0;

  const formatButtonUsd = (val: string): string => {
    return formatUsdDisplay(val || 0);
  };

  const rawAvailableToken = isWrap ? parseFloat(balances.bnb || '0') : parseFloat(balances.wbnb || '0');
  const availableUsd = (rawAvailableToken * effectiveNativePrice).toFixed(2);

  // Compute native token amount from USD
  const computedTokenAmount = effectiveNativePrice > 0 ? (parseFloat(usdAmount || '0') / effectiveNativePrice).toFixed(6) : '0';

  const handleSetPercent = (pct: number) => {
    const totalUsd = parseFloat(availableUsd);
    if (totalUsd <= 0) return;
    const safeUsd = isWrap ? Math.max(0, totalUsd - 2.5) : totalUsd;
    setUsdAmount((safeUsd * (pct / 100)).toFixed(2));
  };

  const handleExecute = async () => {
    const tokenAmt = parseFloat(computedTokenAmount);
    if (!tokenAmt || tokenAmt <= 0) return;

    if (tokenAmt > rawAvailableToken) {
      setError(`Insufficient ${isWrap ? nativeSymbol : wrappedSymbol} balance (You have $${availableUsd} USD).`);
      return;
    }

    setIsLoading(true);
    setError(null);
    setTxHash(null);

    try {
      await exclusive(async () => {
      let hash = '';
      if (isWrap) {
        hash = await web3Service.wrapNative(wallet.address, computedTokenAmount, chainId);
      } else {
        hash = await web3Service.unwrapNative(wallet.address, computedTokenAmount, chainId);
      }
      setTxHash(hash);
      onRefreshBalances();
      });
    } catch (err: any) {
      console.error('Wrap/Unwrap error:', err);
      setError(err.message || 'Transaction failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150 select-text">
      <div className="bg-surface border border-surface-border rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-surface-border bg-surface-hover/30">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-theme-primary-10 text-theme-primary">
              <ArrowRightLeft className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base text-white">
                {isWrap ? `Wrap ${nativeSymbol} → ${wrappedSymbol}` : `Unwrap ${wrappedSymbol} → ${nativeSymbol}`}
              </h3>
              <p className="text-[11px] text-slate-400 font-mono">
                1 {nativeSymbol} ≈ ${formatTokenDisplay(effectiveNativePrice)} USD
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-surface-border transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Direction Switcher */}
        <div className="p-4 bg-background/50 border-b border-surface-border flex gap-2">
          <button
            onClick={() => {
              setDirection('WRAP');
              setError(null);
              setTxHash(null);
            }}
            className={`btn-tactile flex-1 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              isWrap ? 'bg-theme-primary text-slate-950 shadow-glow-primary' : 'text-slate-400 hover:text-white'
            }`}
          >
            Wrap ({nativeSymbol} → {wrappedSymbol})
          </button>
          <button
            onClick={() => {
              setDirection('UNWRAP');
              setError(null);
              setTxHash(null);
            }}
            className={`btn-tactile flex-1 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              !isWrap ? 'bg-theme-secondary text-white shadow-glow-secondary' : 'text-slate-400 hover:text-white'
            }`}
          >
            Unwrap ({wrappedSymbol} → {nativeSymbol})
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          
          <div>
            <div className="flex items-center justify-between text-xs text-slate-400 mb-1 font-mono">
              <span>Amount to {isWrap ? 'Wrap' : 'Unwrap'} (in USD)</span>
              <span className="text-theme-primary font-bold">
                ${formatUsdDisplay(availableUsd)} USD <span className="text-slate-500 font-normal">({formatTokenDisplay(rawAvailableToken)} {isWrap ? nativeSymbol : wrappedSymbol})</span>
              </span>
            </div>

            <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 flex items-center justify-between gap-2 focus-within:border-theme-primary">
              <div className="flex items-center gap-1.5 w-full">
                <span className="text-base font-bold text-slate-400 font-mono">$</span>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={usdAmount}
                  onChange={(e) => setUsdAmount(e.target.value)}
                  className="bg-transparent text-lg font-bold font-mono text-white focus:outline-none w-full"
                  placeholder="0.00"
                />
              </div>
              <span className="text-xs font-bold font-mono text-theme-primary shrink-0">
                ≈ {formatTokenDisplay(computedTokenAmount)} {isWrap ? nativeSymbol : wrappedSymbol}
              </span>
            </div>
          </div>

          {/* Quick % and USD chips */}
          <div className="space-y-2">
            <div className="flex gap-1.5 font-mono">
              {[25, 50, 75, 100].map((pct) => (
                <button
                  key={pct}
                  onClick={() => handleSetPercent(pct)}
                  className="btn-tactile flex-1 py-1 rounded-lg bg-slate-900 border border-slate-700 hover:border-theme-primary text-xs text-slate-300 hover:text-white cursor-pointer"
                >
                  {pct === 100 ? 'MAX' : `${pct}%`}
                </button>
              ))}
            </div>
            <div className="flex gap-1.5 font-mono">
              {['10', '25', '50', '100'].map((usd) => (
                <button
                  key={usd}
                  onClick={() => setUsdAmount(usd)}
                  className="btn-tactile flex-1 py-1 rounded-lg bg-slate-900/60 border border-slate-700 hover:border-theme-secondary text-xs text-slate-400 hover:text-white cursor-pointer"
                >
                  ${usd}
                </button>
              ))}
            </div>
          </div>

          <div className="p-3 rounded-xl bg-surface/50 border border-surface-border text-[11px] text-slate-400 leading-relaxed">
            CoW Protocol trades ERC-20 tokens directly. Wrapping converts native {nativeSymbol} 1:1 to {wrappedSymbol} without slippage on {chainConfig.name}.
          </div>

          {/* Status Messages */}
          {error && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {txHash && (
            <div className="p-3 rounded-xl bg-theme-primary-10 border border-theme-primary-30 text-xs text-theme-primary space-y-1">
              <div className="flex items-center gap-1.5 font-bold">
                <CheckCircle2 className="w-4 h-4 text-theme-primary" />
                <span>Transaction Successful!</span>
              </div>
              <p className="text-[11px] text-slate-300 break-all font-mono">
                Tx: {txHash.slice(0, 16)}...
              </p>
            </div>
          )}

          {/* Submit Button */}
          <button
            onClick={handleExecute}
            disabled={isLoading || !usdAmount || parseFloat(usdAmount) <= 0}
            className="btn-tactile w-full py-3.5 rounded-xl bg-theme-gradient text-slate-950 font-extrabold text-sm transition-all shadow-glow-primary disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-slate-950" />
                <span>Processing on {chainConfig.shortName}...</span>
              </>
            ) : (
              <span>Confirm {isWrap ? `Wrap to ${wrappedSymbol}` : `Unwrap to ${nativeSymbol}`} (${formatButtonUsd(usdAmount)})</span>
            )}
          </button>

        </div>

      </div>
    </div>
  );
};
