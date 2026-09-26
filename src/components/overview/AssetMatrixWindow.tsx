import { ModalDialog } from '../ModalDialog';
import { assetTransferQuote } from '../../services/assetTransferQuote';
import { AssetSendModal, AssetSendHistory } from './AssetSendModal';
import { exclusive } from '../../services/executionEngine';
import { bridgeJournal, bridgeStatusMessage } from '../../services/bridgeJournal';
import { CowQuoteResponse } from '../../types/trading';
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { 
  TokenConfig, 
  WalletState 
} from '../../types/trading';
import { 
  SUPPORTED_CHAINS, 
  getChainConfig, 
  getDefaultTokensForChain 
} from '../../types/chains';
import { ChainBalanceReport, web3Service } from '../../services/web3Service';
import { crossChainBridgeService, BridgeQuote } from '../../services/crossChainBridgeService';
import { cowProtocol } from '../../services/cowProtocol';
import { marketDataService } from '../../services/marketDataService';
import { storageService } from '../../services/storageService';
import { systemLogService } from '../../services/systemLogService';
import { ethers } from 'ethers';
import { formatAssetDisplay, formatTokenDisplay, formatUsdDisplay } from '../../utils/displayFormat';
import { operationErrorDetails } from '../../utils/operationError';
import { 
  QrCode, 
  ArrowRight, 
  ArrowLeft, 
  ArrowRightLeft, 
  X, 
  Loader2, 
  Coins,
  AlertCircle
} from 'lucide-react';

const matrixUsd = (value: number | null | undefined) => value !== null && value !== undefined && Number.isFinite(value) ? `${formatUsdDisplay(value)} USD` : 'USD unavailable';

export interface SelectedMatrixToken {
  token: TokenConfig;
  chainId: number;
  balance: string;
  usdValue: number | null;
  chainIndex: number; // 0 to 4
  category: 'native' | 'wrapped' | 'usdt' | 'custom';
}

interface AssetMatrixWindowProps {
  wallet: WalletState | null;
  chainBalances: Record<number, ChainBalanceReport>;
  trackedTokens?: TokenConfig[];
  customTokens?: TokenConfig[];
  onOpenDepositModal: (chainId: number) => void;
  onRefreshBalances: () => void;
}

export const AssetMatrixWindow: React.FC<AssetMatrixWindowProps> = ({
  wallet,
  chainBalances,
  trackedTokens = [],
  customTokens = [],
  onOpenDepositModal,
  onRefreshBalances,
}) => {
  // Token selection states
  const [token1, setToken1] = useState<SelectedMatrixToken | null>(null);
  const [token2, setToken2] = useState<SelectedMatrixToken | null>(null);

  // Swap Modal state
  const [isSwapModalOpen, setIsSwapModalOpen] = useState<boolean>(false);
  const [swapAmountUsd, setSwapAmountUsd] = useState<string>('50');
  const [bridgeQuote, setBridgeQuote] = useState<(BridgeQuote & { cowQuote?: CowQuoteResponse; inputKey?: string }) | null>(null);
  const [isLoadingQuote, setIsLoadingQuote] = useState<boolean>(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState<boolean>(false);

  // In-place processing status on matrix tokens: 'idle' | 'processing' | 'completed' | 'failed'
  const [activeSwapStatus, setActiveSwapStatus] = useState<'idle' | 'processing' | 'completed' | 'failed'>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');

  useEffect(() => {
    if (activeSwapStatus !== 'failed') return;
    const timer = setTimeout(() => { setActiveSwapStatus('idle'); setStatusMessage(''); }, 30000);
    return () => clearTimeout(timer);
  }, [activeSwapStatus]);

  const executionLock = useRef(false);
  const quoteGeneration = useRef(0);
  const [maxSelected, setMaxSelected] = useState(false);
  const amountInput = maxSelected ? 'MAX' : swapAmountUsd;
  const inputKey = JSON.stringify([wallet?.address, token1?.chainId, token1?.token.address, token1?.category, token2?.chainId, token2?.token.address, token2?.category, amountInput]);
  const latestInput = useRef(inputKey); latestInput.current = inputKey;
  const [transfers, setTransfers] = useState(() => wallet ? bridgeJournal.all(wallet.address) : []);
  const [activeBridgeHash, setActiveBridgeHash] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setTransfers(wallet ? bridgeJournal.all(wallet.address) : []);
    update(); return storageService.subscribe(update);
  }, [wallet?.address]);
  useEffect(() => {
    const transfer = transfers.find(record => record.hash === activeBridgeHash && record.owner.toLowerCase() === wallet?.address.toLowerCase());
    if (!transfer) return;
    setStatusMessage(bridgeStatusMessage(transfer.status, transfer));
    setActiveSwapStatus(transfer.status === 'pending' ? 'processing' : transfer.status === 'delivered' ? 'completed' : 'failed');
    if (transfer.status === 'delivered') onRefreshBalances();
  }, [transfers, activeBridgeHash, wallet?.address]);

  const [sendAsset, setSendAsset] = useState<SelectedMatrixToken | null>(null);
  useEffect(() => { setSendAsset(null); setToken1(null); setToken2(null); setIsSwapModalOpen(false); }, [wallet?.address]);

  const chainList = useMemo(() => {
    return Object.entries(SUPPORTED_CHAINS).map(([idStr, cfg], idx) => ({
      chainId: parseInt(idStr, 10),
      config: cfg,
      index: idx,
    }));
  }, []);

  // Handle clicking a token cell in the matrix
  const handleTokenClick = (item: SelectedMatrixToken) => {
    if (executionLock.current || !item.balance) return;
    setMaxSelected(false);
    if (!token1) {
      // First token clicked
      setToken1(item);
      setToken2(null);
      setActiveSwapStatus('idle');
    } else if (token1.token.address.toLowerCase() === item.token.address.toLowerCase() && token1.chainId === item.chainId && token1.category === item.category) {
      // Clicking same token resets selection
      setToken1(null);
      setToken2(null);
      setActiveSwapStatus('idle');
    } else {
      // Second token clicked
      setToken2(item);
      setIsSwapModalOpen(true);
      setActiveSwapStatus('idle');
    }
  };

  // Fetch Quote when Swap Modal is open
  const fetchQuote = useCallback(async () => {
    if (!token1 || !token2 || !wallet || !wallet.address) return;

    const parsedUsd = maxSelected ? 1 : Number(amountInput);
    if (isNaN(parsedUsd) || parsedUsd <= 0) {
      setBridgeQuote(null);
      setQuoteError(null);
      return;
    }

    const generation = ++quoteGeneration.current;
    const key = inputKey;
    const current = () => generation === quoteGeneration.current && key === latestInput.current;
    const publishQuote = (quote: (BridgeQuote & { cowQuote?: CowQuoteResponse }) | null) => {
      if (!current()) return;
      setBridgeQuote(quote ? { ...quote, quotedAt: quote.quotedAt ?? Date.now(), inputKey: key } : null);
      if (quote && maxSelected) setSwapAmountUsd(quote.fromAmountUsd.toFixed(2));
    };
    setIsLoadingQuote(true);
    setQuoteError(null);

    try {
      publishQuote(await assetTransferQuote(wallet.address, token1, token2, amountInput, maxSelected));
    } catch (err: any) {
      if (!current()) return;
      setQuoteError(err.message || 'Route unavailable for selected pair and amount.');
      systemLogService.logError(token1.chainId !== token2.chainId ? 'BRIDGE' : 'SWAP', 'Asset Overview Quote Failed',
        `${token1.token.symbol} (${token1.chainId}, ${token1.token.address}) → ${token2.token.symbol} (${token2.chainId}, ${token2.token.address}); input ${amountInput} ${maxSelected ? '' : 'USD'}\n${operationErrorDetails(err)}`, token1.chainId);
      publishQuote(null);
    } finally {
      if (current()) setIsLoadingQuote(false);
    }
  }, [token1, token2, amountInput, maxSelected, wallet, inputKey]);

  useEffect(() => {
    quoteGeneration.current++; setBridgeQuote(null); setQuoteError(null);
    if (isSwapModalOpen) {
      const timer = setTimeout(() => {
        fetchQuote();
      }, 400);
      return () => { clearTimeout(timer); quoteGeneration.current++; };
    }
  }, [isSwapModalOpen, fetchQuote]);

  // Execute Swap & Close Modal -> Show in-place processing
  const handleExecuteSwap = async () => {
    if (!token1 || !token2 || !wallet || executionLock.current) return;
    if (!bridgeQuote || bridgeQuote.inputKey !== inputKey || !bridgeQuote.quotedAt || Date.now() - bridgeQuote.quotedAt > 60000 || isLoadingQuote) {
      setQuoteError('Quote expired or changed. Refresh the quote before submitting.'); void fetchQuote(); return;
    }
    executionLock.current = true; setIsExecuting(true);
    setActiveBridgeHash(null);
    setIsSwapModalOpen(false); setActiveSwapStatus('processing'); setStatusMessage('Processing swap...');
    let stage = 'Validating active wallet';
    try {
      await exclusive(async () => {
        if (storageService.getWallet()?.address.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('Wallet changed before submission.');
        let hash: string;
        let message: string;
        if (token1.chainId !== token2.chainId) {
          stage = 'Executing bridge route';
          hash = await crossChainBridgeService.executeBridge(wallet.address, bridgeQuote, setActiveBridgeHash);
          setActiveBridgeHash(hash);
          const transfer = bridgeJournal.all(wallet.address).find(record => record.hash === hash);
          message = bridgeStatusMessage(transfer?.status || 'pending', transfer);
        } else if (token1.category === 'native' && token2.category === 'wrapped') {
          stage = 'Wrapping native token';
          hash = await web3Service.wrapNative(wallet.address, bridgeQuote.fromAmount, token1.chainId);
          message = 'Wrap confirmed';
        } else if (token1.category === 'wrapped' && token2.category === 'native') {
          stage = 'Unwrapping native token';
          hash = await web3Service.unwrapNative(wallet.address, bridgeQuote.fromAmount, token1.chainId);
          message = 'Unwrap confirmed';
        } else {
          if (token1.category === 'native' || token2.category === 'native') throw new Error('Wrap native input first, or select wrapped output and unwrap after settlement.');
          stage = 'Checking token balance and allowance';
          await web3Service.ensureAllowance(wallet.address, token1.token.address, ethers.parseUnits(bridgeQuote.fromAmount, token1.token.decimals), token1.chainId);
          const quote = bridgeQuote.cowQuote;
          stage = 'Validating and signing CoW order';
          if (!quote || Date.now() - bridgeQuote.quotedAt! > 60000 || quote.quote.validTo * 1000 <= Date.now()) throw new Error('Swap quote expired. Request a fresh quote.');
          hash = await cowProtocol.signAndSubmitOrder(quote, web3Service.getSigner(wallet.address, token1.chainId), token1.chainId);
          message = 'Order submitted; awaiting fill in Order History';
        }
        const transfer = token1.chainId !== token2.chainId ? bridgeJournal.all(wallet.address).find(record => record.hash === hash) : undefined;
        setActiveSwapStatus(token1.chainId === token2.chainId || transfer?.status === 'delivered' ? 'completed' : transfer && transfer.status !== 'pending' ? 'failed' : 'processing'); setStatusMessage(message);
        if (token1.chainId === token2.chainId) systemLogService.logSuccess('SWAP', message, hash, hash, undefined, token1.chainId);
        onRefreshBalances();
      });
    } catch (error: any) {
      const pending = bridgeQuote.quoteId && bridgeJournal.all(wallet.address).find(record => record.quoteId === bridgeQuote.quoteId && record.status === 'pending');
      setActiveSwapStatus(pending ? 'processing' : 'failed'); setStatusMessage(pending ? 'Submission unconfirmed; original transfer is being tracked' : 'Error, see log');
      systemLogService.logError(token1.chainId !== token2.chainId ? 'BRIDGE' : 'SWAP', 'Asset Overview Transfer Failed',
        [`Stage: ${stage}`, `From: ${bridgeQuote.fromAmount} ${token1.token.symbol} on ${getChainConfig(token1.chainId).name} (${token1.token.address})`,
          `To: ${token2.token.symbol} on ${getChainConfig(token2.chainId).name} (${token2.token.address})`,
          `Input: $${swapAmountUsd} USD; route: ${bridgeQuote.bridgeName}`, operationErrorDetails(error)].join('\n'), token1.chainId);
    } finally { executionLock.current = false; setIsExecuting(false); }
  };

  return (
    <div className="h-full flex flex-col justify-between p-2 select-text font-mono text-xs overflow-x-auto min-w-[620px]">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-[10px] text-slate-400">{token1 ? `${token1.token.symbol} on ${getChainConfig(token1.chainId).shortName} selected. Send to a wallet, or select another asset to swap.` : 'Select an asset to send to an external wallet or swap.'}</p>
        <button type="button" disabled={!wallet || !token1 || isExecuting} onClick={() => { if (token1) setSendAsset(token1); }}
          className="shrink-0 px-3 py-2 rounded-lg bg-theme-primary text-white font-bold disabled:opacity-40 disabled:cursor-not-allowed">Send{token1 ? ` ${token1.token.symbol}` : ''}</button>
      </div>
      
      {/* 5-CHAIN ASSET OVERVIEW GRID */}
      <div className="flex-1 flex flex-col justify-between">
        
        {/* CHAIN HEADERS WITH DEPOSIT BUTTONS */}
        <div className="grid grid-cols-5 gap-2 border-b border-surface-border pb-2 shrink-0">
          {chainList.map(({ chainId, config }) => {
            const report = chainBalances[chainId];
            return (
              <div key={chainId} className="bg-background/80 border border-surface-border rounded-xl p-2 flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white text-xs truncate">{config.name}</span>
                  <span className="text-[9px] text-slate-400 font-mono">
                    {matrixUsd(report?.totalChainUsd)}
                  </span>
                </div>

                {report?.error && <p role="status" className="mt-1 text-[9px] text-amber-300 break-words">{report.error} <button type="button" className="underline" onClick={onRefreshBalances}>Retry</button></p>}
                {/* Deposit Button with QR Icon */}
                <button
                  type="button"
                  onClick={() => onOpenDepositModal(chainId)}
                  className="mt-1.5 w-full py-1 px-2 rounded-lg bg-surface-hover hover:bg-bnb-yellow/20 hover:text-bnb-yellow border border-surface-border text-[10px] font-bold text-slate-300 transition-colors flex items-center justify-center gap-1 cursor-pointer"
                  title={`Deposit assets on ${config.name}`}
                >
                  <QrCode className="w-3 h-3 text-bnb-yellow" />
                  <span>Deposit</span>
                </button>
              </div>
            );
          })}
        </div>

        {/* ROW 1: NATIVE GAS TOKENS */}
        <div className="space-y-1 py-1.5">
          <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">
            1. Native Gas Tokens
          </div>
          <div className="grid grid-cols-5 gap-2">
            {chainList.map(({ chainId, config, index }) => {
              const rep = chainBalances[chainId];
              const balFormatted = rep?.nativeBalance ?? '';
              const usdVal = rep?.nativeUsd ?? null;

              const tokenItem: SelectedMatrixToken = {
                token: {
                  symbol: config.nativeToken.symbol,
                  name: config.nativeToken.name,
                  address: config.nativeToken.wrappedAddress, // placeholder for native
                  decimals: config.nativeToken.decimals,
                  chainId,
                },
                chainId,
                balance: balFormatted,
                usdValue: usdVal,
                chainIndex: index,
                category: 'native',
              };

              const isSelected1 = token1?.token.symbol === config.nativeToken.symbol && token1?.chainId === chainId;
              const isSelected2 = token2?.token.symbol === config.nativeToken.symbol && token2?.chainId === chainId;

              const showArrow1 = isSelected1;
              const arrow1PointingRight = token2 ? token2.chainIndex >= index : index <= 2;

              const showArrow2 = isSelected2 && token1;
              const arrow2FromLeft = token1 ? token1.chainIndex <= index : true;

              return (
                <div
                  key={chainId}
                  onClick={() => handleTokenClick(tokenItem)}
                  role="button" aria-disabled={!balFormatted} tabIndex={balFormatted ? 0 : -1} aria-label={`Select ${tokenItem.token.symbol} on ${getChainConfig(chainId).name}`}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleTokenClick(tokenItem); } }}
                  className={`btn-tactile p-2 rounded-xl border transition-all cursor-pointer relative flex flex-col justify-between ${
                    isSelected1
                      ? 'bg-theme-primary-10 border-theme-primary shadow-glow-primary ring-1 ring-theme-primary'
                      : isSelected2
                      ? 'bg-theme-secondary-10 border-theme-secondary shadow-glow-secondary ring-1 ring-theme-secondary'
                      : 'bg-background/60 border-surface-border/80 hover:border-slate-500 hover:bg-surface-hover/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <span className="font-bold text-slate-200 text-xs">{config.nativeToken.symbol}</span>
                      <span className="text-[9px] px-1 py-0.2 rounded font-bold bg-surface border border-surface-border text-slate-400">
                        {config.shortName}
                      </span>
                    </div>
                    
                    {showArrow1 && (
                      <span className="p-0.5 rounded bg-theme-primary text-slate-950 font-bold">
                        {arrow1PointingRight ? <ArrowRight className="w-3 h-3" /> : <ArrowLeft className="w-3 h-3" />}
                      </span>
                    )}

                    {showArrow2 && (
                      <span className="p-0.5 rounded bg-theme-secondary text-white font-bold">
                        {arrow2FromLeft ? <ArrowRight className="w-3 h-3" /> : <ArrowLeft className="w-3 h-3" />}
                      </span>
                    )}
                  </div>

                  <div className="mt-1 font-mono">
                    <div className="font-extrabold text-white text-xs">
                      {matrixUsd(usdVal)}
                    </div>
                    <div className="text-[9px] text-slate-400">
                      {balFormatted ? formatTokenDisplay(balFormatted) : 'Unavailable'} {config.nativeToken.symbol} ({config.shortName})
                    </div>
                  </div>

                  {/* In-place status pill */}
                  {(isSelected1 || isSelected2) && activeSwapStatus !== 'idle' && (
                    <div className={`mt-1 text-[9px] px-1 py-0.2 rounded font-bold flex items-center justify-center gap-1 ${
                      activeSwapStatus === 'processing'
                        ? 'bg-theme-primary-10 text-theme-primary'
                        : activeSwapStatus === 'completed'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-rose-500/20 text-rose-400'
                    }`}>
                      {activeSwapStatus === 'processing' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                      <span>{statusMessage}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ROW 2: WRAPPED NATIVE TOKENS */}
        <div className="space-y-1 py-1.5">
          <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">
            2. Wrapped Tokens
          </div>
          <div className="grid grid-cols-5 gap-2">
            {chainList.map(({ chainId, config, index }) => {
              const rep = chainBalances[chainId];
              const balFormatted = rep?.wrappedBalance ?? '';
              const usdVal = rep?.wrappedUsd ?? null;

              const tokenItem: SelectedMatrixToken = {
                token: {
                  symbol: config.nativeToken.wrappedSymbol,
                  name: `Wrapped ${config.nativeToken.name}`,
                  address: config.nativeToken.wrappedAddress,
                  decimals: config.nativeToken.decimals,
                  chainId,
                },
                chainId,
                balance: balFormatted,
                usdValue: usdVal,
                chainIndex: index,
                category: 'wrapped',
              };

              const isSelected1 = token1?.token.symbol === config.nativeToken.wrappedSymbol && token1?.chainId === chainId;
              const isSelected2 = token2?.token.symbol === config.nativeToken.wrappedSymbol && token2?.chainId === chainId;

              const showArrow1 = isSelected1;
              const arrow1PointingRight = token2 ? token2.chainIndex >= index : index <= 2;

              const showArrow2 = isSelected2 && token1;
              const arrow2FromLeft = token1 ? token1.chainIndex <= index : true;

              return (
                <div
                  key={chainId}
                  onClick={() => handleTokenClick(tokenItem)}
                  role="button" aria-disabled={!balFormatted} tabIndex={balFormatted ? 0 : -1} aria-label={`Select ${tokenItem.token.symbol} on ${getChainConfig(chainId).name}`}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleTokenClick(tokenItem); } }}
                  className={`btn-tactile p-2 rounded-xl border transition-all cursor-pointer relative flex flex-col justify-between ${
                    isSelected1
                      ? 'bg-theme-primary-10 border-theme-primary shadow-glow-primary ring-1 ring-theme-primary'
                      : isSelected2
                      ? 'bg-theme-secondary-10 border-theme-secondary shadow-glow-secondary ring-1 ring-theme-secondary'
                      : 'bg-background/60 border-surface-border/80 hover:border-slate-500 hover:bg-surface-hover/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <span className="font-bold text-slate-300 text-xs">{config.nativeToken.wrappedSymbol}</span>
                      <span className="text-[9px] px-1 py-0.2 rounded font-bold bg-surface border border-surface-border text-slate-400">
                        {config.shortName}
                      </span>
                    </div>
                    {showArrow1 && (
                      <span className="p-0.5 rounded bg-theme-primary text-slate-950 font-bold">
                        {arrow1PointingRight ? <ArrowRight className="w-3 h-3" /> : <ArrowLeft className="w-3 h-3" />}
                      </span>
                    )}
                    {showArrow2 && (
                      <span className="p-0.5 rounded bg-theme-secondary text-white font-bold">
                        {arrow2FromLeft ? <ArrowRight className="w-3 h-3" /> : <ArrowLeft className="w-3 h-3" />}
                      </span>
                    )}
                  </div>

                  <div className="mt-1 font-mono">
                    <div className="font-extrabold text-white text-xs">
                      {matrixUsd(usdVal)}
                    </div>
                    <div className="text-[9px] text-slate-400">
                      {balFormatted ? formatTokenDisplay(balFormatted) : 'Unavailable'} {config.nativeToken.wrappedSymbol} ({config.shortName})
                    </div>
                  </div>

                  {(isSelected1 || isSelected2) && activeSwapStatus !== 'idle' && (
                    <div className={`mt-1 text-[9px] px-1 py-0.2 rounded font-bold flex items-center justify-center gap-1 ${
                      activeSwapStatus === 'processing'
                        ? 'bg-theme-primary-10 text-theme-primary'
                        : activeSwapStatus === 'completed'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-rose-500/20 text-rose-400'
                    }`}>
                      {activeSwapStatus === 'processing' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                      <span>{statusMessage}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ROW 3: USDT TOKENS */}
        <div className="space-y-1 py-1.5">
          <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">
            3. USDT (Tether)
          </div>
          <div className="grid grid-cols-5 gap-2">
            {chainList.map(({ chainId, config, index }) => {
              const rep = chainBalances[chainId];
              const balFormatted = rep?.usdtBalance ?? '';
              const usdVal = rep?.usdtUsd ?? null;

              const tokenItem: SelectedMatrixToken = {
                token: {
                  ...config.usdtToken,
                  chainId,
                },
                chainId,
                balance: balFormatted,
                usdValue: usdVal,
                chainIndex: index,
                category: 'usdt',
              };

              const isSelected1 = token1?.token.symbol === config.usdtToken.symbol && token1?.chainId === chainId;
              const isSelected2 = token2?.token.symbol === config.usdtToken.symbol && token2?.chainId === chainId;

              const showArrow1 = isSelected1;
              const arrow1PointingRight = token2 ? token2.chainIndex >= index : index <= 2;

              const showArrow2 = isSelected2 && token1;
              const arrow2FromLeft = token1 ? token1.chainIndex <= index : true;

              return (
                <div
                  key={chainId}
                  onClick={() => handleTokenClick(tokenItem)}
                  role="button" aria-disabled={!balFormatted} tabIndex={balFormatted ? 0 : -1} aria-label={`Select ${tokenItem.token.symbol} on ${getChainConfig(chainId).name}`}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleTokenClick(tokenItem); } }}
                  className={`btn-tactile p-2 rounded-xl border transition-all cursor-pointer relative flex flex-col justify-between ${
                    isSelected1
                      ? 'bg-theme-primary-10 border-theme-primary shadow-glow-primary ring-1 ring-theme-primary'
                      : isSelected2
                      ? 'bg-theme-secondary-10 border-theme-secondary shadow-glow-secondary ring-1 ring-theme-secondary'
                      : 'bg-background/60 border-surface-border/80 hover:border-slate-500 hover:bg-surface-hover/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <span className="font-bold text-theme-primary text-xs">USDT</span>
                      <span className="text-[9px] px-1 py-0.2 rounded font-bold bg-theme-primary-10 text-theme-primary border border-theme-primary-30">
                        {config.shortName}
                      </span>
                    </div>
                    {showArrow1 && (
                      <span className="p-0.5 rounded bg-theme-primary text-slate-950 font-bold">
                        {arrow1PointingRight ? <ArrowRight className="w-3 h-3" /> : <ArrowLeft className="w-3 h-3" />}
                      </span>
                    )}
                    {showArrow2 && (
                      <span className="p-0.5 rounded bg-theme-secondary text-white font-bold">
                        {arrow2FromLeft ? <ArrowRight className="w-3 h-3" /> : <ArrowLeft className="w-3 h-3" />}
                      </span>
                    )}
                  </div>

                  <div className="mt-1 font-mono">
                    <div className="font-extrabold text-theme-primary text-xs">
                      {matrixUsd(usdVal)}
                    </div>
                    <div className="text-[9px] text-slate-400">
                      {balFormatted ? formatUsdDisplay(balFormatted) : 'Unavailable'} USDT ({config.shortName})
                    </div>
                  </div>

                  {(isSelected1 || isSelected2) && activeSwapStatus !== 'idle' && (
                    <div className={`mt-1 text-[9px] px-1 py-0.2 rounded font-bold flex items-center justify-center gap-1 ${
                      activeSwapStatus === 'processing'
                        ? 'bg-theme-primary-10 text-theme-primary'
                        : activeSwapStatus === 'completed'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-rose-500/20 text-rose-400'
                    }`}>
                      {activeSwapStatus === 'processing' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                      <span>{statusMessage}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ROW 4: DYNAMIC USER-TRACKED & TRADED TOKENS (e.g. CAKE on BSC, ARB, Custom Tokens) */}
        <div className="space-y-1 py-1.5">
          <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wider flex items-center gap-1.5">
            <Coins className="w-3 h-3 text-theme-secondary" />
            <span>4. Traded & Tracked Wallet Assets</span>
          </div>
          <div className="grid grid-cols-5 gap-2 items-start">
            {chainList.map(({ chainId, config, index }) => {
              const rep = chainBalances[chainId];
              const chainTokens = rep?.tokens || [];
              
              // Fallback to trackedTokens from storage if report has not loaded yet
              const localTracked = (trackedTokens.length > 0 ? trackedTokens : storageService.getTrackedTokens(chainId))
                .filter(t => (t.chainId || 56) === chainId && 
                  t.address.toLowerCase() !== config.nativeToken.wrappedAddress.toLowerCase() && 
                  t.address.toLowerCase() !== config.usdtToken.address.toLowerCase());

              const activeTokensToDisplay = chainTokens.length > 0 ? chainTokens : localTracked.map(t => ({
                token: t,
                balance: '',
                usdValue: null,
                priceUsd: null,
              }));

              if (activeTokensToDisplay.length === 0) {
                return (
                  <div key={chainId} className="p-2.5 rounded-xl border border-dashed border-surface-border/60 bg-background/30 text-center text-[10px] text-slate-500 font-mono">
                    <span>— No extra tokens</span>
                  </div>
                );
              }

              return (
                <div key={chainId} className="space-y-1.5">
                  {activeTokensToDisplay.map((tReport) => {
                    const tok = tReport.token;
                    const balFormatted = tReport.balance;
                    const usdVal = tReport.usdValue;

                    const tokenItem: SelectedMatrixToken = {
                      token: tok,
                      chainId,
                      balance: balFormatted,
                      usdValue: usdVal,
                      chainIndex: index,
                      category: 'custom',
                    };

                    const isSelected1 = token1?.token.address.toLowerCase() === tok.address.toLowerCase() && token1?.chainId === chainId;
                    const isSelected2 = token2?.token.address.toLowerCase() === tok.address.toLowerCase() && token2?.chainId === chainId;

                    const showArrow1 = isSelected1;
                    const arrow1PointingRight = token2 ? token2.chainIndex >= index : index <= 2;

                    const showArrow2 = isSelected2 && token1;
                    const arrow2FromLeft = token1 ? token1.chainIndex <= index : true;

                    return (
                      <div
                        key={`${chainId}_${tok.address}`}
                        onClick={() => handleTokenClick(tokenItem)}
                        role="button" aria-disabled={!balFormatted} tabIndex={balFormatted ? 0 : -1} aria-label={`Select ${tokenItem.token.symbol} on ${getChainConfig(chainId).name}`}
                        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleTokenClick(tokenItem); } }}
                        className={`btn-tactile p-2 rounded-xl border transition-all cursor-pointer relative flex flex-col justify-between ${
                          isSelected1
                            ? 'bg-theme-primary-10 border-theme-primary shadow-glow-primary ring-1 ring-theme-primary'
                            : isSelected2
                            ? 'bg-theme-secondary-10 border-theme-secondary shadow-glow-secondary ring-1 ring-theme-secondary'
                            : 'bg-background/60 border-surface-border/80 hover:border-slate-500 hover:bg-surface-hover/50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1 truncate">
                            <span className="font-bold text-slate-200 text-xs truncate">{tok.symbol}</span>
                            <span className="text-[9px] px-1 py-0.2 rounded font-bold bg-surface border border-surface-border text-slate-400">
                              {config.shortName}
                            </span>
                          </div>

                          {showArrow1 && (
                            <span className="p-0.5 rounded bg-theme-primary text-slate-950 font-bold">
                              {arrow1PointingRight ? <ArrowRight className="w-3 h-3" /> : <ArrowLeft className="w-3 h-3" />}
                            </span>
                          )}

                          {showArrow2 && (
                            <span className="p-0.5 rounded bg-theme-secondary text-white font-bold">
                              {arrow2FromLeft ? <ArrowRight className="w-3 h-3" /> : <ArrowLeft className="w-3 h-3" />}
                            </span>
                          )}
                        </div>

                        <div className="mt-1 font-mono">
                          <div className="font-extrabold text-emerald-400 text-xs">
                            {matrixUsd(usdVal)}
                          </div>
                          <div className="text-[9px] text-slate-400 truncate">
                            {balFormatted ? formatAssetDisplay(balFormatted, tok.symbol) : 'Unavailable'} {tok.symbol}
                          </div>
                        </div>

                        {(isSelected1 || isSelected2) && activeSwapStatus !== 'idle' && (
                          <div className={`mt-1 text-[9px] px-1 py-0.2 rounded font-bold flex items-center justify-center gap-1 ${
                            activeSwapStatus === 'processing'
                              ? 'bg-theme-primary-10 text-theme-primary'
                              : activeSwapStatus === 'completed'
                              ? 'bg-emerald-500/20 text-emerald-400'
                              : 'bg-rose-500/20 text-rose-400'
                          }`}>
                            {activeSwapStatus === 'processing' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                            <span>{statusMessage}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

      </div>

      {wallet && <AssetSendHistory key={wallet.address} from={wallet.address} onRefresh={onRefreshBalances} />}
      {wallet && sendAsset && <AssetSendModal key={`${wallet.address}:${sendAsset.chainId}:${sendAsset.category}:${sendAsset.token.address}`}
        from={wallet.address} asset={sendAsset.category === 'native'
          ? { kind: 'native', chainId: sendAsset.chainId, symbol: sendAsset.token.symbol, decimals: sendAsset.token.decimals }
          : { kind: 'erc20', chainId: sendAsset.chainId, symbol: sendAsset.token.symbol, decimals: sendAsset.token.decimals, address: sendAsset.token.address }}
        displayPrice={sendAsset.usdValue !== null && Number(sendAsset.balance) > 0 ? sendAsset.usdValue / Number(sendAsset.balance) : undefined}
        onClose={() => setSendAsset(null)} onRefresh={onRefreshBalances} />}

      {/* 5. INTERACTIVE SWAP / BRIDGE MODAL POPUP */}
      {isSwapModalOpen && token1 && token2 && (
        <ModalDialog label="Swap or bridge assets" onClose={() => setIsSwapModalOpen(false)} busy={isExecuting}>
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150 select-text">
          <div className="bg-surface border border-surface-border rounded-2xl w-full max-w-md shadow-2xl overflow-hidden font-mono flex flex-col max-h-[90vh]">
            
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-surface-border bg-surface-hover/30">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-theme-primary-10 text-theme-primary">
                  <ArrowRightLeft className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-sm text-white">
                  {token1.chainId !== token2.chainId ? 'Cross-Chain Transfer' : 'Token Swap'}
                </h3>
              </div>
              <button
                onClick={() => setIsSwapModalOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-surface-border transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-4 overflow-y-auto">
              
              {/* Token Pair Overview */}
              <div className="grid grid-cols-2 gap-2 bg-background p-3 rounded-xl border border-surface-border">
                <div>
                  <span className="text-[9px] text-slate-500 uppercase font-bold">Source Token</span>
                  <div className="font-bold text-white text-xs mt-0.5">{token1.token.symbol}</div>
                  <div className="text-[10px] text-theme-primary font-bold">{getChainConfig(token1.chainId).name}</div>
                  <div className="text-[10px] text-slate-400 mt-1">Avail: {matrixUsd(token1.usdValue)}</div>
                </div>

                <div className="text-right">
                  <span className="text-[9px] text-slate-500 uppercase font-bold">Destination Token</span>
                  <div className="font-bold text-white text-xs mt-0.5">{token2.token.symbol}</div>
                  <div className="text-[10px] text-theme-secondary font-bold">{getChainConfig(token2.chainId).name}</div>
                  <div className="text-[10px] text-slate-400 mt-1">Current: {matrixUsd(token2.usdValue)}</div>
                </div>
              </div>

              {/* Amount Input */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Amount to Swap (USD):</span>
                  <span>Max: {matrixUsd(token1.usdValue)}</span>
                </div>

                <div className="bg-background border border-surface-border focus-within:border-theme-primary rounded-xl p-2.5 flex items-center justify-between">
                  <span className="text-base font-bold text-slate-500 font-mono">$</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={swapAmountUsd}
                    onChange={(e) => { setMaxSelected(false); setSwapAmountUsd(e.target.value); }}
                    className="w-full bg-transparent text-lg font-bold font-mono text-white text-right focus:outline-none"
                    placeholder="50"
                  />
                  <span className="text-xs font-bold text-slate-400 ml-2">USD</span>
                </div>

                {/* Quick % chips */}
                <div className="flex gap-1.5 pt-1">
                  {[25, 50, 75, 100].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => {
                        if (pct === 100) {
                          if (maxSelected) void fetchQuote();
                          else setMaxSelected(true);
                          return;
                        }
                        setMaxSelected(false);
                        if (token1.usdValue !== null && token1.usdValue > 0) {
                          setSwapAmountUsd((token1.usdValue * (pct / 100)).toFixed(2));
                        }
                      }}
                      className="btn-tactile flex-1 py-1 rounded-lg bg-surface border border-surface-border hover:border-theme-primary text-[10px] font-bold text-slate-300 hover:text-white transition-colors cursor-pointer"
                    >
                      {pct === 100 ? '100% MAX' : `${pct}%`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quote Breakdown & Gas Validation */}
              {(() => {
                const sourceChainCfg = token1 ? getChainConfig(token1.chainId) : null;
                const sourceChainReport = token1 ? chainBalances[token1.chainId] : null;
                const sourceNativeBal = parseFloat(sourceChainReport?.nativeBalance || '0');
                const sourceNativeUsd = sourceChainReport?.nativeUsd || 0;
                const isCrossChain = token1 && token2 && token1.chainId !== token2.chainId;
                const hasInsufficientGas = bridgeQuote?.nativeRequiredWei != null
                  ? ethers.parseUnits(sourceChainReport?.nativeBalance || '0', sourceChainCfg!.nativeToken.decimals) < BigInt(bridgeQuote.nativeRequiredWei)
                  : false;

                return (
                  <>
                    {isLoadingQuote ? (
                      <div className="p-3 bg-background/50 border border-surface-border rounded-xl flex items-center justify-center gap-2 text-xs text-slate-400">
                        <Loader2 className="w-4 h-4 animate-spin text-theme-primary" />
                        <span>Calculating quote...</span>
                      </div>
                    ) : quoteError ? (
                      <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-300 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0" />
                        <span>{quoteError}</span>
                      </div>
                    ) : bridgeQuote ? (
                      <div className="p-3 bg-background/80 border border-surface-border rounded-xl space-y-1.5 text-[11px]">
                        <div className="flex justify-between">
                          <span className="text-slate-400">Route:</span>
                          <span className="text-slate-200">{bridgeQuote.bridgeName}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Estimated Receive:</span>
                          <span className="text-theme-primary font-bold">${formatUsdDisplay(bridgeQuote.toAmountUsd)} USD</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Route Fee:</span>
                          <span className="text-slate-200">${formatUsdDisplay(bridgeQuote.bridgeFeeUsd)} USD</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Gas Reserve:</span>
                          <span className={`${hasInsufficientGas ? 'text-rose-400 font-bold' : 'text-slate-200'}`}>
                            ${formatUsdDisplay(bridgeQuote.gasCostUsd)} USD (~{sourceChainCfg?.nativeToken.symbol})
                          </span>
                        </div>
                      </div>
                    ) : null}

                    {/* Insufficient Gas Warning Banner */}
                    {hasInsufficientGas && sourceChainCfg && (
                      <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 space-y-2">
                        <div className="flex items-start gap-2">
                          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                          <div>
                            <div className="font-bold text-rose-200">
                              Insufficient {sourceChainCfg.nativeToken.symbol} for Gas
                            </div>
                            <div className="text-[10px] text-rose-300/80 mt-0.5">
                              {sourceChainCfg.name} requires native {sourceChainCfg.nativeToken.symbol} to pay network gas. Your balance is {formatTokenDisplay(sourceNativeBal)} {sourceChainCfg.nativeToken.symbol} (${formatUsdDisplay(sourceNativeUsd)} USD).
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setIsSwapModalOpen(false);
                            onOpenDepositModal(sourceChainCfg.chainId);
                          }}
                          className="btn-tactile w-full py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-[10px] font-bold text-rose-200 flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          <span>Deposit {sourceChainCfg.nativeToken.symbol} on {sourceChainCfg.name}</span>
                        </button>
                      </div>
                    )}

                    {/* Submit Button */}
                    <button
                      type="button"
                      onClick={handleExecuteSwap}
                      disabled={isExecuting || isLoadingQuote || !bridgeQuote || bridgeQuote.inputKey !== inputKey || !!quoteError || hasInsufficientGas || (!maxSelected && (parseFloat(swapAmountUsd) <= 0 || (token1.usdValue === null || parseFloat(swapAmountUsd) > token1.usdValue)))}
                      className="btn-tactile w-full py-3 rounded-xl bg-theme-gradient text-slate-950 font-extrabold text-xs uppercase tracking-wider transition-all shadow-glow-primary disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      {isExecuting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin text-slate-950" />
                          <span>Executing...</span>
                        </>
                      ) : hasInsufficientGas ? (
                        <span>Insufficient {sourceChainCfg?.nativeToken.symbol} for Gas</span>
                      ) : !maxSelected && (token1.usdValue === null || parseFloat(swapAmountUsd) > token1.usdValue) ? (
                        <span>Insufficient Balance</span>
                      ) : (
                        <span>Confirm Swap (${swapAmountUsd} USD)</span>
                      )}
                    </button>
                  </>
                );
              })()}

            </div>

          </div>
        </div>
      </ModalDialog>
      )}

    </div>
  );
};
