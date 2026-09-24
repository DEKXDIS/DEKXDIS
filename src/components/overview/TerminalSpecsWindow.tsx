import { automation } from '../../automation/runner';
import { STRATEGIES_ENABLED } from '../../config/releaseFeatures';
import { buildFilledExitPnls } from '../../utils/orderHistory';
import React, { useMemo } from 'react';
import { TradeOrder } from '../../types/trading';
import { ChainBalanceReport } from '../../services/web3Service';
import { storageService } from '../../services/storageService';
import { 
  DollarSign, 
  TrendingUp, 
  Activity, 
  Layers, 
  BarChart3, 
  ShieldCheck,
  CheckCircle2,
  Clock
} from 'lucide-react';

interface TerminalSpecsWindowProps {
  chainBalances: Record<number, ChainBalanceReport>;
  allOrders: TradeOrder[];
}

export const TerminalSpecsWindow: React.FC<TerminalSpecsWindowProps> = ({
  chainBalances,
  allOrders,
}) => {
  const totalNetWorthUsd = useMemo(() => {
    let total = 0;
    Object.values(chainBalances).forEach((rep) => {
      total += rep.totalChainUsd || 0;
    });
    return total;
  }, [chainBalances]);

  const runningStrategiesCount = automation.activeWorkspaces().length;

  const totalTradesCount = allOrders.filter(o => o.status === 'fulfilled' || o.status === 'open').length;
  const openOrdersCount = allOrders.filter(o => o.status === 'open').length;

  // Calculate cumulative PnL truthfully from filled orders
  const cumulativePnlUsd = useMemo(() => {
    return [...buildFilledExitPnls(allOrders).values()].reduce((sum, value) => sum + value, 0);
  }, [allOrders]);

  return (
    <div className="h-full flex flex-col justify-between p-2.5 font-mono text-xs select-text">
      
      {/* Window Header */}
      <div className="flex items-center justify-between pb-2 border-b border-surface-border shrink-0">
        <div className="flex items-center gap-1.5">
          <BarChart3 className="w-3.5 h-3.5 text-theme-primary" />
          <span className="font-bold text-white text-xs uppercase">Overall Terminal Specs</span>
        </div>
        <span className="text-[10px] text-slate-400">Real-time</span>
      </div>

      {/* 2x2 High-Density Metrics Grid */}
      <div className={`flex-1 grid ${STRATEGIES_ENABLED ? "grid-cols-2" : "grid-cols-3"} gap-2 py-2 min-h-0`}>
        
        {/* Total USD Value All Wallets */}
        <div className="bg-background/80 border border-surface-border rounded-xl p-2.5 flex flex-col justify-between">
          <div className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1">
            <DollarSign className="w-3 h-3 text-theme-primary" />
            <span>Combined Total USD</span>
          </div>
          <div className="text-base font-extrabold text-theme-primary mt-1">
            ${totalNetWorthUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-[9px] text-slate-500">Across all 5 chains</div>
        </div>

        {/* Overall Cumulative PnL */}
        <div className="bg-background/80 border border-surface-border rounded-xl p-2.5 flex flex-col justify-between">
          <div className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1">
            <TrendingUp className={`w-3 h-3 ${cumulativePnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`} />
            <span>Realized PnL</span>
          </div>
          <div className={`text-base font-extrabold mt-1 ${cumulativePnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {cumulativePnlUsd >= 0 ? `+$${cumulativePnlUsd.toFixed(2)}` : `-$${Math.abs(cumulativePnlUsd).toFixed(2)}`} USD
          </div>
          <div className="text-[9px] text-slate-500">All historical trades</div>
        </div>

        {/* Total Trades Executed */}
        <div className="bg-background/80 border border-surface-border rounded-xl p-2.5 flex flex-col justify-between">
          <div className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1">
            <Layers className="w-3 h-3 text-theme-primary" />
            <span>Total Trades</span>
          </div>
          <div className="text-base font-extrabold text-slate-200 mt-1">
            {totalTradesCount} Executed
          </div>
          <div className="text-[9px] text-slate-500">{openOrdersCount} currently open</div>
        </div>

        {/* Active Strategies */}
        {STRATEGIES_ENABLED && <div className="bg-background/80 border border-surface-border rounded-xl p-2.5 flex flex-col justify-between">
          <div className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1">
            <Activity className="w-3 h-3 text-theme-secondary" />
            <span>Active Strategies</span>
          </div>
          <div className="text-base font-extrabold text-theme-secondary mt-1">
            {runningStrategiesCount} Running
          </div>
          <div className="text-[9px] text-slate-500">Automated signal monitoring</div>
        </div>}

      </div>

      {/* Footer Info */}
      <div className="pt-1.5 border-t border-surface-border text-[9px] text-slate-500 flex justify-between shrink-0">
        <span>Global Performance Matrix</span>
        <span>CoW Batch Relayer</span>
      </div>

    </div>
  );
};
