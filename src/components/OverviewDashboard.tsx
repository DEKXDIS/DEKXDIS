import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { 
  WalletState, 
  TokenConfig, 
  TradeOrder, 
  StrategyConfig 
} from '../types/trading';
import type { ChainBalanceReport } from '../services/web3Service';
import { storageService } from '../services/storageService';
import { systemLogService } from '../services/systemLogService';
import { 
  DraggableResizableWindow, 
  WindowLayout 
} from './DraggableResizableWindow';

import { AssetMatrixWindow } from './overview/AssetMatrixWindow';
import { WalletCreationPanel } from './overview/WalletCreationPanel';
import { SystemLogWindow } from './overview/SystemLogWindow';
import { calculateOverallRealizedPnl } from '../utils/tradeMetrics';
import { SUPPORTED_CHAINS } from '../types/chains';

import { 
  DollarSign, 
  RefreshCw, 
  LayoutGrid, 
  Layers, 
  Activity, 
  BarChart2, 
  FileText
} from 'lucide-react';

interface OverviewDashboardProps {
  chainBalances: Record<number, ChainBalanceReport>;
  isLoadingBalances: boolean;
  onRefreshBalances: () => Promise<void>;
  onSwitchWallet: (address: string) => Promise<void>;
  onOpenWalletSetup: () => void;
  wallet: WalletState | null;
  selectedChainId: number;
  selectedToken: TokenConfig;
  onSelectTokenAndChain: (token: TokenConfig, chainId: number) => void;
  onOpenDepositModal: (chainId?: number) => void;
  onOpenWrapModal: (chainId?: number) => void;
  allOrders: TradeOrder[];
  accountingError?: string;
  onCancelOrder: (orderId: string) => void;
  customTokens: TokenConfig[];
  strategyConfig: StrategyConfig;
  onUpdateStrategyConfig: (config: StrategyConfig) => void;
}

export const OverviewDashboard: React.FC<OverviewDashboardProps> = ({
  chainBalances,
  isLoadingBalances,
  onRefreshBalances: loadAllBalances,
  onSwitchWallet,
  onOpenWalletSetup,
  wallet,
  selectedChainId,
  selectedToken,
  onSelectTokenAndChain,
  onOpenDepositModal,
  onOpenWrapModal,
  allOrders,
  accountingError,
  onCancelOrder,
  customTokens,
  strategyConfig,
  onUpdateStrategyConfig,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerBounds, setContainerBounds] = useState<{ width: number; height: number }>({
    width: 1440,
    height: 900,
  });

  const customLayoutRef = useRef(!!storageService.getOverviewWindowLayouts());

  // Overview window layouts with persistence
  const [windows, setWindows] = useState<Record<string, WindowLayout>>(() => {
    const initialWidth = typeof window === 'undefined' ? 1440 : window.innerWidth;
    const initialHeight = typeof window === 'undefined' ? 900 : Math.max(600, window.innerHeight - 150);
    const defaults = storageService.getDefaultOverviewWindowLayouts(initialWidth, initialHeight);
    const saved = storageService.getOverviewWindowLayouts();
    if (!saved) return defaults;
    let nextLayer = Math.max(20, ...Object.values(saved).map(layout => layout.zIndex || 0));
    return Object.fromEntries(Object.entries(defaults).map(([id, layout]) => [
      id,
      saved[id]
        ? { ...layout, ...saved[id], title: layout.title }
        : { ...layout, zIndex: ++nextLayer },
    ]));
  });

  // Keep track of active z-index
  const maxZIndexRef = useRef<number>(Math.max(20, ...Object.values(windows).map(layout => layout.zIndex || 0)));

  // Measure container size
  useEffect(() => {
    const updateBounds = () => {
      if (containerRef.current) {
        const w = containerRef.current.clientWidth;
        const h = containerRef.current.clientHeight;
        if (w > 0 && h > 0) {
          setContainerBounds({ width: w, height: h });
          if (!customLayoutRef.current) {
            setWindows(storageService.getDefaultOverviewWindowLayouts(w, h));
          }
        }
      }
    };

    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Window Layout Update Handler
  const handleUpdateLayout = useCallback((id: string, updates: Partial<WindowLayout>) => {
    customLayoutRef.current = true;
    setWindows((prev) => {
      const current = prev[id];
      if (!current) return prev;
      const updated = {
        ...prev,
        [id]: { ...current, ...updates },
      };
      storageService.saveOverviewWindowLayouts(updated);
      return updated;
    });
  }, []);

  // Bring Window to Front Handler
  const handleBringToFront = useCallback((id: string) => {
    maxZIndexRef.current += 1;
    const newZ = maxZIndexRef.current;
    setWindows((prev) => {
      const current = prev[id];
      if (!current || current.zIndex === newZ) return prev;
      const updated = {
        ...prev,
        [id]: { ...current, zIndex: newZ },
      };
      storageService.saveOverviewWindowLayouts(updated);
      return updated;
    });
  }, []);

  // Reset Overview Windows Layout
  const handleResetOverviewLayout = () => {
    customLayoutRef.current = false;
    const defaults = storageService.getDefaultOverviewWindowLayouts(
      containerBounds.width,
      containerBounds.height
    );
    setWindows(defaults);
    storageService.saveOverviewWindowLayouts(defaults);
  };

  // Calculate Total Net Worth across all chains
  const totalNetWorthUsd = useMemo(() => {
    let total = 0;
    Object.values(chainBalances).forEach((rep) => {
      total += rep.knownTotalChainUsd ?? rep.totalChainUsd ?? 0;
    });
    return total;
  }, [chainBalances]);
  const hasKnownValue = Object.values(chainBalances).some(report => report.knownTotalChainUsd !== null);
  const partialBalance = Object.keys(chainBalances).length < Object.keys(SUPPORTED_CHAINS).length ||
    Object.values(chainBalances).some(report => report.totalChainUsd === null);

  const overallPnl = useMemo(() => accountingError
    ? { realized: null, issues: [accountingError] }
    : calculateOverallRealizedPnl(allOrders), [allOrders, accountingError]);
  const pnlIssue = overallPnl.issues.join('; ');
  const reportedPnlIssue = useRef('');
  useEffect(() => {
    if (pnlIssue) systemLogService.logError('ORDER', 'Overall realized PnL unavailable', pnlIssue);
    else if (reportedPnlIssue.current) systemLogService.logInfo('ORDER', 'Overall realized PnL recovered');
    reportedPnlIssue.current = pnlIssue;
  }, [pnlIssue]);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-background overflow-hidden relative select-none font-mono">
      {/* 1. TOP OVERVIEW CONTROLS STRIP */}
      <div className="min-h-11 px-4 py-1.5 gap-3 bg-surface border-b border-surface-border flex flex-wrap items-center justify-between shrink-0 select-text">
        
        {/* Total Combined Balance Across All Chains */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <div className="p-1.5 rounded-lg bg-theme-primary-10 text-theme-primary border border-theme-primary-30">
            <DollarSign className="w-4 h-4" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] uppercase font-bold text-slate-400">
              {partialBalance ? 'Known balance (partial):' : 'Total Balance Across All Chains:'}
            </span>
            <span className="text-sm md:text-base font-extrabold text-theme-primary font-mono">
              {hasKnownValue ? `$${totalNetWorthUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD` : isLoadingBalances ? 'Loading…' : 'Unavailable'}
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] uppercase font-bold text-slate-400">Realized PnL:</span>
            <span className={`text-sm md:text-base font-extrabold font-mono ${overallPnl.realized === null ? 'text-slate-400' : overallPnl.realized >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {overallPnl.realized === null ? 'Unavailable' : `${overallPnl.realized >= 0 ? '+' : '-'}$${Math.abs(overallPnl.realized).toFixed(2)} USD`}
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={loadAllBalances}
            disabled={isLoadingBalances}
            className="btn-tactile px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 hover:border-theme-primary text-slate-300 hover:text-white text-xs font-bold transition-all flex items-center gap-1.5 disabled:opacity-50 cursor-pointer shadow-sm"
            title="Refresh All Balances"
          >
            <RefreshCw className={`w-3 h-3 ${isLoadingBalances ? 'animate-spin text-theme-primary' : 'text-theme-primary'}`} />
            <span className="hidden sm:inline">Sync</span>
          </button>

          <button
            onClick={handleResetOverviewLayout}
            className="btn-tactile px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 hover:border-theme-primary text-slate-300 hover:text-theme-primary text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
            title="Reset Overview Window Layout"
          >
            <LayoutGrid className="w-3 h-3" />
            <span className="hidden sm:inline">Reset Layout</span>
          </button>


        </div>

      </div>

      {/* 2. DRAGGABLE & RESIZABLE OVERVIEW WORKSPACE CANVAS */}
      <div 
        ref={containerRef}
        className="flex-1 min-h-0 relative w-full h-full overflow-hidden p-2 z-0"
      >
        {/* WALLET CREATION */}
        {windows.wallet_creation && (
          <DraggableResizableWindow
            layout={windows.wallet_creation}
            onUpdateLayout={handleUpdateLayout}
            onBringToFront={handleBringToFront}
            containerBounds={containerBounds}
          >
            <WalletCreationPanel
              onSwitchWallet={onSwitchWallet}
              wallet={wallet}
              onOpenWalletSetup={onOpenWalletSetup}
            />
          </DraggableResizableWindow>
        )}
        
        {/* WINDOW 1: ASSET OVERVIEW */}
        {windows.matrix && (
          <DraggableResizableWindow
            layout={{
              ...windows.matrix,
              title: 'Asset Overview',
            }}
            onUpdateLayout={handleUpdateLayout}
            onBringToFront={handleBringToFront}
            containerBounds={containerBounds}
          >
            <AssetMatrixWindow
              wallet={wallet}
              chainBalances={chainBalances}
              trackedTokens={storageService.getTrackedTokens()}
              customTokens={customTokens}
              onOpenDepositModal={(cId) => onOpenDepositModal(cId)}
              onRefreshBalances={loadAllBalances}
            />
          </DraggableResizableWindow>
        )}

        {/* WINDOW 4: UNIVERSAL SYSTEM & EXECUTION LOG */}
        {windows.system_log && (
          <DraggableResizableWindow
            layout={windows.system_log}
            onUpdateLayout={handleUpdateLayout}
            onBringToFront={handleBringToFront}
            containerBounds={containerBounds}
          >
            <SystemLogWindow />
          </DraggableResizableWindow>
        )}

      </div>

    </div>
  );
};
