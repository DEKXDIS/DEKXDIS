import React, { useState } from 'react';
import { 
  Wallet, 
  Copy, 
  Check, 
  QrCode, 
  Key, 
  RefreshCw, 
  ArrowRightLeft, 
  ExternalLink,
  LogIn,
  Sparkles,
  Lock
} from 'lucide-react';
import { WalletState, WalletValuation, Balances, AllowanceState, MarketPrice, TokenConfig } from '../types/trading';
import { useFreshTimestamp } from '../hooks/useFreshTimestamp';
import { getChainConfig, DEFAULT_CHAIN_ID } from '../types/chains';
import { formatAssetDisplay, formatTokenDisplay, formatUsdDisplay } from '../utils/displayFormat';

interface WalletCardProps {
  embedded?: boolean;
  wallet: WalletState | null;
  balances: Balances;
  walletValuation?: WalletValuation;
  allowances: AllowanceState;
  marketPrice: MarketPrice;
  nativePrice?: number;
  chainId?: number;
  selectedToken?: TokenConfig;
  onGenerateWallet: () => void;
  onOpenImportModal: () => void;
  onOpenExportModal: () => void;
  onOpenQrModal: () => void;
  onOpenWrapModal: () => void;
  onRefreshBalances: () => void;
  onApproveToken: (tokenAddress: string) => Promise<void>;
  isApproving: boolean;
}

export const WalletCard: React.FC<WalletCardProps> = ({
  embedded = false,
  wallet,
  balances,
  walletValuation,
  marketPrice,
  nativePrice,
  chainId = DEFAULT_CHAIN_ID,
  selectedToken,
  onGenerateWallet,
  onOpenImportModal,
  onOpenExportModal,
  onOpenQrModal,
  onOpenWrapModal,
  onRefreshBalances,
}) => {
  const [copied, setCopied] = useState(false);
  const chainConfig = getChainConfig(chainId);

  const handleCopyAddress = () => {
    if (!wallet) return;
    navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shortenAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const effectiveNativePrice = (nativePrice && nativePrice > 0) ? nativePrice : 0;
  const nativeBal = parseFloat(balances.bnb || '0');
  const wrappedBal = parseFloat(balances.wbnb || '0');
  const nativeUsd = nativeBal === 0 ? '0.00' : effectiveNativePrice > 0 ? (nativeBal * effectiveNativePrice).toFixed(2) : undefined;
  const wrappedUsd = wrappedBal === 0 ? '0.00' : effectiveNativePrice > 0 ? (wrappedBal * effectiveNativePrice).toFixed(2) : undefined;

  const nativeSymbol = chainConfig.nativeToken.symbol;
  const wrappedSymbol = chainConfig.nativeToken.wrappedSymbol;
  const usdtSymbol = chainConfig.usdtToken.symbol;
  const valuation = walletValuation?.chainId === chainId && walletValuation.ownerAddress.toLowerCase() === wallet?.address.toLowerCase() ? walletValuation : undefined;
  const total = valuation?.totalUsdValue;
  const valuationFresh = useFreshTimestamp(valuation?.updatedAt, 60000);
  const valuationStale = !!valuation?.error || !!balances.error || !valuationFresh;
  const validTotal = total !== undefined && /^\d+(\.\d+)?$/.test(total) && Number.isFinite(Number(total));
  const stablePrice = !valuationStale ? valuation?.tokenPricesUsd?.[chainConfig.usdtToken.address.toLowerCase()] : undefined;
  const stableUsd = Number(balances.usdt) === 0 ? 0 : stablePrice !== undefined ? Number(balances.usdt) * stablePrice : undefined;

  if (!wallet) {
    return (
      <div className={embedded ? 'p-4 flex flex-col' : 'bg-surface/90 border border-surface-border rounded-xl p-4 shadow-lg flex flex-col justify-between h-full min-h-0'}>
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="p-1.5 rounded-lg bg-theme-primary-10 border border-theme-primary-30 text-theme-primary">
              <Wallet className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-xs font-bold text-white uppercase tracking-wider">Trading Wallet</h2>
              <p className="text-[10px] text-slate-400">{chainConfig.name} local encrypted wallet</p>
            </div>
          </div>

          <div className="space-y-2 mt-4">
            <button
              onClick={onGenerateWallet}
              className="btn-tactile w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-theme-gradient text-slate-950 font-extrabold text-xs transition-all shadow-glow-primary cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Create Instant Wallet</span>
            </button>

            <button
              onClick={onOpenImportModal}
              className="btn-tactile w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-200 font-semibold text-xs border border-slate-700 transition-all cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5 text-slate-400" />
              <span>Import Private Key / Seed</span>
            </button>
          </div>
        </div>

        <div className="p-2 rounded-lg bg-background/50 border border-surface-border text-[10px] text-slate-400 flex items-start gap-1.5 mt-3">
          <Lock className="w-3 h-3 text-slate-500 mt-0.5 shrink-0" />
          <span>Windows-encrypted local keys. Back up your private key before depositing {nativeSymbol}.</span>
        </div>
      </div>
    );
  }

  return (
    <div className={embedded ? 'p-3.5 flex flex-col' : 'bg-surface/90 border border-surface-border rounded-xl p-3.5 shadow-lg flex flex-col justify-between h-full min-h-0 overflow-y-auto'}>
      
      <div>
        {/* Top Header */}
        <div className="flex items-center justify-between gap-1 mb-2.5 shrink-0">
          <div className="flex items-center gap-1.5">
            <div className="p-1 rounded-lg bg-theme-primary-10 text-theme-primary">
              <Wallet className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold text-white">Wallet</span>
                <span className="text-[9px] px-1 py-0.2 rounded bg-theme-primary-10 text-theme-primary border border-theme-primary-30 font-mono">
                  {chainConfig.shortName}
                </span>
              </div>
              
              {/* Address with copy & QR */}
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[10px] font-mono text-slate-300">
                  {shortenAddress(wallet.address)}
                </span>
                <button
                  onClick={handleCopyAddress}
                  className="btn-tactile text-slate-400 hover:text-white transition-colors cursor-pointer"
                  title="Copy Full Address"
                >
                  {copied ? <Check className="w-3 h-3 text-theme-primary" /> : <Copy className="w-3 h-3" />}
                </button>
                <button
                  onClick={onOpenQrModal}
                  className="btn-tactile text-slate-400 hover:text-theme-primary transition-colors cursor-pointer"
                  title="Deposit QR"
                >
                  <QrCode className="w-3 h-3" />
                </button>
                <a
                  href={chainConfig.addressUrl(wallet.address)}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-tactile text-slate-400 hover:text-theme-secondary transition-colors cursor-pointer"
                  title={`View on ${chainConfig.explorerName}`}
                >
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={onRefreshBalances}
              disabled={balances.isLoading}
              title="Refresh Balances"
              className="btn-tactile p-1 rounded-lg bg-slate-900 border border-slate-700 text-slate-400 hover:text-white hover:border-theme-primary transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${balances.isLoading ? 'animate-spin text-theme-primary' : ''}`} />
            </button>
            <button
              onClick={onOpenExportModal}
              title="Backup Key / Seed Phrase"
              className="btn-tactile p-1 rounded-lg bg-slate-900 border border-slate-700 text-slate-400 hover:text-theme-secondary hover:border-theme-secondary transition-colors cursor-pointer"
            >
              <Key className="w-3 h-3" />
            </button>
          </div>
        </div>

        {balances.error && <p role="alert" className="mb-2 break-words text-xs text-red-300">
          {balances.error} Displayed amounts have not been refreshed.
        </p>}
        {/* Portfolio USD Value */}
        <div className="bg-slate-950/80 border border-surface-border rounded-xl p-2.5 mb-2.5 flex items-center justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider font-mono">
            Wallet total · {chainConfig.shortName}
          </span>
          <span className="text-base font-bold font-mono text-theme-primary">
            {validTotal ? `$${formatUsdDisplay(total)} USD` : 'Unavailable'}
            {valuationStale && <span className="block text-[10px] font-normal text-amber-300" title={valuation?.error}>
              {validTotal ? 'Last known · stale' : 'Value unavailable'} · <button type="button" className="underline" disabled={balances.isLoading} onClick={onRefreshBalances}>Retry</button>
            </span>}
          </span>
        </div>

        {/* Token Balance Breakdown */}
        <div className="space-y-1.5 mb-2.5">
          {/* Native Token */}
          <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-surface-border text-xs">
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-4 rounded-full bg-theme-primary-10 border border-theme-primary-30 flex items-center justify-center text-[8px] font-bold text-theme-primary font-mono">
                {nativeSymbol.slice(0, 1)}
              </div>
              <div>
                <span className="font-bold text-white text-[11px] block">{nativeSymbol}</span>
                <span className="text-[9px] text-slate-400 font-mono">{formatTokenDisplay(balances.bnb || 0)} {nativeSymbol}</span>
              </div>
            </div>
            <div className="text-right flex items-center gap-2">
              <span className="font-bold font-mono text-slate-100 text-xs block">{nativeUsd !== undefined ? `$${nativeUsd} USD` : 'USD unavailable'}</span>
              <button
                onClick={onOpenWrapModal}
                className="btn-tactile px-2 py-0.5 rounded bg-theme-primary-10 hover:bg-theme-primary-20 border border-theme-primary-30 text-[10px] text-theme-primary font-medium inline-flex items-center gap-1 cursor-pointer transition-colors"
              >
                <ArrowRightLeft className="w-2.5 h-2.5" /> Wrap
              </button>
            </div>
          </div>

          {/* Wrapped Native */}
          <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-surface-border text-xs">
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-4 rounded-full bg-theme-secondary-10 border border-theme-secondary-30 flex items-center justify-center text-[8px] font-bold text-theme-secondary font-mono">
                W
              </div>
              <div>
                <span className="font-bold text-white text-[11px] block">{wrappedSymbol}</span>
                <span className="text-[9px] text-slate-400 font-mono">{formatTokenDisplay(balances.wbnb || 0)} {wrappedSymbol}</span>
              </div>
            </div>
            <div className="text-right flex items-center gap-2">
              <span className="font-bold font-mono text-slate-100 text-xs block">{wrappedUsd !== undefined ? `$${wrappedUsd} USD` : 'USD unavailable'}</span>
              <button
                onClick={onOpenWrapModal}
                className="btn-tactile px-2 py-0.5 rounded bg-theme-secondary-10 hover:bg-theme-secondary-20 border border-theme-secondary-30 text-[10px] text-theme-secondary font-medium inline-flex items-center gap-1 cursor-pointer transition-colors"
              >
                <ArrowRightLeft className="w-2.5 h-2.5" /> Unwrap
              </button>
            </div>
          </div>

          {/* USDT */}
          <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-surface-border text-xs">
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-4 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-[8px] font-bold text-emerald-400 font-mono">
                $
              </div>
              <div>
                <span className="font-bold text-white text-[11px] block">{usdtSymbol}</span>
                <span className="text-[9px] text-slate-400 font-mono">{formatUsdDisplay(balances.usdt || 0)} {usdtSymbol}</span>
              </div>
            </div>
            <div className="text-right">
              <span className="font-bold font-mono text-emerald-400 text-xs block">{stableUsd !== undefined && Number.isFinite(stableUsd) ? `$${formatUsdDisplay(stableUsd)} USD` : 'USD value unavailable'}</span>
            </div>
          </div>

          {/* Active Selected Token (if not native/wrapped/usdt) */}
          {selectedToken && selectedToken.address.toLowerCase() !== chainConfig.nativeToken.wrappedAddress.toLowerCase() && selectedToken.address.toLowerCase() !== chainConfig.usdtToken.address.toLowerCase() && (
            <div className="flex items-center justify-between p-2 rounded-lg bg-cyan-950/20 border border-cyan-500/30 text-xs">
              <div className="flex items-center gap-1.5">
                <div className="w-4 h-4 rounded-full bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-[8px] font-bold text-cyan-400 font-mono">
                  {selectedToken.symbol.slice(0, 1)}
                </div>
                <div>
                  <span className="font-bold text-white text-[11px] block">{selectedToken.symbol}</span>
                  <span className="text-[9px] text-slate-400 font-mono">
                    {formatAssetDisplay(balances.tokenBalances?.[selectedToken.address.toLowerCase()] || balances.tokenBalances?.[selectedToken.symbol] || 0, selectedToken.symbol)} {selectedToken.symbol}
                  </span>
                </div>
              </div>
              <div className="text-right">
                <span className="font-bold font-mono text-cyan-400 text-xs block">
                  ${formatUsdDisplay(parseFloat(balances.tokenBalances?.[selectedToken.address.toLowerCase()] || balances.tokenBalances?.[selectedToken.symbol] || '0') * (marketPrice.price || 0))} USD
                </span>
              </div>
            </div>
          )}
        </div>

      </div>

      {/* Bottom Deposit CTA */}
      <div className="pt-2 border-t border-surface-border flex items-center justify-between text-[11px] text-slate-400 shrink-0">
        <button
          onClick={onOpenQrModal}
          className="text-bnb-yellow hover:text-amber-400 font-medium flex items-center gap-1 transition-colors"
        >
          <QrCode className="w-3 h-3" />
          <span>Deposit {nativeSymbol}</span>
        </button>
        <button
          onClick={onOpenImportModal}
          className="text-slate-400 hover:text-white transition-colors text-[10px]"
        >
          Switch Wallet
        </button>
      </div>

    </div>
  );
};
