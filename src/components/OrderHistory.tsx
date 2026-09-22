import { orderAmountUsd, historyTokenSide } from '../utils/orderHistory';
import { isLegacyStatusWarning } from '../services/cowRequests';
import React, { useMemo, useRef, useState } from 'react';
import { 
  History, 
  ExternalLink, 
  Clock, 
  CheckCircle2, 
  XCircle, 
  ArrowUpRight, 
  ArrowDownLeft, 
  Download, 
  Trash2,
  RefreshCw,
  ShieldAlert
} from 'lucide-react';
import { TradeOrder, TokenConfig } from '../types/trading';
import { getChainConfig } from '../types/chains';
import { formatTokenDisplay, formatUsdDisplay } from '../utils/displayFormat';
import { buildFilledExitPnls, historyPrice, orderHistoryTab, OrderHistoryTab, userOrderId } from '../utils/orderHistory';
import { openExplorerLink } from '../services/explorerLinks';
import type { OrderFundingStatus } from '../utils/orderFunding';

interface OrderHistoryProps {
  orders: TradeOrder[];
  fundingStatuses?: Map<string, OrderFundingStatus>;
  selectedToken?: TokenConfig;
  selectedChainId?: number;
  onClearOrders: (tokenAddress?: string, chainId?: number) => void;
  onRefreshStatuses: () => void;
  onCancelOrder?: (orderId: string) => void;
  onSelectOrder: (order: TradeOrder) => void;
  isRefreshing: boolean;
}

export const OrderHistory: React.FC<OrderHistoryProps> = ({
  orders,
  fundingStatuses,
  selectedToken,
  selectedChainId,
  onClearOrders,
  onRefreshStatuses,
  onCancelOrder,
  onSelectOrder,
  isRefreshing,
}) => {
  const [scope, setScope] = useState<'TOKEN' | 'ALL'>('TOKEN');
  const [filterType, setFilterType] = useState<'ALL' | 'SELL' | 'BUY' | 'LIMIT'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusTab, setStatusTab] = useState<OrderHistoryTab>('WAITING');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pnlByOrder = useMemo(() => buildFilledExitPnls(orders), [orders]);

  const baseFilteredOrders = orders.filter((o) => {
    // 1. Token / Chain Scope Isolation
    if (scope === 'TOKEN' && selectedToken) {
      const lowerSelected = selectedToken.address.toLowerCase();
      const matchesToken =
        o.sellToken?.toLowerCase() === lowerSelected ||
        o.buyToken?.toLowerCase() === lowerSelected ||
        o.sellSymbol === selectedToken.symbol ||
        o.buySymbol === selectedToken.symbol;
      const matchesChain = !selectedChainId || !o.chainId || o.chainId === selectedChainId;
      if (!matchesToken || !matchesChain) return false;
    }

    // Helper for identifying stable / quote tokens across chains
    const isQuoteSymbol = (sym?: string) => {
      if (!sym) return false;
      return sym.startsWith('USDT') || sym.startsWith('USDC') || sym === 'DAI' || sym === 'WXDAI' || sym === 'FDUSD';
    };

    // 2. Order Category / Side Filter
    if (filterType === 'LIMIT') {
      if (!o.orderCategory || o.orderCategory === 'market') return false;
    } else if (filterType === 'SELL') {
      if (historyTokenSide(o) === 'sell' || o.type === 'BNB_TO_USDT' || o.orderCategory === 'limit_sell' || o.orderCategory === 'take_profit' || o.orderCategory === 'stop_loss' || o.orderCategory === 'strategy_sell') {
        // match sell
      } else {
        return false;
      }
    } else if (filterType === 'BUY') {
      if (historyTokenSide(o) === 'buy' || o.type === 'USDT_TO_BNB' || o.orderCategory === 'limit' || o.orderCategory === 'strategy_buy') {
        // match buy
      } else {
        return false;
      }
    }

    // 3. Search Query Filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        o.id.toLowerCase().includes(q) ||
        (o.externalOrderId && o.externalOrderId.toLowerCase().includes(q)) ||
        (o.ocoGroupId && o.ocoGroupId.toLowerCase().includes(q)) ||
        (o.sellSymbol && o.sellSymbol.toLowerCase().includes(q)) ||
        (o.buySymbol && o.buySymbol.toLowerCase().includes(q)) ||
        o.sellAmount.includes(q) ||
        o.buyAmount.includes(q) ||
        (o.txHash && o.txHash.toLowerCase().includes(q))
      );
    }
    return true;
  });
  const historyTabs: Array<{ id: OrderHistoryTab; label: string }> = [
    { id: 'WAITING', label: 'Waiting for solver' },
    { id: 'FILLED', label: 'Filled' },
    { id: 'CANCELLED', label: 'Cancelled' },
  ];
  const tabCounts = new Map(historyTabs.map(tab => [tab.id, baseFilteredOrders.filter(order => orderHistoryTab(order) === tab.id).length]));
  const filteredOrders = baseFilteredOrders.filter(order => orderHistoryTab(order) === statusTab);

  const selectAdjacentTab = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % historyTabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + historyTabs.length) % historyTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = historyTabs.length - 1;
    else return;
    event.preventDefault();
    setStatusTab(historyTabs[next].id);
    tabRefs.current[next]?.focus();
  };

  const exportCsv = () => {
    if (orders.length === 0) return;
    const headers = ['Order ID', 'Chain ID', 'Type', 'Category', 'Timestamp', 'Sell Amount', 'Sell Symbol', 'Buy Amount', 'Buy Symbol', 'Execution Price', 'Status', 'PnL USD', 'Tx Hash', 'Explorer URL'];
    const rows = orders.map((o) => [
      userOrderId(o) || '',
      o.chainId || 56,
      o.type,
      o.orderCategory || '',
      new Date(o.timestamp).toISOString(),
      o.sellAmount,
      o.sellSymbol,
      o.buyAmount,
      o.buySymbol,
      historyPrice(o)?.toFixed(4) ?? '',
      o.status,
      pnlByOrder.get(o.id) ?? '',
      o.txHash || '',
      o.explorerUrl,
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `cow_trades_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getStatusBadge = (order: TradeOrder): React.ReactNode => {
    const submittedExit = order.isConditional && orders.find(o => o.previousOrderId === order.id && (o.status === 'open' || o.status === 'pending'));
    if (submittedExit) return getStatusBadge(submittedExit);
    const error = order.submissionError || (isLegacyStatusWarning(order.protectionError) ? undefined : order.protectionError);
    if (error) return <span className="text-rose-300 text-xs" title={error}>Needs attention: {error}</span>;
    if ((order.status === 'open' || order.status === 'pending') && (order.isConditional || order.id.startsWith('sl_'))) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/30 animate-pulse">
          <ShieldAlert className="w-2.5 h-2.5" /> Local stop · app must stay online
        </span>
      );
    }
    switch (order.status) {
      case 'fulfilled':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="w-2.5 h-2.5" /> Fulfilled
          </span>
        );
      case 'open':
      case 'pending':
        const funding = fundingStatuses?.get(order.id);
        if (funding && funding.state !== 'sufficient') return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/10 text-rose-300 border border-rose-500/20" title={funding.details}>
            <ShieldAlert className="w-2.5 h-2.5" />
            {funding.state === 'insufficient' ? `Insufficient ${order.sellSymbol} balance` : 'Balance unavailable'}
          </span>
        );
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <RefreshCw className="w-2.5 h-2.5 animate-spin" /> In Solver Batch
          </span>
        );
      case 'cancelled':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <XCircle className="w-2.5 h-2.5" /> Cancelled
          </span>
        );
      case 'expired':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-500/10 text-slate-400 border border-slate-500/20">
            <Clock className="w-2.5 h-2.5" /> Expired
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="bg-surface/90 border border-surface-border rounded-xl p-3 shadow-lg flex flex-col h-full min-h-0">
      
      {/* Table Header Controls */}
      <div className="flex items-center justify-between gap-2 pb-2 mb-2 border-b border-surface-border shrink-0 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded-lg bg-indigo-500/10 text-indigo-400">
            <History className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-white flex items-center gap-2">
              Order History
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-background border border-surface-border text-slate-400">
                {filteredOrders.length} / {orders.length}
              </span>
            </h3>
          </div>
        </div>

        {/* Filter Chips, Scope Selector & Action Buttons */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Token Scope Selector */}
          <div className="flex items-center bg-background border border-surface-border rounded-md p-0.5 text-[10px] font-mono mr-1">
            <button
              onClick={() => setScope('TOKEN')}
              className={`px-2 py-0.5 rounded transition-all font-bold ${
                scope === 'TOKEN'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Show trades for active selected token only"
            >
              {selectedToken ? selectedToken.symbol : 'Active Token'}
            </button>
            <button
              onClick={() => setScope('ALL')}
              className={`px-2 py-0.5 rounded transition-all font-bold ${
                scope === 'ALL'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Show trades across all tokens and chains"
            >
              All Tokens
            </button>
          </div>

          {(['ALL', 'LIMIT', 'SELL', 'BUY'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setFilterType(t)}
              className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-all ${
                filterType === t
                  ? 'bg-bnb-yellow text-slate-950 font-bold'
                  : 'bg-background text-slate-400 hover:text-slate-200 border border-surface-border'
              }`}
            >
              {t === 'ALL' ? 'All' : t === 'LIMIT' ? 'Limit / Brackets' : t === 'SELL' ? 'Sells' : 'Buys'}
            </button>
          ))}

          <button
            onClick={onRefreshStatuses}
            disabled={isRefreshing}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface border border-surface-border hover:border-slate-600 text-[10px] font-medium text-slate-300 hover:text-white transition-colors"
            title="Poll CoW API for Status"
          >
            <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin text-bnb-yellow' : ''}`} />
            <span className="hidden sm:inline">Sync</span>
          </button>

          {orders.length > 0 && (
            <>
              <button
                onClick={exportCsv}
                className="p-1 rounded-md bg-surface border border-surface-border hover:border-slate-600 text-slate-300 hover:text-white transition-colors"
                title="Export CSV"
              >
                <Download className="w-3 h-3" />
              </button>

              <button
                onClick={() => {
                  if (scope === 'TOKEN' && selectedToken) {
                    if (confirm(`Clear completed history for ${selectedToken.symbol}?`)) {
                      onClearOrders(selectedToken.address, selectedChainId);
                    }
                  } else {
                    if (confirm('Clear completed history across all tokens?')) {
                      onClearOrders();
                    }
                  }
                }}
                className="p-1 rounded-md bg-rose-500/10 border border-rose-500/20 hover:bg-rose-500/20 text-rose-400 transition-colors"
                title={scope === 'TOKEN' && selectedToken ? `Clear ${selectedToken.symbol} History` : 'Clear All History'}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </>
          )}
        </div>
      </div>

      <div role="tablist" aria-label="Order history status" className="flex items-center gap-1 mb-2 shrink-0 border-b border-surface-border">
        {historyTabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={node => { tabRefs.current[index] = node; }}
            type="button"
            role="tab"
            id={`order-history-tab-${tab.id.toLowerCase()}`}
            aria-selected={statusTab === tab.id}
            aria-controls="order-history-panel"
            tabIndex={statusTab === tab.id ? 0 : -1}
            onClick={() => setStatusTab(tab.id)}
            onKeyDown={event => selectAdjacentTab(event, index)}
            className={`px-3 py-1.5 text-[11px] font-semibold border-b-2 transition-colors ${
              statusTab === tab.id
                ? 'border-bnb-yellow text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab.label} <span className="font-mono text-[9px] text-slate-500">({tabCounts.get(tab.id) || 0})</span>
          </button>
        ))}
      </div>

      {/* Table Scrollable Container */}
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        role="tabpanel"
        id="order-history-panel"
        aria-labelledby={`order-history-tab-${statusTab.toLowerCase()}`}
      >
        {filteredOrders.length === 0 ? (
          <div className="text-center py-6 border border-dashed border-surface-border rounded-lg">
            <History className="w-6 h-6 text-slate-600 mx-auto mb-1.5" />
            <div className="text-xs font-semibold text-slate-300">No {historyTabs.find(tab => tab.id === statusTab)?.label.toLowerCase()} orders</div>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Executed trades and CoW batch auction settlement statuses will stream here in real-time.
            </p>
          </div>
        ) : (
          <table className="w-full text-left text-xs font-mono">
            <thead className="sticky top-0 bg-surface z-10">
              <tr className="border-b border-surface-border text-slate-400 uppercase text-[9px] tracking-wider">
                <th className="pb-1.5 pl-1.5">Time</th>
                <th className="pb-1.5">Pair / Side</th>
                <th className="pb-1.5">Token amount traded</th>
                <th className="pb-1.5">USD value</th>
                <th className="pb-1.5">Execution Price</th>
                <th className="pb-1.5">PnL</th>
                <th className="pb-1.5">Status</th>
                <th className="pb-1.5 text-right pr-1.5">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border/30">
              {filteredOrders.map((order) => {
                const isLimit = order.orderCategory === 'limit';
                const isLimitSell = order.orderCategory === 'limit_sell';
                const isTp = order.orderCategory === 'take_profit';
                const isSl = order.orderCategory === 'stop_loss';
                const isStrategyBuy = order.orderCategory === 'strategy_buy';
                const chainConf = getChainConfig(order.chainId || 56);
                const displayId = userOrderId(order);
                const pnl = pnlByOrder.get(order.id);
                const price = historyPrice(order);
                const tokenSide = historyTokenSide(order);
                const isFilled = order.status === 'fulfilled';
                const tokenAmount = isFilled
                  ? tokenSide === 'buy' ? order.executedBuyAmount : order.executedSellAmount
                  : tokenSide === 'buy' ? order.buyAmount : order.sellAmount;
                const tokenSymbol = tokenSide === 'buy' ? order.buySymbol : order.sellSymbol;
                const hasTokenAmount = tokenAmount !== undefined && tokenAmount.trim() !== '' &&
                  Number.isFinite(Number(tokenAmount)) && Number(tokenAmount) > 0;
                const usdValue = orderAmountUsd(order, tokenSide);

                return (
                  <tr key={order.id} className="hover:bg-surface-hover/50 transition-colors cursor-pointer"
                    tabIndex={0} aria-label={`Open workspace for ${order.sellSymbol} / ${order.buySymbol}`}
                    onClick={() => onSelectOrder(order)}
                    onKeyDown={event => {
                      if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        onSelectOrder(order);
                      }
                    }}>
                    
                    {/* Time */}
                    <td className="py-2 pl-1.5 text-[11px] text-slate-400 whitespace-nowrap">
                      {new Date(order.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </td>

                    {/* Pair & Side Badge */}
                    <td className="py-2 whitespace-nowrap">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {displayId && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-extrabold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                              [{displayId}]
                            </span>
                          )}
                          {isTp ? (
                            <span className="flex items-center gap-0.5 text-[11px] font-bold text-emerald-400">
                              <ArrowUpRight className="w-3 h-3" /> TP SELL ({order.sellSymbol})
                            </span>
                          ) : isSl ? (
                            <span className="flex items-center gap-0.5 text-[11px] font-bold text-rose-400">
                              <ArrowUpRight className="w-3 h-3" /> SL SELL ({order.sellSymbol})
                            </span>
                          ) : isLimitSell ? (
                            <span className="flex items-center gap-0.5 text-[11px] font-bold text-rose-400">
                              <ArrowUpRight className="w-3 h-3" /> LIMIT SELL ({order.sellSymbol})
                            </span>
                          ) : isLimit || isStrategyBuy ? (
                            <span className="flex items-center gap-0.5 text-[11px] font-bold text-emerald-400">
                              <ArrowDownLeft className="w-3 h-3" /> {isStrategyBuy ? 'AUTO BUY' : 'LIMIT BUY'} ({order.buySymbol})
                            </span>
                          ) : (
                            <span className="flex items-center gap-0.5 text-[11px] font-semibold text-slate-200">
                              <ArrowUpRight className="w-3 h-3 text-cyan-400" /> {order.sellSymbol} → {order.buySymbol}
                            </span>
                          )}
                        </div>

                        {/* Bracket Subtitle if any */}
                        {order.bracket && isLimit && (
                          <div className="text-[9px] text-slate-500 font-mono flex items-center gap-1">
                            {order.bracket.tpEnabled && (
                              <span className="text-emerald-400/80">TP: ${formatTokenDisplay(order.bracket.tpPrice)}</span>
                            )}
                            {order.bracket.tpEnabled && order.bracket.slEnabled && <span>|</span>}
                            {order.bracket.slEnabled && (
                              <span className="text-rose-400/80">SL: ${formatTokenDisplay(order.bracket.slPrice)}</span>
                            )}
                          </div>
                        )}
                      </div>
                    </td>

                    {/* Position token quantity, using confirmed amounts for fills */}
                    <td className="py-2 text-[11px] font-semibold text-slate-200 whitespace-nowrap">
                      <span title={hasTokenAmount ? `${tokenAmount} ${tokenSymbol}` : undefined}>
                        {hasTokenAmount ? `${isFilled ? '' : 'Est. '}${formatTokenDisplay(tokenAmount!)} ${tokenSymbol}` : 'Unavailable'}
                      </span>
                    </td>

                    {/* USD equivalent of the position token quantity */}
                    <td className="py-2 text-[11px] font-semibold text-emerald-400 whitespace-nowrap">
                      <span>{usdValue === undefined ? 'Unavailable' : `${isFilled ? '' : 'Est. '}$${formatUsdDisplay(usdValue)} USD`}</span>
                    </td>

                    {/* Execution Price */}
                    <td className="py-2 text-[11px] text-slate-300 whitespace-nowrap">
                      {price === undefined ? 'Unavailable' : `$${formatTokenDisplay(price)}`}
                    </td>

                    {/* Realized TP / SL PnL from confirmed fills */}
                    <td className={`py-2 text-[11px] font-semibold whitespace-nowrap ${pnl === undefined ? 'text-slate-500' : pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {order.status === 'fulfilled' && (isTp || isSl)
                        ? pnl === undefined ? 'Unavailable' : `${pnl >= 0 ? '+' : '-'}$${formatUsdDisplay(Math.abs(pnl))}`
                        : '—'}
                    </td>

                    {/* Status */}
                    <td className="py-2 whitespace-nowrap">
                      {getStatusBadge(order)}
                    </td>

                    {/* Actions & Links */}
                    <td className="py-2 text-right pr-1.5 space-x-1.5 whitespace-nowrap">
                      {(order.status === 'open' || order.status === 'pending') && onCancelOrder && (
                        <button
                          onClick={event => { event.stopPropagation(); onCancelOrder(order.id); }}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-[10px] border border-rose-500/20 transition-colors"
                          title="Cancel Order"
                        >
                          <span>Cancel</span>
                        </button>
                      )}

                      {order.explorerUrl ? (
                        <a
                          href={order.explorerUrl}
                          onClick={event => { event.preventDefault(); event.stopPropagation(); void openExplorerLink(order.explorerUrl); }}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-cyan-950/60 hover:bg-cyan-900 text-cow-cyan text-[10px] border border-cow-cyan/30 transition-colors"
                          title="View on CoW Explorer"
                        >
                          <span>CoW</span>
                          <ExternalLink className="w-2 h-2" />
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-surface text-slate-500 text-[10px] border border-surface-border">
                          <span>Local Trigger</span>
                        </span>
                      )}

                      {order.txHash && (
                        <a
                          href={chainConf.txUrl(order.txHash)}
                          onClick={event => { event.preventDefault(); event.stopPropagation(); void openExplorerLink(chainConf.txUrl(order.txHash!)); }}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-surface hover:bg-slate-700 text-slate-300 text-[10px] border border-surface-border transition-colors"
                          title={`View on ${chainConf.explorerName}`}
                        >
                          <span>{chainConf.shortName}</span>
                          <ExternalLink className="w-2 h-2" />
                        </a>
                      )}
                    </td>

                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
};
