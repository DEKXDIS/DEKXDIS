import React from 'react';
import { useFreshTimestamp } from '../hooks/useFreshTimestamp';
import { calculateTradeMetrics } from '../utils/tradeMetrics';
import { 
  TrendingUp, 
  TrendingDown, 
  DollarSign, 
  Repeat, 
  Award,
  ArrowUpRight,
  ArrowDownLeft
} from 'lucide-react';
import { TradeOrder, MarketPrice, TokenConfig } from '../types/trading';
import { formatTokenDisplay } from '../utils/displayFormat';
import { systemLogService } from '../services/systemLogService';

interface TradeMetricsProps {
  orders: TradeOrder[];
  accountingError?: string;
  marketPrice: MarketPrice;
  selectedToken?: TokenConfig;
  selectedChainId?: number;
  selectedTokenSymbol?: string;
  walletTradeCard?: React.ReactNode;
}

export const TradeMetrics: React.FC<TradeMetricsProps> = ({
  orders,
  accountingError,
  marketPrice,
  selectedToken,
  selectedChainId,
  selectedTokenSymbol = 'TOKEN',
  walletTradeCard,
}) => {
  const tokenSymbol = selectedToken?.symbol || selectedTokenSymbol;
  const priceFresh = useFreshTimestamp(marketPrice.lastUpdated);
  const metrics = selectedToken ? calculateTradeMetrics(orders, { ...selectedToken, chainId: selectedChainId || selectedToken.chainId }, priceFresh ? marketPrice.price : 0) : null;
  const totalVolumeUsdt = metrics?.volume || 0;
  const totalTrades = metrics?.totalTrades || 0;
  const buyOrders = { length: metrics?.buys || 0 };
  const sellOrders = { length: metrics?.sells || 0 };
  const avgBuyPrice = metrics?.averageBuyPrice || 0;
  const unrealizedPnlUsdt = accountingError ? null : metrics?.unrealized ?? null;
  const realizedPnlUsd = accountingError ? null : metrics?.realized ?? null;
  const pnlPercent = metrics?.pnlPercent || 0;
  const metricsTitle = `Moving-average cost from recorded fills; excludes external holdings and network gas. ${metrics?.missingFills || 0} fills lack executed amounts.`;
  const pnlIssue = accountingError || metrics?.issues.join('; ') || (metrics && metrics.unrealized === null ? 'Current token USD price unavailable' : '');
  const reportedPnlIssues = React.useRef(new Map<string, string>());
  const pnlScope = `${selectedChainId}:${selectedToken?.address.toLowerCase()}`;
  React.useEffect(() => {
    const previous = reportedPnlIssues.current.get(pnlScope);
    if (pnlIssue && pnlIssue !== previous) systemLogService.logError('ORDER', 'Token PnL unavailable', `${tokenSymbol}: ${pnlIssue}`, selectedChainId);
    if (!pnlIssue && previous) systemLogService.logInfo('ORDER', 'Token PnL recovered', tokenSymbol, selectedChainId);
    reportedPnlIssues.current.set(pnlScope, pnlIssue);
  }, [pnlIssue, pnlScope, tokenSymbol, selectedChainId]);

  return (
    <div className={`grid grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_minmax(280px,2fr)] gap-2.5 ${walletTradeCard ? 'xl:grid-cols-[repeat(3,minmax(0,1fr))_minmax(280px,2fr)_minmax(520px,2fr)]' : ''}`}>
      
      {/* 1. Total Volume */}
      <div title={metricsTitle} className="bg-surface/90 border border-surface-border rounded-xl px-3.5 py-2 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded-lg bg-cyan-500/10 text-cow-cyan shrink-0">
            <DollarSign className="w-3.5 h-3.5" />
          </div>
          <div>
            <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider block">
              Traded Volume
            </span>
            <div className="text-sm font-bold font-mono text-white leading-tight">
              ${totalVolumeUsdt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
        </div>
      </div>

      {/* 2. Total Trades Breakdown */}
      <div title={metricsTitle} className="bg-surface/90 border border-surface-border rounded-xl px-3.5 py-2 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded-lg bg-amber-500/10 text-bnb-yellow shrink-0">
            <Repeat className="w-3.5 h-3.5" />
          </div>
          <div>
            <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider block">
              Executions
            </span>
            <div className="text-sm font-bold font-mono text-white leading-tight flex items-center gap-2">
              <span>{totalTrades} Swaps</span>
              <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-0.5">
                <ArrowDownLeft className="w-2.5 h-2.5" /> {buyOrders.length}B
              </span>
              <span className="text-[10px] font-mono text-amber-400 flex items-center gap-0.5">
                <ArrowUpRight className="w-2.5 h-2.5" /> {sellOrders.length}S
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Average Buy Price vs Current Market */}
      <div title={metricsTitle} className="bg-surface/90 border border-surface-border rounded-xl px-3.5 py-2 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded-lg bg-indigo-500/10 text-indigo-400 shrink-0">
            <Award className="w-3.5 h-3.5" />
          </div>
          <div>
            <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider block">
              Avg Buy Price ({selectedTokenSymbol})
            </span>
            <div className="text-sm font-bold font-mono text-white leading-tight">
              {avgBuyPrice > 0 ? `$${formatTokenDisplay(avgBuyPrice)}` : 'No Buys Yet'}
            </div>
          </div>
        </div>
      </div>

      {/* 4. Estimated PnL */}
      <div title={metricsTitle} className="col-span-2 lg:col-span-1 bg-surface/90 border border-surface-border rounded-xl px-3.5 py-2 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-2">
          <div className={`p-1 rounded-lg shrink-0 ${unrealizedPnlUsdt === null ? 'text-slate-400' : unrealizedPnlUsdt >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
            {unrealizedPnlUsdt === null || unrealizedPnlUsdt >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
          </div>
          <div className="flex items-center gap-4 whitespace-nowrap">
            <div>
            <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider block">
              Unrealized PnL
            </span>
            <div className={`text-sm font-bold font-mono leading-tight ${unrealizedPnlUsdt === null ? 'text-slate-400' : unrealizedPnlUsdt >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {unrealizedPnlUsdt === null ? 'Unavailable' : `${unrealizedPnlUsdt >= 0 ? '+' : '-'}$${Math.abs(unrealizedPnlUsdt).toFixed(2)}`}
              {unrealizedPnlUsdt !== null && <span className="text-[10px] font-mono ml-1.5">
                ({pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%)
              </span>}
            </div>
            </div>
            <div>
            <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider block">Realized PnL</span>
            <div className={`text-sm font-bold font-mono leading-tight ${realizedPnlUsd === null ? 'text-slate-400' : realizedPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {realizedPnlUsd === null ? 'Unavailable' : `${realizedPnlUsd >= 0 ? '+' : '-'}$${Math.abs(realizedPnlUsd).toFixed(2)} USD`}
            </div>
            </div>
          </div>
        </div>
      </div>

      {walletTradeCard}
    </div>
  );
};
