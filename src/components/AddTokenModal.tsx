import { ModalDialog } from './ModalDialog';
import React, { useState, useEffect, useRef } from 'react';
import { 
  X, 
  Search, 
  CheckCircle2, 
  AlertTriangle, 
  ArrowRight, 
  ShieldCheck, 
  ShieldAlert, 
  ShieldX, 
  Percent, 
  FileCode, 
  Lock, 
  AlertOctagon,
  Sparkles,
  Globe,
  Droplets,
  TrendingUp,
  Layers,
  RefreshCw
} from 'lucide-react';
import { TokenConfig } from '../types/trading';
import { getChainConfig, SUPPORTED_CHAINS, ChainConfig } from '../types/chains';
import { web3Service } from '../services/web3Service';
import { storageService } from '../services/storageService';
import { marketDataService } from '../services/marketDataService';
import { goPlusSecurityService, TokenSecurityReport } from '../services/goPlusSecurityService';
import { dexLiquidityService, TokenLiquidityReport } from '../services/dexLiquidityService';
import { systemLogService } from '../services/systemLogService';

interface AddTokenModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTokenAdded: (token: TokenConfig) => void;
  chainId: number;
}

export const AddTokenModal: React.FC<AddTokenModalProps> = ({
  isOpen,
  onClose,
  onTokenAdded,
  chainId,
}) => {
  const [targetChainId, setTargetChainId] = useState<number>(chainId);
  const [addressInput, setAddressInput] = useState('');
  const [isInspecting, setIsInspecting] = useState(false);
  const [isScanningSecurity, setIsScanningSecurity] = useState(false);
  const [isScanningLiquidity, setIsScanningLiquidity] = useState(false);
  const [autoDetectedChain, setAutoDetectedChain] = useState<string | null>(null);
  const [resolvedToken, setResolvedToken] = useState<TokenConfig | null>(null);
  const [securityReport, setSecurityReport] = useState<TokenSecurityReport | null>(null);
  const [liquidityReport, setLiquidityReport] = useState<TokenLiquidityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inspectionId = useRef(0);

  const clearInspection = () => {
    inspectionId.current += 1;
    setResolvedToken(null);
    setSecurityReport(null);
    setLiquidityReport(null);
    setAutoDetectedChain(null);
    setError(null);
    setIsInspecting(false);
    setIsScanningSecurity(false);
    setIsScanningLiquidity(false);
  };

  // Reset/sync initial chain ID when modal opens
  useEffect(() => {
    clearInspection();
    if (isOpen) {
      setTargetChainId(chainId);
      setAddressInput('');
      setResolvedToken(null);
      setSecurityReport(null);
      setLiquidityReport(null);
      setAutoDetectedChain(null);
      setError(null);
    }
    return () => { inspectionId.current += 1; };
  }, [isOpen, chainId]);

  if (!isOpen) return null;

  const currentChainConfig = getChainConfig(targetChainId);

  const fetchAuditsForToken = (address: string, cId: number, requestId: number) => {
    // 1. GoPlus Security Scan
    setIsScanningSecurity(true);
    goPlusSecurityService.checkTokenSecurity(address, cId)
      .then((rep) => {
        if (inspectionId.current === requestId) setSecurityReport(rep);
      })
      .catch((err) => {
        systemLogService.logWarning('SECURITY', `Token Security Check Warning`, err?.message || String(err), cId);
      })
      .finally(() => {
        if (inspectionId.current === requestId) setIsScanningSecurity(false);
      });

    // 2. DEX Liquidity Scan
    setIsScanningLiquidity(true);
    dexLiquidityService.fetchTokenLiquidity(address, cId)
      .then((liq) => {
        if (inspectionId.current === requestId) setLiquidityReport(liq);
      })
      .catch((err) => {
        systemLogService.logWarning('NETWORK', `DEX Liquidity Check Warning`, err?.message || String(err), cId);
      })
      .finally(() => {
        if (inspectionId.current === requestId) setIsScanningLiquidity(false);
      });
  };

  const handleInspect = async (selectedChainId = targetChainId, allowAutoDetect = true) => {
    clearInspection();
    const requestId = inspectionId.current;
    const clean = addressInput.trim();
    if (!clean || !clean.startsWith('0x') || clean.length !== 42) {
      setError('Error [ERR_INVALID_ADDRESS]: Please enter a valid 42-character EVM contract address starting with 0x.');
      return;
    }

    setIsInspecting(true);
    setError(null);
    setResolvedToken(null);
    setSecurityReport(null);
    setLiquidityReport(null);
    setAutoDetectedChain(null);

    try {
      // 1. Check selected target chain first
      let foundMeta: TokenConfig | null = null;
      let effectiveChainId = selectedChainId;

      // Check Binance Alpha catalog on target chain
      const cachedAlpha = marketDataService.getAlphaTokenByAddress(clean, selectedChainId);
      if (cachedAlpha) {
        foundMeta = cachedAlpha;
      } else {
        try {
          const alphas = await marketDataService.fetchBinanceAlphaTokens(selectedChainId);
          const liveAlpha = alphas.find((a) => a.address.toLowerCase() === clean.toLowerCase());
          if (liveAlpha) foundMeta = liveAlpha;
        } catch (alphaErr: any) {
          console.warn(`Alpha catalog query note for ${clean}:`, alphaErr?.message || alphaErr);
        }
      }

      // Check RPC for target chain
      if (!foundMeta) {
        try {
          const meta = await web3Service.getTokenMetadata(clean, selectedChainId);
          if (meta) foundMeta = meta;
        } catch (metaErr: any) {
          console.warn(`RPC metadata query note for ${clean}:`, metaErr?.message || metaErr);
        }
      }

      // 2. If not found on target chain, probe ALL 5 chains concurrently with Promise.all
      if (!foundMeta && allowAutoDetect) {
        const allChains = Object.values(SUPPORTED_CHAINS);
        
        const probeResults = await Promise.all(
          allChains.map(async (c: ChainConfig) => {
            try {
              // Check Alpha cache
              const alphaCand = marketDataService.getAlphaTokenByAddress(clean, c.chainId);
              if (alphaCand) return { chainId: c.chainId, meta: alphaCand };

              // Check RPC
              const candMeta = await web3Service.getTokenMetadata(clean, c.chainId);
              if (candMeta) return { chainId: c.chainId, meta: candMeta };
            } catch (probeErr: any) {
              console.warn(`Probe note on chain ${c.chainId}:`, probeErr?.message || probeErr);
            }
            return null;
          })
        );

        if (inspectionId.current !== requestId) return;
        const match = probeResults.find((r) => r !== null);
        if (match) {
          foundMeta = match.meta;
          effectiveChainId = match.chainId;
          setTargetChainId(match.chainId);
          setAutoDetectedChain(getChainConfig(match.chainId).name);
        }
      }

      if (inspectionId.current !== requestId) return;
      if (!foundMeta) {
        throw new Error(
          `Error [ERR_NOT_FOUND]: Contract ${clean} was not found or does not implement standard ERC-20 symbol/decimals on ${getChainConfig(selectedChainId).name}${allowAutoDetect ? ' or any other supported network' : ''}. Please verify the address and try again.`
        );
      }

      setResolvedToken({ ...foundMeta, address: clean, chainId: effectiveChainId });
      fetchAuditsForToken(clean, effectiveChainId, requestId);
    } catch (err: any) {
      systemLogService.logWarning('WALLET', `Token Inspection Failed: ${clean}`, err?.message || String(err), targetChainId);
      if (inspectionId.current === requestId) setError(err.message || 'Error [ERR_INSPECT_FAILED]: Failed to inspect token contract.');
    } finally {
      if (inspectionId.current === requestId) setIsInspecting(false);
    }
  };

  const handleImport = () => {
    if (!resolvedToken || isInspecting || resolvedToken.chainId !== targetChainId || resolvedToken.address.toLowerCase() !== addressInput.trim().toLowerCase()) return;
    const finalToken: TokenConfig = {
      ...resolvedToken,
      chainId: targetChainId,
    };
    storageService.addCustomToken(finalToken);
    onTokenAdded(finalToken);
    setAddressInput('');
    setResolvedToken(null);
    setSecurityReport(null);
    setLiquidityReport(null);
    setAutoDetectedChain(null);
    setError(null);
    onClose();
  };

  const handleClose = () => {
    clearInspection();
    setAddressInput('');
    setResolvedToken(null);
    setSecurityReport(null);
    setLiquidityReport(null);
    setAutoDetectedChain(null);
    setError(null);
    onClose();
  };

  return (
    <ModalDialog label="Import token" onClose={handleClose} busy={false}>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
      <div 
        className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between bg-slate-950/50">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold">
              +
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-100 flex items-center space-x-2">
                <span>Import Token by Contract Address</span>
              </h2>
              <p className="text-[11px] text-slate-400">
                Network: <span className="text-indigo-400 font-medium">{currentChainConfig.name}</span>
              </p>
            </div>
          </div>
          <button
            aria-label="Close" disabled={false} onClick={handleClose}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          
          {/* Network Selection Bar */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-slate-400" />
                Target Network
              </span>
              <span className="text-[10px] text-slate-500 font-normal">
                (Auto-detects across all chains)
              </span>
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
              {Object.values(SUPPORTED_CHAINS).map((c) => (
                <button
                  key={c.chainId}
                  type="button"
                  onClick={() => {
                    setTargetChainId(c.chainId);
                    clearInspection();
                    if (addressInput.trim().length === 42) void handleInspect(c.chainId, false);
                  }}
                  className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition-all text-center ${
                    targetChainId === c.chainId
                      ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300 shadow-sm'
                      : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                  }`}
                >
                  {c.shortName}
                </button>
              ))}
            </div>
          </div>

          {/* Contract Address Input */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">
              Contract Address
            </label>
            <div className="flex space-x-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={addressInput}
                  onChange={(e) => {
                    setAddressInput(e.target.value);
                    clearInspection();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleInspect();
                  }}
                  placeholder="0x..."
                  className="w-full pl-3 pr-3 py-2 bg-slate-950/60 border border-slate-700/60 rounded-lg text-xs font-mono text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <button
                onClick={() => void handleInspect()}
                disabled={isInspecting || !addressInput.trim()}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors flex items-center space-x-1.5 shrink-0"
              >
                {isInspecting ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Inspecting...</span>
                  </>
                ) : (
                  <>
                    <Search className="w-3.5 h-3.5" />
                    <span>Inspect</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Auto-detected notification badge */}
          {autoDetectedChain && (
            <div className="p-2.5 bg-cyan-500/10 border border-cyan-500/30 rounded-lg flex items-center space-x-2 text-xs text-cyan-300">
              <Globe className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>
                Contract was auto-detected on <strong className="text-white">{autoDetectedChain}</strong>! Network switched automatically.
              </span>
            </div>
          )}

          {/* Error Message with Retry */}
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start justify-between gap-2 text-xs text-red-300">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
              <button
                onClick={() => void handleInspect()}
                className="px-2.5 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-200 rounded text-[11px] font-medium shrink-0 flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Retry</span>
              </button>
            </div>
          )}

          {/* Resolved Token Card */}
          {resolvedToken && (
            <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2.5">
                  <div className="w-9 h-9 rounded-full bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center font-bold text-indigo-400 text-sm">
                    {resolvedToken.symbol.slice(0, 3)}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-slate-100 flex items-center space-x-2">
                      <span>{resolvedToken.symbol}</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-400 font-normal">
                        Valid ERC-20
                      </span>
                      {resolvedToken.isAlpha && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-300 font-normal flex items-center gap-1">
                          <Sparkles className="w-2.5 h-2.5" /> Alpha
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">{resolvedToken.name}</div>
                  </div>
                </div>
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800/80 text-xs">
                <div>
                  <span className="text-slate-500">Decimals:</span>
                  <span className="ml-1.5 font-mono text-slate-300">{resolvedToken.decimals}</span>
                </div>
                <div>
                  <span className="text-slate-500">Network:</span>
                  <span className="ml-1.5 text-slate-300">{currentChainConfig.name}</span>
                </div>
                <div className="col-span-2 truncate">
                  <span className="text-slate-500">Address:</span>
                  <span className="ml-1.5 font-mono text-slate-400 text-[11px]">{resolvedToken.address}</span>
                </div>
              </div>
            </div>
          )}

          {/* 1. GoPlus Security Audit Section */}
          {resolvedToken && (
            <div className="border border-slate-800 bg-slate-950/70 rounded-lg p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <ShieldCheck className="w-4 h-4 text-cyan-400" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                    GoPlus Security Audit
                  </span>
                </div>

                {isScanningSecurity ? (
                  <div className="flex items-center space-x-1.5 text-xs text-slate-400">
                    <div className="w-3 h-3 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
                    <span className="text-[11px]">Scanning...</span>
                  </div>
                ) : securityReport ? (
                  <div>
                    {securityReport.riskScore === 'SAFE' && (
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        SAFE / LOW RISK
                      </span>
                    )}
                    {securityReport.riskScore === 'WARNING' && (
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30 flex items-center gap-1">
                        <ShieldAlert className="w-3.5 h-3.5" />
                        CAUTION
                      </span>
                    )}
                    {securityReport.riskScore === 'DANGER' && (
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-red-500/15 text-red-400 border border-red-500/30 flex items-center gap-1">
                        <ShieldX className="w-3.5 h-3.5" />
                        HIGH RISK / DANGER
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-[11px] text-slate-500">Scan Unavailable</span>
                )}
              </div>

              {/* Critical Danger Alert Banner */}
              {securityReport && securityReport.riskReasons.length > 0 && (
                <div className="p-2.5 bg-red-500/10 border border-red-500/30 rounded-lg space-y-1 text-xs text-red-300">
                  <div className="font-semibold flex items-center gap-1.5 text-red-400">
                    <AlertOctagon className="w-3.5 h-3.5 text-red-400 shrink-0" />
                    Critical Vulnerabilities Detected:
                  </div>
                  <ul className="list-disc list-inside space-y-0.5 text-[11px] pl-1">
                    {securityReport.riskReasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Warning Alert Banner */}
              {securityReport && securityReport.warningReasons.length > 0 && (
                <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg space-y-1 text-xs text-amber-300">
                  <div className="font-semibold flex items-center gap-1.5 text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    Contract Warnings:
                  </div>
                  <ul className="list-disc list-inside space-y-0.5 text-[11px] pl-1">
                    {securityReport.warningReasons.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Security Metrics Breakdown Grid */}
              {securityReport && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
                  <div className="p-2 rounded bg-slate-900/90 border border-slate-800">
                    <div className="text-[10px] uppercase font-medium text-slate-500">Honeypot</div>
                    <div className={`text-xs font-bold mt-0.5 ${securityReport.isHoneypot === null ? 'text-slate-400' : securityReport.isHoneypot ? 'text-red-400' : 'text-emerald-400'}`}>
                      {securityReport.isHoneypot === null ? 'Unknown' : securityReport.isHoneypot ? '🚨 Honeypot' : '✓ Clean'}
                    </div>
                  </div>

                  <div className="p-2 rounded bg-slate-900/90 border border-slate-800">
                    <div className="text-[10px] uppercase font-medium text-slate-500 flex items-center gap-1">
                      <Percent className="w-2.5 h-2.5" /> Buy / Sell Tax
                    </div>
                    <div className={`text-xs font-mono font-bold mt-0.5 ${
                      securityReport.buyTax === null || securityReport.sellTax === null ? 'text-slate-400' : (securityReport.buyTax ?? 0) > 10 || (securityReport.sellTax ?? 0) > 10
                        ? 'text-red-400' 
                        : (securityReport.buyTax ?? 0) > 5 || (securityReport.sellTax ?? 0) > 5
                        ? 'text-amber-400' 
                        : 'text-emerald-400'
                    }`}>
                      {securityReport.buyTax === null ? 'Unknown' : `${securityReport.buyTax.toFixed(1)}%`} / {securityReport.sellTax === null ? 'Unknown' : `${securityReport.sellTax.toFixed(1)}%`}
                    </div>
                  </div>

                  <div className="p-2 rounded bg-slate-900/90 border border-slate-800">
                    <div className="text-[10px] uppercase font-medium text-slate-500 flex items-center gap-1">
                      <FileCode className="w-2.5 h-2.5" /> Open Source
                    </div>
                    <div className={`text-xs font-bold mt-0.5 ${securityReport.isOpenSource === null ? 'text-slate-400' : securityReport.isOpenSource ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {securityReport.isOpenSource === null ? 'Unknown' : securityReport.isOpenSource ? '✓ Verified' : '⚠ Unverified'}
                    </div>
                  </div>

                  <div className="p-2 rounded bg-slate-900/90 border border-slate-800">
                    <div className="text-[10px] uppercase font-medium text-slate-500">Mintable Supply</div>
                    <div className={`text-xs font-bold mt-0.5 ${securityReport.isMintable === null ? 'text-slate-400' : securityReport.isMintable ? 'text-amber-400' : 'text-emerald-400'}`}>
                      {securityReport.isMintable === null ? 'Unknown' : securityReport.isMintable ? '⚠ Mintable' : '✓ Fixed'}
                    </div>
                  </div>

                  <div className="p-2 rounded bg-slate-900/90 border border-slate-800">
                    <div className="text-[10px] uppercase font-medium text-slate-500 flex items-center gap-1">
                      <Lock className="w-2.5 h-2.5" /> Proxy Contract
                    </div>
                    <div className={`text-xs font-bold mt-0.5 ${securityReport.isProxy === null ? 'text-slate-400' : securityReport.isProxy ? 'text-amber-400' : 'text-emerald-400'}`}>
                      {securityReport.isProxy === null ? 'Unknown' : securityReport.isProxy ? '⚠ Proxy' : '✓ Immutable'}
                    </div>
                  </div>

                  <div className="p-2 rounded bg-slate-900/90 border border-slate-800">
                    <div className="text-[10px] uppercase font-medium text-slate-500">Blacklist Function</div>
                    <div className={`text-xs font-bold mt-0.5 ${securityReport.isBlacklisted ? 'text-amber-400' : 'text-emerald-400'}`}>
                      {securityReport.isBlacklisted ? '⚠ Present' : '✓ None'}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 2. DEX Liquidity & Reserves Section */}
          {resolvedToken && (
            <div className="border border-slate-800 bg-slate-950/70 rounded-lg p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Droplets className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                    DEX Liquidity & Reserves
                  </span>
                </div>

                {isScanningLiquidity ? (
                  <div className="flex items-center space-x-1.5 text-xs text-slate-400">
                    <div className="w-3 h-3 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin" />
                    <span className="text-[11px]">Querying Pools...</span>
                  </div>
                ) : liquidityReport ? (
                  <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                    liquidityReport.totalReserveUsd > 10000
                      ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                      : liquidityReport.totalReserveUsd > 0
                      ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                      : 'bg-red-500/15 text-red-400 border border-red-500/30'
                  }`}>
                    {liquidityReport.totalReserveUsd > 10000 
                      ? '✓ HIGH LIQUIDITY' 
                      : liquidityReport.totalReserveUsd > 0 
                      ? '⚠ LOW LIQUIDITY' 
                      : '🚨 NO DEX POOLS'}
                  </span>
                ) : null}
              </div>

              {liquidityReport && (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2.5 rounded bg-slate-900/90 border border-slate-800">
                      <div className="text-[10px] uppercase font-medium text-slate-500 flex items-center gap-1">
                        <Droplets className="w-3 h-3 text-cyan-400" /> Total DEX Reserve
                      </div>
                      <div className="text-sm font-bold font-mono text-white mt-1">
                        ${liquidityReport.totalReserveUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
                      </div>
                    </div>

                    <div className="p-2.5 rounded bg-slate-900/90 border border-slate-800">
                      <div className="text-[10px] uppercase font-medium text-slate-500 flex items-center gap-1">
                        <TrendingUp className="w-3 h-3 text-emerald-400" /> 24h Trading Volume
                      </div>
                      <div className="text-sm font-bold font-mono text-white mt-1">
                        ${liquidityReport.totalVolume24h.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
                      </div>
                    </div>
                  </div>

                  {liquidityReport.primaryPool ? (
                    <div className="p-2.5 rounded bg-slate-900/60 border border-slate-800/80 space-y-1.5">
                      <div className="text-[11px] font-bold text-slate-300 flex items-center justify-between">
                        <span className="flex items-center gap-1">
                          <Layers className="w-3 h-3 text-indigo-400" />
                          Top Pool: {liquidityReport.primaryPool.name}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 uppercase font-mono">
                          {liquidityReport.primaryPool.dexId}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 flex items-center justify-between font-mono">
                        <span>Reserve: ${liquidityReport.primaryPool.reserveUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        <span>24h Vol: ${liquidityReport.primaryPool.volume24h.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="p-2.5 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-300 flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                      <span>No active DEX pools found on {currentChainConfig.name}. Trades may fail until liquidity is provided.</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="p-2.5 bg-slate-950/40 border border-slate-800 rounded-lg flex items-start space-x-2 text-[11px] text-slate-400">
            <ShieldCheck className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
            <span>
              Imported tokens are saved locally for that network and immediately ready for Live Charts, 1-Push Trading, and Strategies.
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-800 bg-slate-950/50 flex items-center justify-between">
          <div className="text-[11px] text-slate-500">
            GoPlus Security & GeckoTerminal DEX Liquidity
          </div>
          <div className="flex items-center space-x-2.5">
            <button
              onClick={handleClose}
              className="px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleImport}
              disabled={!resolvedToken}
              className={`px-4 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors flex items-center space-x-1.5 shadow-sm ${
                securityReport?.riskScore === 'DANGER'
                  ? 'bg-red-600 hover:bg-red-500'
                  : 'bg-emerald-600 hover:bg-emerald-500'
              }`}
            >
              <span>Import & Set Active</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
    </ModalDialog>
  );
};
