import { STRATEGIES_ENABLED, getStrategiesEnabled, subscribeReleaseFeatures } from './config/releaseFeatures';
import { bridgeJournal } from './services/bridgeJournal';
import { nativeStore } from './services/nativeStore';
import { executionEngine, exclusive } from './services/executionEngine';
import React, { useState, useSyncExternalStore, useEffect, useCallback, useRef, useMemo } from 'react';
import { Header } from './components/Header';
import { WalletCard } from './components/WalletCard';
import { WalletTradeDropdown } from './components/WalletTradeDropdown';
import { TradingPanel } from './components/TradingPanel';
import { TradingViewChart } from './components/TradingViewChart';
import { TradeMetrics } from './components/TradeMetrics';
import { OrderHistory } from './components/OrderHistory';
import { historyTokenSide } from './utils/orderHistory';
import { orderFundingStatus, OrderFundingSnapshot, OrderFundingStatus } from './utils/orderFunding';
import { AutomationWindow } from './automation/AutomationWindow';
import { automation } from './automation/runner';
import { WalletModal } from './components/WalletModal';
import { WalletChangeWarningModal } from './components/WalletChangeWarningModal';
import { CloseConfirmationModal } from './components/CloseConfirmationModal';
import { startupService } from './services/startupService';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';
import { WrapModal } from './components/WrapModal';
import { SettingsModal } from './components/SettingsModal';
import { LimitOrderModal } from './components/LimitOrderModal';
import { AddTokenModal } from './components/AddTokenModal';
import { TokenAuditModal } from './components/TokenAuditModal';
import { ThemeSelectorModal } from './components/ThemeSelectorModal';
import { OverviewDashboard } from './components/OverviewDashboard';
import { 
  DraggableResizableWindow, 
  WindowLayout 
} from './components/DraggableResizableWindow';
import { ThemeId } from './types/theme';

import { 
  WalletState, 
  WalletValuation,
  Balances, 
  AllowanceState, 
  TradeOrder, 
  MarketPrice, 
  ChartMarker,
  StrategyConfig,
  TokenConfig,
  DEFAULT_BSC_TOKENS
} from './types/trading';
import { DEFAULT_CHAIN_ID, getChainConfig, getTokensForChain } from './types/chains';
import { storageService } from './services/storageService';
import { web3Service } from './services/web3Service';
import { rpcService } from './services/rpcService';
import { cowProtocol } from './services/cowProtocol';
import { marketDataService } from './services/marketDataService';
import { binanceWebSocketService } from './services/binanceWebSocketService';
import { systemLogService } from './services/systemLogService';
import { CandlestickData, Time } from 'lightweight-charts';
import { formatAssetDisplay, formatTokenDisplay } from './utils/displayFormat';

export const App: React.FC = () => {
  const strategiesEnabled = useSyncExternalStore(subscribeReleaseFeatures, getStrategiesEnabled);
  // Global Chain & Token States
  const [selectedChainId, setSelectedChainId] = useState<number>(() => storageService.getSelectedChainId());
  const [wallet, setWallet] = useState<WalletState | null>(() => storageService.getWallet());
  const [customTokens, setCustomTokens] = useState<TokenConfig[]>(() => storageService.getCustomTokens());
  const [alphaTokensByChain, setAlphaTokensByChain] = useState<Record<number, TokenConfig[]>>({});
  const [selectedToken, setSelectedToken] = useState<TokenConfig>(() => {
    const saved = storageService.getSelectedToken();
    if (saved) return saved;
    const chainTokens = getTokensForChain(storageService.getSelectedChainId());
    return chainTokens[0] || DEFAULT_BSC_TOKENS[0];
  });
  const [strategyConfig, setStrategyConfig] = useState<StrategyConfig>(() => {
    const savedTok = storageService.getSelectedToken();
    const activeCId = storageService.getSelectedChainId();
    if (savedTok) {
      const tokenStrategies = storageService.getTokenStrategies();
      const key = `${savedTok.chainId || activeCId}_${savedTok.address.toLowerCase()}`;
      if (tokenStrategies[key]) {
        return tokenStrategies[key];
      }
    }
    return storageService.getStrategyConfig();
  });

  const activeAlphaTokens = useMemo(() => {
    return alphaTokensByChain[selectedChainId] || marketDataService.getCachedAlphaTokens(selectedChainId);
  }, [alphaTokensByChain, selectedChainId]);

  const [balances, setBalances] = useState<Balances>({
    bnb: '0.0000',
    wbnb: '0.0000',
    usdt: '0.00',
    totalUsdValue: '0.00',
    isLoading: false,
    lastUpdated: Date.now(),
    tokenBalances: {},
  });
  const [allowances, setAllowances] = useState<AllowanceState>({
    wbnbAllowed: false,
    usdtAllowed: false,
    isChecking: false,
    tokenAllowances: {},
  });
  const [orders, setOrders] = useState<TradeOrder[]>(() => storageService.getOrders());
  const accountingHistory = useMemo(() => {
    try { return { orders: storageService.getAccountingOrders(orders), error: undefined }; }
    catch (error) { return { orders, error: `Accounting history unavailable: ${String(error)}` }; }
  }, [orders]);
  const [fundingSnapshot, setFundingSnapshot] = useState<OrderFundingSnapshot>();
  const [walletValuation, setWalletValuation] = useState<WalletValuation>();
  const reportedValuationErrors = useRef(new Map<string, string>());
  const valuationsInFlight = useRef(new Set<string>());
  const blockedValuations = useRef(new Set<string>());
  const fundingStatuses = useMemo(() => {
    const result = new Map<string, OrderFundingStatus>();
    const snapshot = fundingSnapshot?.ownerAddress.toLowerCase() === wallet?.address.toLowerCase() &&
      fundingSnapshot?.chainId === selectedChainId ? fundingSnapshot : undefined;
    for (const order of orders) {
      const status = orderFundingStatus(order, snapshot);
      if (status) result.set(order.id, status);
    }
    return result;
  }, [orders, fundingSnapshot, wallet?.address, selectedChainId]);
  const reportedFunding = useRef(new Map<string, string>());
  const reportedFundingErrors = useRef(new Map<string, string>());
  useEffect(() => {
    for (const order of orders) {
      const funding = fundingStatuses.get(order.id);
      if (!funding) continue;
      const key = `${order.ownerAddress}:${order.chainId}:${order.id}`;
      const tag = order.externalOrderId || order.ocoGroupId || order.id;
      if (funding.state === 'unavailable') {
        // Startup/another chain is unobserved, not a failed balance check.
        if (fundingSnapshot && fundingSnapshot.chainId === selectedChainId && fundingSnapshot.chainId === order.chainId &&
            fundingSnapshot.ownerAddress.toLowerCase() === wallet?.address.toLowerCase() &&
            fundingSnapshot.ownerAddress.toLowerCase() === order.ownerAddress?.toLowerCase() &&
            reportedFundingErrors.current.get(key) !== funding.details) {
          reportedFundingErrors.current.set(key, funding.details);
          systemLogService.logError('ORDER', `${tag}: Balance unavailable`, funding.details, order.chainId);
        }
        continue;
      }
      if (reportedFundingErrors.current.delete(key)) {
        systemLogService.logInfo('ORDER', `${tag}: Balance check recovered`, funding.details, order.chainId);
      }
      const previous = reportedFunding.current.get(key);
      if (previous === funding.state) continue;
      reportedFunding.current.set(key, funding.state);
      if (funding.state === 'insufficient') {
        systemLogService.logWarning('ORDER', `${tag}: Insufficient ${order.sellSymbol} balance`, funding.details, order.chainId);
      } else if (previous === 'insufficient') {
        systemLogService.logInfo('ORDER', `${tag}: ${order.sellSymbol} balance restored`, `${funding.details} Waiting for solver settlement.`, order.chainId);
      }
    }
  }, [orders, fundingStatuses, fundingSnapshot, selectedChainId, wallet?.address]);
  const activeLadders = useSyncExternalStore(automation.subscribe, automation.activeWorkspaces);
  const [chartMarkers, setChartMarkers] = useState<ChartMarker[]>(() =>
    storageService.getChartMarkers(selectedToken?.address, storageService.getSelectedChainId())
  );
  const [candles, setCandles] = useState<CandlestickData<Time>[]>([]);

  const [marketPrice, setMarketPrice] = useState<MarketPrice>({
    price: 0,
    change24h: 0,
    high24h: 0,
    low24h: 0,
    volume24h: 0,
    lastUpdated: Date.now(),
    symbol: selectedToken.symbol,
  });

  const [nativePrice, setNativePrice] = useState<number>(0);
  const [nativePriceSnapshot, setNativePriceSnapshot] = useState<{ chainId: number; price: number; timestamp: number }>();
  const [tokenPriceSnapshot, setTokenPriceSnapshot] = useState<{ chainId: number; address: string; price: number; timestamp: number }>();

  const [slippage, setSlippage] = useState<number>(() => storageService.getSlippage());
  const [stopLossSlippage, setStopLossSlippage] = useState<number>(() => storageService.getStopLossSlippage());
  const [isOverviewOpen, setIsOverviewOpen] = useState<boolean>(() => storageService.getIsOverviewOpen());
  const [currentTheme, setCurrentTheme] = useState<ThemeId>(() => storageService.getTheme());
  const [isThemeModalOpen, setIsThemeModalOpen] = useState(false);
  const [walletChangeWarning, setWalletChangeWarning] = useState<{ ladderCount: number; orderCount: number } | null>(null);
  const [closeConfirmationOpen, setCloseConfirmationOpen] = useState(false);
  const walletChangeDecision = useRef<((confirmed: boolean) => void) | null>(null);
  const walletChangeRunning = useRef(false);

  useEffect(() => {
    storageService.saveIsOverviewOpen(isOverviewOpen);
  }, [isOverviewOpen]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', currentTheme);
    storageService.saveTheme(currentTheme);
  }, [currentTheme]);

  const handleSelectTheme = (themeId: ThemeId) => {
    setCurrentTheme(themeId);
    document.documentElement.setAttribute('data-theme', themeId);
    storageService.saveTheme(themeId);
  };

  // Modal States
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);
  const [walletModalMode, setWalletModalMode] = useState<'qr' | 'export' | 'import'>('qr');
  const [depositChainId, setDepositChainId] = useState<number>(DEFAULT_CHAIN_ID);
  const [isWrapModalOpen, setIsWrapModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isLimitModalOpen, setIsLimitModalOpen] = useState(false);
  const [isAddTokenModalOpen, setIsAddTokenModalOpen] = useState(false);
  const [isTokenAuditModalOpen, setIsTokenAuditModalOpen] = useState(false);
  const [clickedChartPrice, setClickedChartPrice] = useState<number>(0);
  const [clickedCandleTime, setClickedCandleTime] = useState<number>(0);
  const [activeChartTimeframe, setActiveChartTimeframe] = useState<string>(() => storageService.getChartSettings().interval || '15m');

  // Loading states
  const [isPriceLoading, setIsPriceLoading] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isSyncingOrders, setIsSyncingOrders] = useState(false);

  const latestRequestedChainRef = useRef<number>(selectedChainId);

  // Fetch Binance Alpha tokens across all supported chains
  const loadAlphaTokens = useCallback(async (chainId: number) => {
    latestRequestedChainRef.current = chainId;

    // 1. Instantly populate from synchronous memory cache if available
    const cached = marketDataService.getCachedAlphaTokens(chainId);
    if (cached.length > 0) {
      setAlphaTokensByChain((prev) => ({
        ...prev,
        [chainId]: cached,
      }));
    }

    try {
      const allChainsMap = await marketDataService.fetchAllBinanceAlphaTokens();
      const newChainMap: Record<number, TokenConfig[]> = {};
      allChainsMap.forEach((tokens, cId) => {
        newChainMap[cId] = tokens;
      });

      setAlphaTokensByChain((prev) => ({
        ...prev,
        ...newChainMap,
      }));
    } catch (e: any) {
      // The shared loader reports escalation/exhaustion once for all callers.
      console.error('Could not fetch Binance Alpha tokens:', e);
    }
  }, []);

  useEffect(() => {
    loadAlphaTokens(selectedChainId);
  }, [selectedChainId, loadAlphaTokens]);

  const strategyMarkers: ChartMarker[] = [];

  // Canvas ref for bounds calculation
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasBounds, setCanvasBounds] = useState<{ width: number; height: number }>({
    width: typeof window !== 'undefined' ? window.innerWidth : 1600,
    height: typeof window !== 'undefined' ? window.innerHeight - 100 : 900,
  });

  // Calculate default layouts dynamically
  const getDefaultLayouts = useCallback((width: number, height: number): Record<string, WindowLayout> => {
    // Wallet/manual trading now opens from the metrics strip. Keep the strategy
    // column's previous approximate width and give the freed column to the chart.
    const margin = Math.max(8, Math.min(12, Math.round(width * 12 / 2560)));
    const gap = Math.max(6, Math.min(10, Math.round(width * 6 / 2560)));
    const usableWidth = Math.max(700, width - margin * 2 - (STRATEGIES_ENABLED ? gap : 0));
    const ladderWidth = STRATEGIES_ENABLED ? Math.max(340, Math.floor(usableWidth * 430 / 2525)) : 0;
    const leftWidth = Math.max(360, usableWidth - ladderWidth);
    const ladderX = margin + leftWidth + gap;

    const usableHeight = Math.max(380, height - margin * 2);
    const heightScale = usableHeight / 921;
    const rowGap = Math.max(7, Math.round(7 * heightScale));
    const chartHeight = Math.max(200, Math.min(Math.floor(615 * heightScale), usableHeight - rowGap - 160));
    const ordersHeight = Math.max(160, Math.min(Math.floor(271 * heightScale), usableHeight - rowGap - chartHeight));

    return {
      chart: {
        id: 'chart',
        title: STRATEGIES_ENABLED ? 'Multi-Token Live Chart & Signals' : 'Multi-Token Live Chart',
        x: margin,
        y: margin,
        width: leftWidth,
        height: chartHeight,
        minWidth: 360,
        minHeight: 200,
        zIndex: 10,
      },
      orders: {
        id: 'orders',
        title: 'Trade & Intent Execution Log',
        x: margin,
        y: margin + chartHeight + rowGap,
        width: leftWidth,
        height: ordersHeight,
        minWidth: 340,
        minHeight: 160,
        zIndex: 11,
      },
      ladder: {
        id: 'ladder',
        title: 'Automation',
        x: ladderX,
        y: margin,
        width: ladderWidth,
        height: Math.max(380, Math.floor(883 * heightScale)),
        minWidth: 340,
        minHeight: 380,
        zIndex: 15,
      },
    };
  }, [strategiesEnabled]);

  // State for Impulse Ladder Window toggle (defaults to open on startup)
  const [isLadderOpen, setIsLadderOpen] = useState<boolean>(() => STRATEGIES_ENABLED && storageService.getIsLadderOpen());

  const handleToggleLadder = () => {
    if (!STRATEGIES_ENABLED) return;
    if (isOverviewOpen) {
      setIsOverviewOpen(false);
      setIsLadderOpen(true);
      storageService.saveIsLadderOpen(true);
      return;
    }
    setIsLadderOpen((prev) => {
      const next = !prev;
      storageService.saveIsLadderOpen(next);
      return next;
    });
  };

  // Initialize Window Layouts from localStorage
  const autoDefaultLayout = useRef(false);
  const [windows, setWindows] = useState<Record<string, WindowLayout>>(() => {
    const initW = typeof window !== 'undefined' ? window.innerWidth : 1600;
    const initH = typeof window !== 'undefined' ? window.innerHeight - 100 : 900;
    const defaults = getDefaultLayouts(initW, initH);
    const saved = storageService.getWindowLayouts();
    autoDefaultLayout.current = !saved || !Object.keys(defaults).some(key => saved[key]);

    if (saved && Object.keys(saved).length > 0) {
      const merged: Record<string, WindowLayout> = { ...defaults };
      Object.keys(defaults).forEach((key) => {
        if (saved[key]) {
          merged[key] = {
            ...defaults[key],
            ...saved[key],
            title: defaults[key].title,
          };
        }
      });
      return merged;
    }
    return defaults;
  });

  const wasStrategiesEnabled = useRef(strategiesEnabled);
  useEffect(() => {
    if (strategiesEnabled && !wasStrategiesEnabled.current) {
      setWindows(getDefaultLayouts(window.innerWidth, window.innerHeight - 100));
      setIsLadderOpen(true);
      setIsOverviewOpen(false);
    }
    wasStrategiesEnabled.current = strategiesEnabled;
  }, [strategiesEnabled, getDefaultLayouts]);

  const [topZIndex, setTopZIndex] = useState(25);

  useEffect(() => {
    const updateBounds = () => {
      if (canvasRef.current) {
        const w = canvasRef.current.clientWidth;
        const h = canvasRef.current.clientHeight;
        setCanvasBounds({ width: w, height: h });
        // Keep first-use defaults fitted as fonts and the metrics strip settle.
        // Saved or user-adjusted arrangements retain their own positions.
        if (autoDefaultLayout.current && w > 0 && h > 0) {
          setWindows(getDefaultLayouts(w, h));
        }
      }
    };

    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [isOverviewOpen, getDefaultLayouts]);

  useEffect(() => { rpcService.init(); }, []);

  const handleBringToFront = (id: string) => {
    autoDefaultLayout.current = false;
    const nextZ = topZIndex + 1;
    setTopZIndex(nextZ);
    setWindows((prev) => {
      const updated = {
        ...prev,
        [id]: {
          ...prev[id],
          zIndex: nextZ,
        },
      };
      storageService.saveWindowLayouts(updated);
      return updated;
    });
  };

  const handleUpdateLayout = (id: string, updates: Partial<WindowLayout>) => {
    autoDefaultLayout.current = false;
    setWindows((prev) => {
      const updated = {
        ...prev,
        [id]: {
          ...prev[id],
          ...updates,
        },
      };
      storageService.saveWindowLayouts(updated);
      return updated;
    });
  };

  const handleResetLayout = () => {
    autoDefaultLayout.current = false;
    const defaults = getDefaultLayouts(canvasBounds.width, canvasBounds.height);
    setWindows(defaults);
    storageService.saveWindowLayouts(defaults);
    systemLogService.logInfo('SYSTEM', 'Layout Reset', 'All windows restored to default arrangement and saved.');
  };

  // 1. Real-time WebSocket Price Subscription for currently selected token
  useEffect(() => {
    let active = true;
    const unsub = binanceWebSocketService.subscribePrice(
      selectedToken,
      (update) => {
        if (!active) return;
        setTokenPriceSnapshot({ chainId: selectedChainId, address: selectedToken.address, price: update.price, timestamp: update.timestamp });
        void executionEngine.observePrice(selectedToken.address, selectedChainId, update.price, update.timestamp).catch(error => systemLogService.logError('ORDER', 'Stop-loss price processing failed', String(error), selectedChainId));
        setMarketPrice((prev) => ({
          ...prev,
          price: update.price,
          high24h: update.high24h ?? prev.high24h,
          low24h: update.low24h ?? prev.low24h,
          volume24h: update.volume24h ?? prev.volume24h,
          change24h: update.change24h ?? prev.change24h,
          lastUpdated: update.timestamp,
        }));
      },
      selectedChainId
    );

    return () => {
      active = false;
      unsub();
    };
  }, [selectedToken, selectedChainId]);

  // 2. Background Multi-Token WebSocket Subscriptions for All Open SL/TP & Ladder Tokens
  const backgroundPriceSubscriptions = useRef(new Map<string, { stream: string; unsubscribe: () => void }>());
  useEffect(() => () => {
    backgroundPriceSubscriptions.current.forEach(sub => sub.unsubscribe());
    backgroundPriceSubscriptions.current.clear();
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: undefined | (() => void);
    let disposed = false;
    listen('dekxdis-close-requested', () => setCloseConfirmationOpen(true)).then(fn => { if (disposed) fn(); else unlisten = fn; })
      .catch(error => systemLogService.logError('SYSTEM', 'Close listener failed', String(error)));
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {

    // Collect all tokens with active Stop-Loss orders across any chain
    const openSlTokens = orders
      .filter((o) => (o.status === 'open' || o.status === 'pending') && (o.orderCategory === 'stop_loss' || o.isConditional))
      .map((o) => ({ address: o.sellToken.toLowerCase(), symbol: o.sellSymbol, chainId: o.chainId || selectedChainId }));

    // Keep enabled workspaces represented in the background price subscriptions
    const runningLadders = automation.activeWorkspaces();
    const ladderTokens = runningLadders
      .filter((l) => l.running)
      .map((l) => ({ address: l.tokenAddress.toLowerCase(), symbol: l.token.symbol, chainId: l.chainId }));

    // Merge unique tokens
    const tokenMap = new Map<string, { address: string; symbol: string; chainId: number }>();
    [...openSlTokens, ...ladderTokens].forEach((item) => {
      const key = `${item.chainId}_${item.address}`;
      if (!tokenMap.has(key)) {
        tokenMap.set(key, item);
      }
    });

    for (const [key, sub] of backgroundPriceSubscriptions.current) {
      if (!tokenMap.has(key)) { sub.unsubscribe(); backgroundPriceSubscriptions.current.delete(key); }
    }
    tokenMap.forEach((item, key) => {
      const known = [selectedToken, ...customTokens, ...getTokensForChain(item.chainId),
        ...(alphaTokensByChain[item.chainId] || []), ...storageService.getTrackedTokens(item.chainId)]
        .find(t => t.chainId === item.chainId && t.address.toLowerCase() === item.address);
      const tokCfg: TokenConfig = known || {
        symbol: item.symbol,
        name: item.symbol,
        address: item.address,
        decimals: 18,
        chainId: item.chainId,
      };
      const stream = JSON.stringify(binanceWebSocketService.getStreamSymbol(tokCfg, item.chainId));
      const existing = backgroundPriceSubscriptions.current.get(key);
      if (existing?.stream === stream) return;
      existing?.unsubscribe();
      const unsub = binanceWebSocketService.subscribePrice(
        tokCfg,
        (update) => {
          void executionEngine.observePrice(item.address, item.chainId, update.price, update.timestamp).catch(error => systemLogService.logError('ORDER', 'Stop-loss price processing failed', String(error), item.chainId));
        },
        item.chainId
      );
      backgroundPriceSubscriptions.current.set(key, { stream, unsubscribe: unsub });
    });
  }, [orders, selectedChainId, selectedToken, customTokens, alphaTokensByChain, activeLadders]);

  // Market Price Fetch for selected token (REST fallback / on-chain DEX query)
  const assetGeneration = useRef(0);
  useEffect(() => { assetGeneration.current++; setMarketPrice(p => ({ ...p, price: 0 })); setNativePrice(0); setCandles([]); }, [selectedToken.address, selectedChainId, wallet?.address]);
  const refreshMarketPrice = useCallback(async () => {
    const generation = assetGeneration.current;
    setIsPriceLoading(true);
    try {
      const priceData = await marketDataService.fetchTokenPrice(
        selectedToken.address,
        selectedChainId,
        selectedToken.binanceSymbol
      );
      if (generation === assetGeneration.current) {
        setMarketPrice(priceData);
        setTokenPriceSnapshot({ chainId: selectedChainId, address: selectedToken.address, price: priceData.price, timestamp: priceData.lastUpdated });
        await executionEngine.observePrice(selectedToken.address, selectedChainId, priceData.price, priceData.lastUpdated);
      }
    } catch (e: any) {
      systemLogService.logWarning(
        'MARKET_DATA',
        `Market Price Fetch Note: ${selectedToken.symbol}`,
        e?.message || String(e),
        selectedChainId
      );
    } finally {
      setIsPriceLoading(false);
    }
  }, [selectedToken, selectedChainId]);

  useEffect(() => {
    refreshMarketPrice();
    const interval = setInterval(refreshMarketPrice, 8000);
    return () => clearInterval(interval);
  }, [refreshMarketPrice]);

  // Dedicated Native Asset Price Poller (e.g. BNB for BSC, ETH for Ethereum/Arbitrum/Base, xDAI for Gnosis)
  const refreshNativePrice = useCallback(async () => {
    const generation = assetGeneration.current;
    try {
      const price = await marketDataService.fetchNativeTokenPrice(selectedChainId);
      if (price > 0 && generation === assetGeneration.current) {
        setNativePrice(price);
        setNativePriceSnapshot({ chainId: selectedChainId, price, timestamp: Date.now() });
      }
    } catch (e: any) {
      systemLogService.logWarning(
        'MARKET_DATA',
        `Native Price Fetch Note (Chain ${selectedChainId})`,
        e?.message || String(e),
        selectedChainId
      );
    }
  }, [selectedChainId]);

  useEffect(() => {
    refreshNativePrice();
    const interval = setInterval(refreshNativePrice, 10000);
    return () => clearInterval(interval);
  }, [refreshNativePrice]);

  // Expire the display conversion even if the next market request stalls.
  useEffect(() => {
    if (!nativePriceSnapshot) return;
    const timer = setTimeout(() => setNativePriceSnapshot(current => current === nativePriceSnapshot ? undefined : current),
      Math.max(0, nativePriceSnapshot.timestamp + 30000 - Date.now()));
    return () => clearTimeout(timer);
  }, [nativePriceSnapshot]);

  // Balance & Allowance Refresh
  const balanceRequest = useRef(0);
  const refreshBalances = useCallback(async (retryWalletValue = false) => {
    if (!wallet) return;
    const valuationKey = `${selectedChainId}:${wallet.address.toLowerCase()}`;
    // One valuation attempt per refresh; a terminal failure requires explicit retry.
    // Ordinary balance polling must not restart a failed price request forever.
    if (retryWalletValue === true) blockedValuations.current.delete(valuationKey);
    const request = ++balanceRequest.current;
    const generation = assetGeneration.current;
    setBalances((prev) => ({ ...prev, isLoading: true }));
    try {
      const chainCustomTokens = customTokens.filter((t) => (t.chainId || DEFAULT_CHAIN_ID) === selectedChainId);
      const orderTokens = storageService.getOrders().filter(order => order.chainId === selectedChainId &&
        order.ownerAddress?.toLowerCase() === wallet.address.toLowerCase() &&
        (order.status === 'open' || order.status === 'pending') && order.sellDecimals !== undefined)
        .map(order => ({ address: order.sellToken, symbol: order.sellSymbol, name: order.sellSymbol,
          decimals: order.sellDecimals!, chainId: selectedChainId }));
      const activeTokensToQuery = [selectedToken, ...chainCustomTokens, ...storageService.getTrackedTokens(selectedChainId), ...orderTokens];

      const { balances: newBalances, allowances: newAllowances } = await web3Service.getBalancesAndAllowances(
        wallet.address,
        selectedChainId,
        nativePrice,
        activeTokensToQuery,
        true
      );
      if (generation === assetGeneration.current && request === balanceRequest.current) {
        setBalances(newBalances); setAllowances(newAllowances);
        setFundingSnapshot({ ownerAddress: wallet.address, chainId: selectedChainId, balances: newBalances });
        // Display prices must not hold up refreshed balances or the calling trade.
        const valuationContext = { ownerAddress: wallet.address, chainId: selectedChainId, balanceUpdatedAt: newBalances.lastUpdated };
        const inFlightKey = `${generation}:${valuationKey}`;
        if (!blockedValuations.current.has(valuationKey) && !valuationsInFlight.current.has(inFlightKey)) {
          valuationsInFlight.current.add(inFlightKey);
          void web3Service.getWalletUsdValue(newBalances, selectedChainId, activeTokensToQuery).then(value => {
            if (generation !== assetGeneration.current) return;
            setWalletValuation({ ...valuationContext, ...value, updatedAt: Date.now() });
            if (reportedValuationErrors.current.delete(valuationKey)) {
              systemLogService.logInfo('WALLET', 'Wallet valuation recovered', `USD values refreshed for ${wallet.address}`, selectedChainId);
            }
          }).catch(error => {
            if (generation !== assetGeneration.current) return;
            blockedValuations.current.add(valuationKey);
            const message = error instanceof Error ? error.message : String(error);
            setWalletValuation(previous => ({ ...valuationContext,
              ...(previous?.chainId === selectedChainId && previous.ownerAddress.toLowerCase() === wallet.address.toLowerCase()
                ? { totalUsdValue: previous.totalUsdValue, tokenPricesUsd: previous.tokenPricesUsd, updatedAt: previous.updatedAt } : {}), error: message }));
            if (reportedValuationErrors.current.get(valuationKey) !== message) {
              reportedValuationErrors.current.set(valuationKey, message);
              systemLogService.logError('WALLET', 'Wallet valuation failed', `${wallet.address}: ${message}. Use Refresh Balances in wallet/trade to retry.`, selectedChainId);
            }
          }).finally(() => { valuationsInFlight.current.delete(inFlightKey); });
        }
      }
    } catch (e: any) {
      systemLogService.logError(
        'NETWORK',
        `Balance Refresh Failed (Chain ${selectedChainId})`,
        e?.message || String(e),
        selectedChainId
      );
      if (generation === assetGeneration.current) {
        setBalances(prev => ({ ...prev, error: e?.message || String(e) }));
        if (request === balanceRequest.current) setFundingSnapshot(prev => prev && ({ ...prev, balances: { ...prev.balances, error: e?.message || String(e) } }));
      }
    } finally {
      if (generation === assetGeneration.current) setBalances((prev) => ({ ...prev, isLoading: false }));
    }
  }, [wallet, nativePrice, customTokens, selectedToken, selectedChainId]);

  useEffect(() => {
    if (wallet) {
      refreshBalances();
      const interval = setInterval(refreshBalances, 12000);
      return () => clearInterval(interval);
    }
  }, [wallet, refreshBalances]);

  // A stable scheduler owns order reconciliation/protection independently of price renders.
  const syncOrderStatuses = useCallback(async () => {
    if (!wallet) return;
    setIsSyncingOrders(true);
    try { await executionEngine.tick(wallet); }
    catch (error) { systemLogService.logError('ORDER', 'Execution needs attention', String(error)); }
    finally { setIsSyncingOrders(false); }
  }, [wallet?.address]);
  useEffect(() => {
    const unsubscribe = storageService.subscribe(() => setOrders(storageService.getOrders()));
    return unsubscribe;
  }, []);
  useEffect(() => {
    syncOrderStatuses();
    const timer = setInterval(syncOrderStatuses, 5000);
    return () => clearInterval(timer);
  }, [syncOrderStatuses]);
  useEffect(() => {
    if (!wallet) return;
    const monitor = () => { void executionEngine.monitorStops(wallet).catch(error => systemLogService.logError('ORDER', 'Stop-loss monitor failed', String(error))); };
    monitor();
    const timer = setInterval(monitor, 1000);
    return () => clearInterval(timer);
  }, [wallet?.address]);
  useEffect(() => {
    const notice = nativeStore.getNotice();
    if (notice) systemLogService.logInfo('WALLET', 'Wallet storage', notice);
    const storageError = (event: Event) => systemLogService.logError('WALLET', 'Trading paused', String((event as CustomEvent).detail));
    window.addEventListener('dekxdis-storage-error', storageError);
    return () => window.removeEventListener('dekxdis-storage-error', storageError);
  }, []);

  useEffect(() => {
    if (!wallet) return;
    const poll = () => bridgeJournal.poll(wallet.address).catch(error => systemLogService.logError('BRIDGE', 'Transfer tracking failed', String(error)));
    void bridgeJournal.resumeTracking(wallet.address).then(poll).catch(error => systemLogService.logError('BRIDGE', 'Transfer tracking recovery failed', String(error)));
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [wallet?.address]);

  // Wallet Handlers
  useEffect(() => {
    if (wallet?.needsBackup) {
      setWalletModalMode('export');
      setIsWalletModalOpen(true);
    }
  }, [wallet?.address, wallet?.needsBackup]);

  const confirmWalletCleanup = useCallback((ladderCount: number, orderCount: number) => new Promise<boolean>(resolve => {
    walletChangeDecision.current = resolve;
    setWalletChangeWarning({ ladderCount, orderCount });
  }), []);

  const finishWalletChangeDecision = useCallback((confirmed: boolean) => {
    const resolve = walletChangeDecision.current;
    walletChangeDecision.current = null;
    setWalletChangeWarning(null);
    resolve?.(confirmed);
  }, []);

  const changeWalletSafely = useCallback(async (change: () => Promise<WalletState>) => {
    if (walletChangeRunning.current) throw new Error('A wallet change is already in progress.');
    const currentWallet = nativeStore.getWallet();
    const ladderCount = currentWallet ? automation.activeWorkspaces().length : 0;
    const orderCount = currentWallet ? storageService.getOrders().filter(order => order.status === 'open' || order.status === 'pending').length : 0;
    if ((ladderCount > 0 || orderCount > 0) && !(await confirmWalletCleanup(ladderCount, orderCount))) {
      throw new Error('Wallet switch cancelled. The current wallet remains active.');
    }

    walletChangeRunning.current = true;
    try {
      if (currentWallet) automation.stopAll();
      return await exclusive(async () => {
        if (currentWallet) {
          await storageService.flush();
          const activeIds = storageService.getOrders()
            .filter(order => order.status === 'open' || order.status === 'pending')
            .map(order => order.id);
          const failures: string[] = [];
          for (const id of activeIds) {
            const current = storageService.getOrders().find(order => order.id === id);
            if (!current || (current.status !== 'open' && current.status !== 'pending')) continue;
            try {
              await executionEngine.cancel(id, currentWallet);
            } catch (error) {
              const latest = storageService.getOrders().find(order => order.id === id);
              if (latest && (latest.status === 'open' || latest.status === 'pending')) failures.push(`${id}: ${String(error)}`);
            }
          }
          const stillActive = storageService.getOrders().filter(order => order.status === 'open' || order.status === 'pending');
          if (failures.length || stillActive.length) {
            throw new Error(`Wallet was not switched because ${stillActive.length || failures.length} order cancellation${(stillActive.length || failures.length) === 1 ? '' : 's'} could not be confirmed. ${failures[0] || ''}`.trim());
          }
        }

        const nextWallet = await change();
        automation.stopAll();
        await storageService.flush();
        return nextWallet;
      });
    } finally {
      walletChangeRunning.current = false;
    }
  }, [confirmWalletCleanup]);

  const handleGenerateWallet = async () => {
    const newWallet = await changeWalletSafely(() => web3Service.generateNewWallet());
    setWallet(newWallet);
    setOrders(storageService.getOrders());
    systemLogService.logSuccess('WALLET', 'Wallet Generated Successfully', 'Write down your private key and confirm your backup before depositing funds.');
    setWalletModalMode('export');
    setIsWalletModalOpen(true);
  };

  const handleImportWallet = async (input: string) => {
    const imported = await changeWalletSafely(() => web3Service.importWallet(input));
    setWallet(imported);
    setOrders(storageService.getOrders());
    systemLogService.logSuccess('WALLET', 'Wallet Imported Successfully', `Active address: ${imported.address}`);
  };

  // Token Approval Handler
  const handleApproveToken = async (tokenAddress: string) => {
    if (!wallet) return;
    setIsApproving(true);
    try {
      systemLogService.logInfo('WALLET', 'Approving Token', 'Submitting approval transaction to CoW VaultRelayer.', selectedChainId);

      await exclusive(() => web3Service.approveToken(wallet.address, tokenAddress, selectedChainId));
      await refreshBalances();
    } catch (e: any) {
      console.error(`Approval failed for ${tokenAddress}`, e);
      systemLogService.logError('WALLET', 'Token Approval Failed', e?.message || 'Transaction failed', selectedChainId);
    } finally {
      setIsApproving(false);
    }
  };

  // Trade Submission Handler
  const handleTradeSubmitted = (orderId: string, orderData: any) => {
    // Keep the signed amounts and any fill reconciled while POST was in flight.
    const prepared = storageService.getOrders().find(o => o.id === orderId);
    const newOrders = prepared ? storageService.getOrders() : storageService.addOrder(orderData);
    setOrders(newOrders);
    systemLogService.logSuccess(
      'ORDER',
      `Market Order Submitted: ${orderData.sellSymbol} → ${orderData.buySymbol}`,
      `ID: ${orderId} | Amount: ${formatAssetDisplay(orderData.sellAmount, orderData.sellSymbol)} ${orderData.sellSymbol}`,
      undefined,
      cowProtocol.getExplorerUrl(orderId),
      selectedChainId
    );
  };

  // Limit Order Handlers
  const handleChartPriceClick = useCallback((price: number, candleTime?: number) => {
    setClickedChartPrice(price);
    setClickedCandleTime(candleTime || Math.floor(Date.now() / 1000));
    setIsLimitModalOpen(true);
  }, []);

  const handleLimitOrderPlaced = (order: TradeOrder) => {
    handleOrdersPlaced([order]);
  };

  const handleOrdersPlaced = (newOrdersList: TradeOrder[]) => {
    const updated = storageService.addOrders(newOrdersList);
    setOrders(updated);
    const first = newOrdersList[0];
    const ocoTag = first.ocoGroupId;
    if (ocoTag && newOrdersList.length > 1) {
      systemLogService.logSuccess(
        'ORDER',
        `OCO Pair [${ocoTag}] Placed`,
        `Take-profit intent submitted for ${first.sellSymbol} / ${first.buySymbol}.`,
        undefined,
        cowProtocol.getExplorerUrl(first.id),
        selectedChainId
      );
    } else {
      const isSell = first.orderCategory === 'limit_sell' || first.orderCategory === 'stop_loss' || first.orderCategory === 'take_profit' || first.type === 'BNB_TO_USDT';
      systemLogService.logSuccess(
        'ORDER',
        `${isSell ? 'Limit Sell' : 'Limit Buy'} Placed: ${first.sellSymbol} → ${first.buySymbol}`,
        `Price: $${formatTokenDisplay(first.limitPrice || 0)} | Size: ${formatAssetDisplay(first.sellAmount, first.sellSymbol)} ${first.sellSymbol}`,
        undefined,
        cowProtocol.getExplorerUrl(first.id),
        selectedChainId
      );
    }
    refreshBalances();
  };

  const handleCancelOrder = useCallback(async (orderId: string) => {
    if (!wallet) return;
    systemLogService.logInfo('ORDER', 'Requesting CoW cancellation', `Order: ${orderId}`);
    try {
      await executionEngine.cancel(orderId, wallet);
      systemLogService.logSuccess('ORDER', 'Cancellation confirmed', 'The active order legs were revoked.');
    } catch (error) {
      systemLogService.logError('ORDER', 'Cancellation not confirmed', String(error));
    }
  }, [wallet?.address]);

  const handleClearOrders = (tokenAddress?: string, chainId?: number) => {
    if (tokenAddress) {
      const lowerTarget = tokenAddress.toLowerCase();
      const retained = orders.filter((o) => {
        const matchesToken =
          o.sellToken?.toLowerCase() === lowerTarget ||
          o.buyToken?.toLowerCase() === lowerTarget;
        const matchesChain = !chainId || !o.chainId || o.chainId === chainId;
        return o.status === 'open' || o.status === 'pending' || !!(o.bracket && !o.bracket.isCompleted && o.status === 'fulfilled') || !(matchesToken && matchesChain);
      });
      storageService.saveOrders(retained);
      storageService.clearChartMarkers(tokenAddress, chainId);
      setOrders(retained);
      setChartMarkers(storageService.getChartMarkers(tokenAddress, chainId));
    } else {
      const retained = orders.filter(o => o.status === 'open' || o.status === 'pending' || !!(o.bracket && !o.bracket.isCompleted && o.status === 'fulfilled'));
      storageService.saveOrders(retained);
      storageService.clearChartMarkers();
      setOrders(retained);
      setChartMarkers([]);
    }
  };

  const handleUpdateSlippage = (val: number) => {
    setSlippage(val);
    storageService.saveSlippage(val);
  };

  const handleUpdateStopLossSlippage = (val: number) => {
    setStopLossSlippage(val);
    storageService.saveStopLossSlippage(val);
  };

  // Chain & Token Switch Handlers
  const handleSelectChain = (newChainId: number) => {
    setSelectedChainId(newChainId);
    storageService.saveSelectedChainId(newChainId);

    const chainTokens = getTokensForChain(newChainId);
    const defaultTok = chainTokens[0] || DEFAULT_BSC_TOKENS[0];
    setSelectedToken(defaultTok);
    storageService.saveSelectedToken(defaultTok);
    setChartMarkers(storageService.getChartMarkers(defaultTok.address, newChainId));

    const tokenStrategies = storageService.getTokenStrategies();
    const key = `${newChainId}_${defaultTok.address.toLowerCase()}`;
    const existingStrat = tokenStrategies[key];
    const targetStrat: StrategyConfig = existingStrat
      ? { ...existingStrat, baseToken: defaultTok }
      : {
          ...storageService.getStrategyConfig(newChainId),
          id: `strat_${defaultTok.symbol.toLowerCase()}`,
          name: `${defaultTok.symbol} Dynamic Strategy`,
          baseToken: defaultTok,
          isActive: false,
        };
    setStrategyConfig(targetStrat);
    storageService.saveStrategyConfig(targetStrat);

    systemLogService.logInfo('SYSTEM', 'Switched Network', `Active chain changed to ${getChainConfig(newChainId).name}.`, newChainId);
  };

  const handleSelectToken = (tok: TokenConfig) => {
    setSelectedToken(tok);
    storageService.saveSelectedToken(tok);
    const tokChain = tok.chainId || selectedChainId;
    setChartMarkers(storageService.getChartMarkers(tok.address, tokChain));

    const tokenStrategies = storageService.getTokenStrategies();
    const key = `${tokChain}_${tok.address.toLowerCase()}`;
    const existingStrat = tokenStrategies[key];
    const targetStrat: StrategyConfig = existingStrat
      ? { ...existingStrat, baseToken: tok }
      : {
          ...storageService.getStrategyConfig(tokChain),
          id: `strat_${tok.symbol.toLowerCase()}`,
          name: `${tok.symbol} Dynamic Strategy`,
          baseToken: tok,
          isActive: false,
        };
    setStrategyConfig(targetStrat);
    storageService.saveStrategyConfig(targetStrat);
  };

  const historyNavigationRequest = useRef(0);
  const handleSelectHistoryOrder = async (order: TradeOrder) => {
    const request = ++historyNavigationRequest.current;
    const chainId = order.chainId || DEFAULT_CHAIN_ID;
    const side = historyTokenSide(order);
    const address = order[`${side}Token`];
    const symbol = order[`${side}Symbol`];
    const decimals = order[`${side}Decimals`];
    try {
      const known = [selectedToken, ...customTokens, ...getTokensForChain(chainId),
        ...(alphaTokensByChain[chainId] || []), ...storageService.getTrackedTokens(chainId)]
        .find(token => token.chainId === chainId && token.address.toLowerCase() === address.toLowerCase());
      const token = known || (decimals !== undefined
        ? { address, symbol, name: symbol, decimals, chainId }
        : await web3Service.getTokenMetadata(address, chainId));
      if (request !== historyNavigationRequest.current) return;
      if (!token) throw new Error(`Token details unavailable for ${symbol}`);
      if (chainId !== selectedChainId) handleSelectChain(chainId);
      handleSelectToken(token);
      setIsOverviewOpen(false);
    } catch (error) {
      systemLogService.logError('SYSTEM', 'Unable to open token workspace', String(error), chainId);
    }
  };

  const handleAddCustomToken = (tok: TokenConfig) => {
    const updated = storageService.addCustomToken(tok);
    setCustomTokens(updated);
    if (tok.chainId && tok.chainId !== selectedChainId) {
      handleSelectChain(tok.chainId);
    }
    handleSelectToken(tok);
    setIsAddTokenModalOpen(false);
    systemLogService.logSuccess('MARKET_DATA', 'Token Imported', `${tok.symbol} has been added and set as active on ${getChainConfig(tok.chainId || selectedChainId).name}.`, undefined, undefined, tok.chainId || selectedChainId);
    refreshBalances();
  };

  const handleUpdateStrategyConfig = (newCfg: StrategyConfig) => {
    setStrategyConfig(newCfg);
    storageService.saveStrategyConfig(newCfg);
    if (newCfg.baseToken) {
      const cId = newCfg.baseToken.chainId || selectedChainId;
      storageService.saveTokenStrategy(newCfg.baseToken.address, cId, newCfg);
    }
  };

  return (
    <div className="h-screen w-screen max-h-screen overflow-hidden bg-background text-slate-100 font-sans flex flex-col select-none">
      
      {/* 1. Header (Fixed Top Bar with Chain & Token Selectors) */}
      <Header
        activeLadders={activeLadders}
        onSelectActiveLadder={(token, chainId) => {
          if (chainId !== selectedChainId) handleSelectChain(chainId);
          handleSelectToken({ ...token, chainId });
          setIsOverviewOpen(false);
        }}
        marketPrice={marketPrice}
        onRefreshPrice={refreshMarketPrice}
        isPriceLoading={isPriceLoading}
        onResetLayout={handleResetLayout}
        onOpenSettings={() => setIsSettingsModalOpen(true)}
        onOpenThemeModal={() => setIsThemeModalOpen(true)}
        currentTheme={currentTheme}
        selectedChainId={selectedChainId}
        onSelectChain={handleSelectChain}
        selectedToken={selectedToken}
        onSelectToken={handleSelectToken}
        customTokens={customTokens}
        alphaTokens={activeAlphaTokens}
        onOpenAddTokenModal={() => setIsAddTokenModalOpen(true)}
        onOpenTokenAudit={() => setIsTokenAuditModalOpen(true)}
        isOverviewOpen={isOverviewOpen}
        onToggleOverview={() => setIsOverviewOpen((prev) => !prev)}
        isLadderOpen={isLadderOpen}
        onToggleLadder={STRATEGIES_ENABLED ? handleToggleLadder : undefined}
      />

      {/* Workspace-only bar stays mounted so dismissing a trade never resets it. */}
      <div data-workspace-bar hidden={isOverviewOpen} className="relative z-50 px-3 pt-2 shrink-0">
        <TradeMetrics
          orders={accountingHistory.orders}
          accountingError={accountingHistory.error}
          marketPrice={marketPrice}
          selectedToken={selectedToken}
          selectedChainId={selectedChainId}
          selectedTokenSymbol={selectedToken.symbol}
          walletTradeCard={
            <WalletTradeDropdown
              chainId={selectedChainId}
              walletAddress={wallet?.address}
              balanceSnapshot={fundingSnapshot}
              nativePriceSnapshot={nativePriceSnapshot}
              selectedToken={selectedToken}
              tokenPriceSnapshot={tokenPriceSnapshot}
              walletValuation={walletValuation}
              isWorkspaceActive={!isOverviewOpen}
              isModalOpen={isWalletModalOpen || isWrapModalOpen || !!walletChangeWarning || isLimitModalOpen}
            >
              <WalletCard
                embedded
                wallet={wallet}
                balances={balances}
                walletValuation={walletValuation}
                allowances={allowances}
                marketPrice={marketPrice}
                nativePrice={nativePrice}
                chainId={selectedChainId}
                selectedToken={selectedToken}
                onGenerateWallet={handleGenerateWallet}
                onOpenImportModal={() => {
                  setWalletModalMode('import');
                  setIsWalletModalOpen(true);
                }}
                onOpenExportModal={() => {
                  setWalletModalMode('export');
                  setIsWalletModalOpen(true);
                }}
                onOpenQrModal={() => {
                  setDepositChainId(selectedChainId);
                  setWalletModalMode('qr');
                  setIsWalletModalOpen(true);
                }}
                onOpenWrapModal={() => setIsWrapModalOpen(true)}
                onRefreshBalances={() => refreshBalances(true)}
                onApproveToken={handleApproveToken}
                isApproving={isApproving}
              />
              <TradingPanel
                embedded
                selectedToken={selectedToken}
                chainId={selectedChainId}
                wallet={wallet}
                balances={balances}
                allowances={allowances}
                marketPrice={marketPrice}
                slippage={slippage}
                onUpdateSlippage={handleUpdateSlippage}
                onTradeSubmitted={handleTradeSubmitted}
                onRefreshBalances={refreshBalances}
                onRequireWallet={() => {
                  setWalletModalMode('import');
                  setIsWalletModalOpen(true);
                }}
              />
            </WalletTradeDropdown>
          }
        />
      </div>

      {isOverviewOpen ? (
        <OverviewDashboard
          onOpenWalletSetup={() => {
            setWalletModalMode('import');
            setIsWalletModalOpen(true);
          }}
          wallet={wallet}
          selectedChainId={selectedChainId}
          selectedToken={selectedToken}
          onSelectTokenAndChain={(token, chainId) => {
            setSelectedChainId(chainId);
            setSelectedToken(token);
            storageService.saveSelectedChainId(chainId);
            storageService.saveSelectedToken(token);
            setIsOverviewOpen(false);
          }}
          onOpenDepositModal={(cId) => {
            setDepositChainId(cId || selectedChainId);
            setWalletModalMode('qr');
            setIsWalletModalOpen(true);
          }}
          onOpenWrapModal={(cId) => {
            if (cId && cId !== selectedChainId) {
              setSelectedChainId(cId);
              storageService.saveSelectedChainId(cId);
            }
            setIsWrapModalOpen(true);
          }}
          allOrders={accountingHistory.orders}
          accountingError={accountingHistory.error}
          onCancelOrder={handleCancelOrder}
          onToggleOverview={() => setIsOverviewOpen(false)}
          customTokens={customTokens}
          strategyConfig={strategyConfig}
          onUpdateStrategyConfig={handleUpdateStrategyConfig}
        />
      ) : (
        <>
          {/* 4. DRAGGABLE & RESIZABLE WINDOWS WORKSPACE CANVAS */}
          <div 
            ref={canvasRef}
            className="flex-1 min-h-0 relative w-full h-full overflow-hidden p-2 z-0"
          >
        {/* WINDOW 1: LIVE CHART & SIGNALS */}
        {windows.chart && (
          <DraggableResizableWindow
            layout={windows.chart}
            onUpdateLayout={handleUpdateLayout}
            onBringToFront={handleBringToFront}
            containerBounds={canvasBounds}
          >
            <TradingViewChart
              key={`${wallet?.address}:${selectedChainId}:${selectedToken.address.toLowerCase()}`}
              token={selectedToken}
              chainId={selectedChainId}
              orders={orders}
              chartMarkers={chartMarkers}
              strategyMarkers={strategyMarkers}
              strategyConfig={strategyConfig}
              onPriceSelected={handleChartPriceClick}
              onCancelOrder={handleCancelOrder}
              livePrice={marketPrice.price}
              nativePriceSnapshot={nativePriceSnapshot}
              onCandlesUpdated={setCandles}
              onIntervalChange={setActiveChartTimeframe}
            />
          </DraggableResizableWindow>
        )}

        {/* WINDOW 2: TRADE & INTENT EXECUTION LOG */}
        {windows.orders && (
          <DraggableResizableWindow
            layout={windows.orders}
            onUpdateLayout={handleUpdateLayout}
            onBringToFront={handleBringToFront}
            containerBounds={canvasBounds}
          >
            <OrderHistory
              orders={orders}
              nativePriceSnapshot={nativePriceSnapshot}
              fundingStatuses={fundingStatuses}
              selectedToken={selectedToken}
              selectedChainId={selectedChainId}
              onClearOrders={handleClearOrders}
              onRefreshStatuses={syncOrderStatuses}
              onSelectOrder={handleSelectHistoryOrder}
              onCancelOrder={handleCancelOrder}
              isRefreshing={isSyncingOrders}
            />
          </DraggableResizableWindow>
        )}

        {/* AUTOMATION WINDOW */}
        {STRATEGIES_ENABLED && isLadderOpen && windows.ladder && (
          <DraggableResizableWindow
            layout={windows.ladder}
            onUpdateLayout={handleUpdateLayout}
            onBringToFront={handleBringToFront}
            containerBounds={canvasBounds}
          >
            <AutomationWindow
              key={`${wallet?.address}:${selectedChainId}:${selectedToken.address.toLowerCase()}`}
              selectedToken={selectedToken}
              selectedChainId={selectedChainId}
              wallet={wallet}
              orders={orders}
              onRequireWallet={() => {
                setWalletModalMode('import');
                setIsWalletModalOpen(true);
              }}
            />
          </DraggableResizableWindow>
        )}
      </div>
      </>
      )}

      {/* Modals */}
      <LimitOrderModal
        isOpen={isLimitModalOpen}
        onClose={() => setIsLimitModalOpen(false)}
        clickedPrice={clickedChartPrice}
        candleTime={clickedCandleTime}
        wallet={wallet}
        balances={balances}
        allowances={allowances}
        targetToken={selectedToken}
        chainId={selectedChainId}
        livePrice={marketPrice.price}
        existingOrders={orders}
        onOrderPlaced={handleLimitOrderPlaced}
        onOrdersPlaced={handleOrdersPlaced}
        onRefreshBalances={refreshBalances}
        onRequireWallet={() => {
          setWalletModalMode('import');
          setIsWalletModalOpen(true);
        }}
      />

      <WalletModal
        onBackupConfirmed={setWallet}
        isOpen={isWalletModalOpen}
        onClose={() => setIsWalletModalOpen(false)}
        mode={walletModalMode}
        wallet={wallet}
        chainId={depositChainId}
        onImportWallet={handleImportWallet}
        onGenerateNew={handleGenerateWallet}
      />

      <WalletChangeWarningModal
        isOpen={!!walletChangeWarning}
        ladderCount={walletChangeWarning?.ladderCount || 0}
        orderCount={walletChangeWarning?.orderCount || 0}
        onCancel={() => finishWalletChangeDecision(false)}
        onConfirm={() => finishWalletChangeDecision(true)}
      />
      <CloseConfirmationModal isOpen={closeConfirmationOpen} onCancel={() => setCloseConfirmationOpen(false)} onConfirm={() => { void startupService.confirmExit(); }} />

      <WrapModal
        isOpen={isWrapModalOpen}
        onClose={() => setIsWrapModalOpen(false)}
        wallet={wallet}
        balances={balances}
        chainId={selectedChainId}
        nativePrice={nativePrice}
        onRefreshBalances={refreshBalances}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        slippage={slippage}
        onUpdateSlippage={handleUpdateSlippage}
        stopLossSlippage={stopLossSlippage}
        onUpdateStopLossSlippage={handleUpdateStopLossSlippage}
        currentTheme={currentTheme}
        onSelectTheme={handleSelectTheme}
      />

      <ThemeSelectorModal
        isOpen={isThemeModalOpen}
        onClose={() => setIsThemeModalOpen(false)}
        currentTheme={currentTheme}
        onSelectTheme={handleSelectTheme}
      />

      <AddTokenModal
        isOpen={isAddTokenModalOpen}
        onClose={() => setIsAddTokenModalOpen(false)}
        chainId={selectedChainId}
        onTokenAdded={handleAddCustomToken}
      />

      <TokenAuditModal
        isOpen={isTokenAuditModalOpen}
        onClose={() => setIsTokenAuditModalOpen(false)}
        token={selectedToken}
        chainId={selectedChainId}
      />

    </div>
  );
};

export default App;
