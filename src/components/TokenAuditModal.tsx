import { ModalDialog } from './ModalDialog';
import React, { useState, useEffect, useRef } from 'react';
import { 
  X, 
  RefreshCw, 
  ShieldCheck, 
  ShieldAlert, 
  ShieldX, 
  Percent, 
  FileCode, 
  Lock, 
  AlertOctagon, 
  AlertTriangle, 
  Droplets, 
  TrendingUp, 
  ExternalLink,
  Layers,
  Sparkles
} from 'lucide-react';
import { TokenConfig } from '../types/trading';
import { getChainConfig } from '../types/chains';
import { goPlusSecurityService, TokenSecurityReport } from '../services/goPlusSecurityService';
import { dexLiquidityService, TokenLiquidityReport } from '../services/dexLiquidityService';

interface TokenAuditModalProps {
  isOpen: boolean;
  onClose: () => void;
  token: TokenConfig;
  chainId: number;
}

export const TokenAuditModal: React.FC<TokenAuditModalProps> = (props) => props.isOpen
  ? <TokenAuditContent key={`${props.token.chainId || props.chainId}:${props.token.address.toLowerCase()}`} {...props} />
  : null;

const TokenAuditContent: React.FC<TokenAuditModalProps> = ({
  isOpen,
  onClose,
  token,
  chainId,
}) => {
  const [securityReport, setSecurityReport] = useState<TokenSecurityReport | null>(null);
  const [liquidityReport, setLiquidityReport] = useState<TokenLiquidityReport | null>(null);
  const [isLoadingSecurity, setIsLoadingSecurity] = useState<boolean>(false);
  const [isLoadingLiquidity, setIsLoadingLiquidity] = useState<boolean>(false);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [liquidityError, setLiquidityError] = useState<string | null>(null);
  const auditId = useRef(0);

  const effectiveChainId = token.chainId || chainId;
  const chainConfig = getChainConfig(effectiveChainId);

  const runAudit = async () => {
    if (!token.address) return;
    const requestId = ++auditId.current;
    setSecurityReport(null);
    setLiquidityReport(null);
    setIsLoadingLiquidity(true);
    setLiquidityError(null);

    // 1. Run GoPlus Security Scan
    setIsLoadingSecurity(true);
    setSecurityError(null);
    try {
      const sec = await goPlusSecurityService.checkTokenSecurity(token.address, effectiveChainId);
      if (auditId.current !== requestId) return;
      if (!sec) {
        setSecurityError(`Error [ERR_SECURITY_UNAVAILABLE]: GoPlus API returned no scan data for ${token.symbol} on ${chainConfig.name}.`);
      } else {
        setSecurityReport(sec);
      }
    } catch (err: any) {
      if (auditId.current === requestId) setSecurityError(err.message || `Error [ERR_SECURITY_FAILED]: Failed to audit token security.`);
    } finally {
      if (auditId.current === requestId) setIsLoadingSecurity(false);
    }

    // 2. Run DEX Liquidity Pool Scan
    if (auditId.current !== requestId) return;
    setIsLoadingLiquidity(true);
    setLiquidityError(null);
    try {
      const liq = await dexLiquidityService.fetchTokenLiquidity(token.address, effectiveChainId);
      if (auditId.current === requestId) setLiquidityReport(liq);
    } catch (err: any) {
      if (auditId.current === requestId) setLiquidityError(err.message || `Error [ERR_LIQUIDITY_FAILED]: Failed to fetch DEX liquidity.`);
    } finally {
      if (auditId.current === requestId) setIsLoadingLiquidity(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      runAudit();
    }
    return () => { auditId.current += 1; };
  }, [isOpen, token.address, effectiveChainId]);

  if (!isOpen) return null;

  return (
    <ModalDialog label="Token security and liquidity audit" onClose={onClose} busy={false}>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
      <div 
        className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 font-bold">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-100 flex items-center space-x-2">
                <span>Token Security & Liquidity Audit</span>
              </h2>
              <p className="text-[11px] text-slate-400">
                {token.symbol} ({token.name}) on <span className="text-indigo-400 font-medium">{chainConfig.name}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={runAudit}
              disabled={isLoadingSecurity || isLoadingLiquidity}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-50"
              title="Refresh Audit"
            >
              <RefreshCw className={`w-4 h-4 ${isLoadingSecurity || isLoadingLiquidity ? 'animate-spin' : ''}`} />
            </button>
            <button
              aria-label="Close" disabled={false} onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          
          {/* Token Summary Card */}
          <div className="p-3 bg-slate-950/60 border border-slate-800 rounded-lg flex items-center justify-between">
            <div className="flex items-center space-x-3">
              {token.logoUrl ? (
                <img src={token.logoUrl} alt={token.symbol} className="w-8 h-8 rounded-full" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-400 text-xs flex items-center justify-center font-bold">
                  {token.symbol.slice(0, 2)}
                </div>
              )}
              <div>
                <div className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
                  <span>{token.symbol}</span>
                  <span className="text-[10px] text-slate-400 font-normal">({token.name})</span>
                  {token.isAlpha && (
                    <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-amber-500/10 text-amber-300 flex items-center gap-0.5">
                      <Sparkles className="w-2.5 h-2.5" /> Alpha
                    </span>
                  )}
                </div>
                <div className="text-[10px] font-mono text-slate-400 truncate max-w-[280px]">
                  {token.address}
                </div>
              </div>
            </div>
            <a
              href={chainConfig.addressUrl(token.address)}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 px-2 py-1 bg-indigo-500/10 rounded-md transition-colors"
            >
              <span>Explorer</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          {/* 1. GOPLUS SECURITY AUDIT SECTION */}
          <div className="border border-slate-800 bg-slate-950/70 rounded-lg p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <ShieldCheck className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                  GoPlus Contract Security
                </span>
              </div>

              {isLoadingSecurity ? (
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
              ) : null}
            </div>

            {/* Error Banner with Retry */}
            {securityError && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start justify-between gap-2 text-xs text-red-300">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <span>{securityError}</span>
                </div>
                <button
                  onClick={runAudit}
                  className="px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded text-[11px] font-medium shrink-0"
                >
                  Retry Scan
                </button>
              </div>
            )}

            {/* Risk Reasons */}
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

            {/* Warning Reasons */}
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

            {/* Metrics Grid */}
            {securityReport && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
                {/* Honeypot */}
                <div className="p-2 rounded bg-slate-900/90 border border-slate-800">
                  <div className="text-[10px] uppercase font-medium text-slate-500">Honeypot</div>
                  <div className={`text-xs font-bold mt-0.5 ${securityReport.isHoneypot === null ? 'text-slate-400' : securityReport.isHoneypot ? 'text-red-400' : 'text-emerald-400'}`}>
                    {securityReport.isHoneypot === null ? 'Unknown' : securityReport.isHoneypot ? '🚨 Honeypot' : '✓ Clean'}
                  </div>
                </div>

                {/* Buy / Sell Tax */}
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

                {/* Open Source */}
                <div className="p-2 rounded bg-slate-900/90 border border-slate-800">
                  <div className="text-[10px] uppercase font-medium text-slate-500 flex items-center gap-1">
                    <FileCode className="w-2.5 h-2.5" /> Open Source
                  </div>
                  <div className={`text-xs font-bold mt-0.5 ${securityReport.isOpenSource === null ? 'text-slate-400' : securityReport.isOpenSource ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {securityReport.isOpenSource === null ? 'Unknown' : securityReport.isOpenSource ? '✓ Verified' : '⚠ Unverified'}
                  </div>
                </div>

                {/* Mintable */}
                <div className="p-2 rounded bg-slate-900/90 border border-slate-800">
                  <div className="text-[10px] uppercase font-medium text-slate-500">Mintable Supply</div>
                  <div className={`text-xs font-bold mt-0.5 ${securityReport.isMintable === null ? 'text-slate-400' : securityReport.isMintable ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {securityReport.isMintable === null ? 'Unknown' : securityReport.isMintable ? '⚠ Mintable' : '✓ Fixed'}
                  </div>
                </div>

                {/* Proxy */}
                <div className="p-2 rounded bg-slate-900/90 border border-slate-800">
                  <div className="text-[10px] uppercase font-medium text-slate-500 flex items-center gap-1">
                    <Lock className="w-2.5 h-2.5" /> Proxy Contract
                  </div>
                  <div className={`text-xs font-bold mt-0.5 ${securityReport.isProxy === null ? 'text-slate-400' : securityReport.isProxy ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {securityReport.isProxy === null ? 'Unknown' : securityReport.isProxy ? '⚠ Proxy' : '✓ Immutable'}
                  </div>
                </div>

                {/* Blacklist Function */}
                <div className="p-2 rounded bg-slate-900/90 border border-slate-800">
                  <div className="text-[10px] uppercase font-medium text-slate-500">Blacklist Function</div>
                  <div className={`text-xs font-bold mt-0.5 ${securityReport.isBlacklisted ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {securityReport.isBlacklisted ? '⚠ Present' : '✓ None'}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 2. DEX LIQUIDITY & POOL RESERVES SECTION */}
          <div className="border border-slate-800 bg-slate-950/70 rounded-lg p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Droplets className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                  Live DEX Liquidity & Reserves
                </span>
              </div>

              {isLoadingLiquidity ? (
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

            {/* Error Banner with Retry */}
            {liquidityError && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start justify-between gap-2 text-xs text-red-300">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <span>{liquidityError}</span>
                </div>
                <button
                  onClick={runAudit}
                  className="px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded text-[11px] font-medium shrink-0"
                >
                  Retry Scan
                </button>
              </div>
            )}

            {/* Liquidity Breakdown */}
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

                {/* Primary Pool Details */}
                {liquidityReport.primaryPool ? (
                  <div className="p-2.5 rounded bg-slate-900/60 border border-slate-800/80 space-y-1.5">
                    <div className="text-[11px] font-bold text-slate-300 flex items-center justify-between">
                      <span className="flex items-center gap-1">
                        <Layers className="w-3 h-3 text-indigo-400" />
                        Top Pool: {liquidityReport.primaryPool.name}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 uppercase">
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
                    <span>No active liquidity pools found on {chainConfig.name}. Trades may fail until liquidity is seeded.</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between">
          <div className="text-[11px] text-slate-500">
            Real-Time Audit: GoPlus Security & GeckoTerminal DEX Pools
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
    </ModalDialog>
  );
};
