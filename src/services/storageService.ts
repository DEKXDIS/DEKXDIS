import { STRATEGIES_ENABLED } from '../config/releaseFeatures';
import { nativeStore } from './nativeStore';
import { systemLogService } from './systemLogService';
import { WalletState, TradeOrder, LimitOrderSettings, ChartMarker, StrategyConfig, TokenConfig, DEFAULT_BSC_TOKENS, ChartUserSettings, getDefaultTokensForChain } from '../types/trading';
import { WindowLayout } from '../components/DraggableResizableWindow';
import { DEFAULT_CHAIN_ID, getChainConfig, getTradingQuoteToken } from '../types/chains';
import { ThemeId, DEFAULT_THEME_ID } from '../types/theme';

const STORAGE_KEYS = {
  WALLET: 'haven_defi_terminal_wallet',
  ORDERS: 'haven_defi_terminal_orders',
  ACCOUNTING_ORDERS: 'haven_defi_terminal_accounting_orders_v1',
  SLIPPAGE: 'haven_defi_terminal_slippage',
  STOP_LOSS_SLIPPAGE: 'haven_defi_terminal_stop_loss_slippage',
  AUTO_WRAP: 'haven_defi_terminal_auto_wrap',
  get WINDOW_LAYOUTS() { return STRATEGIES_ENABLED ? 'haven_defi_terminal_window_layouts_modules_v1' : 'haven_defi_terminal_window_layouts_manual_v1'; },
  LIMIT_SETTINGS: 'haven_defi_terminal_limit_settings',
  CHART_MARKERS: 'haven_defi_terminal_chart_markers',
  STRATEGY_CONFIG: 'haven_defi_terminal_strategy_config_v2',
  CUSTOM_TOKENS: 'haven_defi_terminal_custom_tokens',
  SELECTED_TOKEN: 'haven_defi_terminal_selected_token',
  SELECTED_CHAIN_ID: 'haven_defi_terminal_selected_chain_id',
  CHART_SETTINGS: 'haven_defi_terminal_chart_settings_v1',
  PINNED_TOKENS: 'haven_defi_terminal_pinned_tokens_v1',
  IS_OVERVIEW_OPEN: 'haven_defi_terminal_is_overview_open',
  IS_LADDER_OPEN: 'haven_defi_terminal_is_ladder_open_v1',
  TOKEN_STRATEGIES: 'haven_defi_terminal_token_strategies_v1',
  OVERVIEW_WINDOW_LAYOUTS: 'haven_defi_terminal_overview_window_layouts_v2',
  THEME: 'haven_defi_terminal_theme_v1',
  TRACKED_TOKENS: 'haven_defi_terminal_tracked_tokens_v1',
  CUSTOM_RPCS: 'haven_defi_terminal_custom_rpcs_v1',
  RPC_API_KEYS: 'haven_defi_terminal_rpc_api_keys_v1',
  DYNAMIC_RPCS: 'haven_defi_terminal_dynamic_rpcs_v1',
  WALLET_NICKNAMES: 'haven_defi_terminal_wallet_nicknames_v1',
};

function getRaw(key: string): string | null { return nativeStore.getItem(key); }
function setRaw(key: string, value: string): void { nativeStore.setItem(key, value); }
function removeRaw(key: string): void { nativeStore.removeItem(key); }

function accountingOrderKey(order: TradeOrder): string {
  return `${order.ownerAddress?.toLowerCase() || ''}:${order.chainId}:${order.id}`;
}

function archivedAccountingOrders(): TradeOrder[] {
  const raw = getRaw(STORAGE_KEYS.ACCOUNTING_ORDERS);
  const orders = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(orders)) throw new Error('Saved accounting history is invalid');
  return orders;
}

export const storageService = {
  getWallet(): WalletState | null { return nativeStore.getWallet(); },
  flush(): Promise<void> { return nativeStore.flush(); },
  subscribe(listener: () => void) { return nativeStore.subscribe(key => { if (!key || key === STORAGE_KEYS.ORDERS) listener(); }); },

  getWalletNicknames(): Record<string, string> {
    try {
      const value = getRaw(STORAGE_KEYS.WALLET_NICKNAMES);
      return value ? JSON.parse(value) : {};
    } catch {
      return {};
    }
  },

  saveWalletNickname(address: string, nickname: string): Record<string, string> {
    const normalizedAddress = address.toLowerCase();
    const normalizedNickname = nickname.trim().slice(0, 40);
    const nicknames = this.getWalletNicknames();
    if (normalizedNickname) nicknames[normalizedAddress] = normalizedNickname;
    else delete nicknames[normalizedAddress];
    setRaw(STORAGE_KEYS.WALLET_NICKNAMES, JSON.stringify(nicknames));
    return nicknames;
  },

  saveOrders(orders: TradeOrder[]): void {
    try {
      // Clearing visible history must not discard the cost of a later sale.
      // Keep these fills outside the execution engine's active order list.
      const retained = new Set(orders.map(accountingOrderKey));
      const removedFills = this.getOrders().filter(order => order.status === 'fulfilled' &&
        !order.isConditional && !retained.has(accountingOrderKey(order)));
      if (removedFills.length) {
        const archived = new Map(archivedAccountingOrders().map(order => [accountingOrderKey(order), order]));
        for (const order of removedFills) archived.set(accountingOrderKey(order), order);
        setRaw(STORAGE_KEYS.ACCOUNTING_ORDERS, JSON.stringify([...archived.values()]));
      }
      setRaw(STORAGE_KEYS.ORDERS, JSON.stringify(orders));
    } catch (e) {
      systemLogService.logError('ORDER', 'Failed to save order history', String(e));
      throw e;
    }
  },

  getAccountingOrders(orders?: TradeOrder[]): TradeOrder[] {
    const combined = new Map(archivedAccountingOrders().map(order => [accountingOrderKey(order), order]));
    // Current records carry any later settlement/valuation corrections.
    for (const order of orders ?? this.getOrders()) combined.set(accountingOrderKey(order), order);
    return [...combined.values()];
  },

  getOrders(): TradeOrder[] {
    try {
      const data = getRaw(STORAGE_KEYS.ORDERS);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.error('Failed to read orders from storage', e);
      return [];
    }
  },

  addOrder(order: TradeOrder): TradeOrder[] {
    return this.addOrders([order]);
  },

  addOrders(newOrdersList: TradeOrder[]): TradeOrder[] {
    const orders = this.getOrders();
    let updated = [...orders];
    for (const order of newOrdersList) {
      if (order.ownerAddress && order.ownerAddress.toLowerCase() !== nativeStore.getWallet()?.address.toLowerCase()) throw new Error('Cannot save an order under another wallet');
      const existingIndex = updated.findIndex((o) => o.id === order.id);
      if (existingIndex >= 0) {
        // A repeated add is a late submission callback, not a state update.
        // Keep the persisted fills and protection links authoritative.
        const existing = updated[existingIndex];
        updated[existingIndex] = { ...order, ...existing,
          bracket: existing.bracket ? { ...order.bracket, ...existing.bracket } : order.bracket,
          ownerAddress: existing.ownerAddress || order.ownerAddress || nativeStore.getWallet()?.address };
      } else {
        updated = [{ ...order, ownerAddress: order.ownerAddress || nativeStore.getWallet()?.address }, ...updated];
      }

      // Automatically register any newly traded token into the user's database
      try {
        const cId = order.chainId || DEFAULT_CHAIN_ID;
        const chainCfg = getChainConfig(cId);
        const wrappedLower = chainCfg.nativeToken.wrappedAddress.toLowerCase();
        const usdtLower = chainCfg.usdtToken.address.toLowerCase();

        if (order.sellToken) {
          const sLower = order.sellToken.toLowerCase();
          if (sLower !== wrappedLower && sLower !== usdtLower) {
            this.addTrackedToken({
              symbol: order.sellSymbol || 'TOKEN',
              name: order.sellSymbol || 'Traded Token',
              address: order.sellToken,
              decimals: order.sellDecimals ?? 18,
              chainId: cId,
            });
          }
        }

        if (order.buyToken) {
          const bLower = order.buyToken.toLowerCase();
          if (bLower !== wrappedLower && bLower !== usdtLower) {
            this.addTrackedToken({
              symbol: order.buySymbol || 'TOKEN',
              name: order.buySymbol || 'Traded Token',
              address: order.buyToken,
              decimals: order.buyDecimals ?? 18,
              chainId: cId,
            });
          }
        }
      } catch (err) {
        console.error('Failed to register traded token from order into database:', err);
      }
    }
    this.saveOrders(updated);
    return updated;
  },

  updateOrderStatus(orderId: string, status: TradeOrder['status'], txHash?: string): TradeOrder[] {
    const orders = this.getOrders();
    const updated = orders.map((o) => {
      if (o.id === orderId) {
        return {
          ...o,
          status,
          ...(txHash ? { txHash } : {}),
        };
      }
      return o;
    });
    this.saveOrders(updated);
    return updated;
  },

  getManualTradeAmount(side: 'buy' | 'sell'): string | null {
    return getRaw(`haven_defi_terminal_manual_trade_last_${side}`);
  },

  saveManualTradeAmount(side: 'buy' | 'sell', amount: string): void {
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new Error('Invalid manual trade USD amount');
    setRaw(`haven_defi_terminal_manual_trade_last_${side}`, amount);
  },

  getAutoWrap(): boolean {
    try {
      const val = getRaw(STORAGE_KEYS.AUTO_WRAP);
      return val !== null ? JSON.parse(val) : true;
    } catch {
      return true;
    }
  },

  saveAutoWrap(enabled: boolean): void {
    try {
      setRaw(STORAGE_KEYS.AUTO_WRAP, JSON.stringify(enabled));
    } catch (e) {
      console.error('Failed to save auto wrap', e);
    }
  },

  saveWindowLayouts(layouts: Record<string, WindowLayout>): void {
    try {
      setRaw(STORAGE_KEYS.WINDOW_LAYOUTS, JSON.stringify(layouts));
    } catch (e) {
      console.error('Failed to save window layouts', e);
    }
  },

  getWindowLayouts(): Record<string, WindowLayout> | null {
    try {
      const val = STRATEGIES_ENABLED
        ? getRaw(STORAGE_KEYS.WINDOW_LAYOUTS) ?? getRaw('haven_defi_terminal_window_layouts_v3') ?? getRaw('haven_defi_terminal_window_layouts_v3_no_strategy')
        : getRaw(STORAGE_KEYS.WINDOW_LAYOUTS);
      if (val) {
        const layouts = JSON.parse(val);
        if (layouts.ladder) layouts.ladder.title = 'Automation';
        return layouts;
      }
      return null;
    } catch {
      return null;
    }
  },

  clearWindowLayouts(): void {
    try {
      removeRaw(STORAGE_KEYS.WINDOW_LAYOUTS);
    } catch (e) {
      console.error('Failed to clear window layouts', e);
    }
  },

  getOverviewWindowLayouts(): Record<string, WindowLayout> | null {
    try {
      const val = getRaw(STORAGE_KEYS.OVERVIEW_WINDOW_LAYOUTS);
      if (val) return JSON.parse(val);
      return null;
    } catch {
      return null;
    }
  },

  saveOverviewWindowLayouts(layouts: Record<string, WindowLayout>): void {
    try {
      setRaw(STORAGE_KEYS.OVERVIEW_WINDOW_LAYOUTS, JSON.stringify(layouts));
    } catch (e) {
      console.error('Failed to save overview window layouts', e);
    }
  },

  clearOverviewWindowLayouts(): void {
    try {
      removeRaw(STORAGE_KEYS.OVERVIEW_WINDOW_LAYOUTS);
    } catch (e) {
      console.error('Failed to clear overview window layouts', e);
    }
  },

  getDefaultOverviewWindowLayouts(containerWidth: number = 1440, containerHeight: number = 900): Record<string, WindowLayout> {
    const gap = 10;
    const columnWidth = Math.max(1, (containerWidth - gap * 3) / 2);
    const fullHeight = Math.max(1, containerHeight - gap * 2);
    const walletHeight = Math.max(1, (fullHeight - gap) / 3);
    const rightX = gap * 2 + columnWidth;

    return {
      matrix: {
        id: 'matrix',
        title: 'Asset Overview',
        x: gap,
        y: gap,
        width: columnWidth,
        height: fullHeight,
        minWidth: Math.min(540, columnWidth),
        minHeight: Math.min(320, fullHeight),
        zIndex: 10,
      },
      wallet_creation: {
        id: 'wallet_creation',
        title: 'Wallet Creation',
        x: rightX,
        y: gap,
        width: columnWidth,
        height: walletHeight,
        minWidth: Math.min(320, columnWidth),
        minHeight: Math.min(150, walletHeight),
        zIndex: 11,
      },
      system_log: {
        id: 'system_log',
        title: 'Universal System & Execution Log',
        x: rightX,
        y: gap * 2 + walletHeight,
        width: columnWidth,
        height: fullHeight - gap - walletHeight,
        minWidth: Math.min(360, columnWidth),
        minHeight: Math.min(180, fullHeight - gap - walletHeight),
        zIndex: 12,
      },
    };
  },

  getLimitSettings(): LimitOrderSettings {
    try {
      const val = getRaw(STORAGE_KEYS.LIMIT_SETTINGS);
      if (val) return JSON.parse(val);
      return {
        defaultUsdAmount: '50',
        tpEnabled: true,
        tpPercent: 2.0,
        slEnabled: true,
        slPercent: 2.0,
      };
    } catch {
      return {
        defaultUsdAmount: '50',
        tpEnabled: true,
        tpPercent: 2.0,
        slEnabled: true,
        slPercent: 2.0,
      };
    }
  },

  saveLimitSettings(settings: LimitOrderSettings): void {
    try {
      setRaw(STORAGE_KEYS.LIMIT_SETTINGS, JSON.stringify(settings));
    } catch (e) {
      console.error('Failed to save limit settings', e);
    }
  },

  getChartMarkers(tokenAddress?: string, chainId?: number): ChartMarker[] {
    try {
      const val = getRaw(STORAGE_KEYS.CHART_MARKERS);
      const all: ChartMarker[] = val ? JSON.parse(val) : [];
      if (!tokenAddress) {
        return all.filter((m) => Boolean(m.tokenAddress && m.chainId));
      }

      const lowerTarget = tokenAddress.toLowerCase();
      return all.filter((m) => {
        if (!m.tokenAddress || !m.chainId) return false;
        const matchesToken = m.tokenAddress.toLowerCase() === lowerTarget;
        const matchesChain = !chainId || m.chainId === chainId;
        return matchesToken && matchesChain;
      });
    } catch {
      return [];
    }
  },

  saveChartMarkers(markers: ChartMarker[]): void {
    try {
      // Prune any legacy corrupt markers lacking tokenAddress or chainId
      const clean = markers.filter((m) => Boolean(m.tokenAddress && m.chainId));
      setRaw(STORAGE_KEYS.CHART_MARKERS, JSON.stringify(clean));
    } catch (e) {
      console.error('Failed to save chart markers', e);
    }
  },

  addChartMarker(marker: ChartMarker): ChartMarker[] {
    if (!marker.tokenAddress || !marker.chainId) {
      console.error('Refusing to save marker without tokenAddress and chainId:', marker);
      return this.getChartMarkers();
    }
    const current = this.getChartMarkers();
    const existingIdx = current.findIndex((m) => m.id === marker.id);
    let updated: ChartMarker[];
    if (existingIdx >= 0) {
      updated = [...current];
      updated[existingIdx] = marker;
    } else {
      updated = [...current, marker];
    }
    this.saveChartMarkers(updated);
    return updated;
  },

  clearChartMarkers(tokenAddress?: string, chainId?: number): void {
    try {
      if (!tokenAddress) {
        removeRaw(STORAGE_KEYS.CHART_MARKERS);
        return;
      }
      const current = this.getChartMarkers();
      const lowerTarget = tokenAddress.toLowerCase();
      const retained = current.filter((m) => {
        if (!m.tokenAddress || !m.chainId) return false;
        const matchesToken = m.tokenAddress.toLowerCase() === lowerTarget;
        const matchesChain = !chainId || m.chainId === chainId;
        return !(matchesToken && matchesChain);
      });
      this.saveChartMarkers(retained);
    } catch (e) {
      console.error('Failed to clear chart markers', e);
    }
  },

  getPinnedTokens(chainId?: number): string[] {
    try {
      const activeChain = chainId || this.getSelectedChainId();
      const val = getRaw(STORAGE_KEYS.PINNED_TOKENS);
      const all: Record<number, string[]> = val ? JSON.parse(val) : {};
      return all[activeChain] || [];
    } catch {
      return [];
    }
  },

  savePinnedTokens(tokens: string[], chainId?: number): void {
    try {
      const activeChain = chainId || this.getSelectedChainId();
      const val = getRaw(STORAGE_KEYS.PINNED_TOKENS);
      const all: Record<number, string[]> = val ? JSON.parse(val) : {};
      all[activeChain] = tokens;
      setRaw(STORAGE_KEYS.PINNED_TOKENS, JSON.stringify(all));
    } catch (e) {
      console.error('Failed to save pinned tokens', e);
    }
  },

  togglePinnedToken(address: string, chainId?: number): string[] {
    const activeChain = chainId || this.getSelectedChainId();
    const current = this.getPinnedTokens(activeChain);
    const lower = address.toLowerCase();
    const exists = current.some((a) => a.toLowerCase() === lower);
    let updated: string[];
    if (exists) {
      updated = current.filter((a) => a.toLowerCase() !== lower);
    } else {
      updated = [...current, address];
    }
    this.savePinnedTokens(updated, activeChain);
    return updated;
  },

  getSelectedChainId(): number {
    try {
      const val = getRaw(STORAGE_KEYS.SELECTED_CHAIN_ID);
      return val ? parseInt(val, 10) : DEFAULT_CHAIN_ID;
    } catch {
      return DEFAULT_CHAIN_ID;
    }
  },

  saveSelectedChainId(chainId: number): void {
    try {
      setRaw(STORAGE_KEYS.SELECTED_CHAIN_ID, chainId.toString());
    } catch (e) {
      console.error('Failed to save selected chain id', e);
    }
  },

  getStrategyConfig(chainId?: number): StrategyConfig {
    const activeChain = chainId || this.getSelectedChainId();
    const defaultTokens = getDefaultTokensForChain(activeChain);
    const defaultStrategy: StrategyConfig = {
      id: 'default_strategy',
      name: 'Dynamic S/R & Trend Strategy',
      type: 'support_bounce',
      baseToken: defaultTokens[0] || DEFAULT_BSC_TOKENS[0],
      quoteToken: getTradingQuoteToken(activeChain),
      timeframe: '15m',
      orderSizeUsd: 50,
      emaFastPeriod: 20,
      emaSlowPeriod: 50,
      rsiPeriod: 14,
      rsiOversold: 35,
      rsiOverbought: 65,
      donchianPeriod: 20,
      donchianReboundTolerancePct: 0.4,
      zigzagDeviationPct: 1.5,
      zigzagDepth: 6,
      zigzagTolerancePct: 1.5,
      extremaWindow: 4,
      extremaBinCount: 12,
      extremaClusterTolerancePct: 1.2,
      extremaMinTouches: 2,
      macdFastPeriod: 12,
      macdSlowPeriod: 26,
      macdSignalPeriod: 9,
      zscorePeriod: 20,
      zscoreUpperMult: 2.0,
      zscoreLowerMult: 2.0,
      zscoreCandleMeasure: 'range',
      zscoreMinCandleZ: 0.8,
      zscoreMaxCandleZ: 2.2,
      zscoreExhaustionPct: 35,
      zscoreTradeSide: 'both',
      enableTp: true,
      enableSl: true,
      tpPercent: 2.5,
      slPercent: 1.5,
      autoBracket: true,
      cooldownCandles: 2,
      isActive: false,
    };

    try {
      const val = getRaw(STORAGE_KEYS.STRATEGY_CONFIG);
      if (val) {
        return { ...defaultStrategy, ...JSON.parse(val) };
      }
      return defaultStrategy;
    } catch {
      return defaultStrategy;
    }
  },

  saveStrategyConfig(config: StrategyConfig): void {
    try {
      setRaw(STORAGE_KEYS.STRATEGY_CONFIG, JSON.stringify(config));
    } catch (e) {
      console.error('Failed to save strategy config', e);
    }
  },

  getCustomTokens(chainId?: number): TokenConfig[] {
    try {
      const val = getRaw(STORAGE_KEYS.CUSTOM_TOKENS);
      const all: TokenConfig[] = val ? JSON.parse(val) : [];
      if (chainId) {
        return all.filter((t) => t.chainId === chainId);
      }
      return all;
    } catch {
      return [];
    }
  },

  saveCustomTokens(tokens: TokenConfig[]): void {
    try {
      setRaw(STORAGE_KEYS.CUSTOM_TOKENS, JSON.stringify(tokens));
    } catch (e) {
      console.error('Failed to save custom tokens', e);
    }
  },

  addCustomToken(token: TokenConfig): TokenConfig[] {
    const tokens = this.getCustomTokens();
    const existingIdx = tokens.findIndex(
      (t) => t.address.toLowerCase() === token.address.toLowerCase() && t.chainId === token.chainId
    );
    let updated: TokenConfig[];
    if (existingIdx >= 0) {
      updated = [...tokens];
      updated[existingIdx] = token;
    } else {
      updated = [...tokens, token];
    }
    this.saveCustomTokens(updated);
    return updated;
  },

  getSelectedToken(chainId?: number): TokenConfig {
    const activeChain = chainId || this.getSelectedChainId();
    const defaultTokens = getDefaultTokensForChain(activeChain);
    try {
      const val = getRaw(STORAGE_KEYS.SELECTED_TOKEN);
      if (val) {
        const parsed = JSON.parse(val);
        if (parsed && (!chainId || parsed.chainId === chainId)) {
          return parsed;
        }
      }
      return defaultTokens[0] || DEFAULT_BSC_TOKENS[0];
    } catch {
      return defaultTokens[0] || DEFAULT_BSC_TOKENS[0];
    }
  },

  saveSelectedToken(token: TokenConfig): void {
    try {
      setRaw(STORAGE_KEYS.SELECTED_TOKEN, JSON.stringify(token));
    } catch (e) {
      console.error('Failed to save selected token', e);
    }
  },

  getChartSettings(): ChartUserSettings {
    const defaultSettings: ChartUserSettings = {
      showVolume: true,
      showEMA: true,
      showRSI: true,
      showMACD: false,
      showDonchian: true,
      showZigZag: false,
      showSR: true,
      showSignals: true,
      interval: '15m',
      logicalRange: null,
    };

    try {
      const val = getRaw(STORAGE_KEYS.CHART_SETTINGS);
      if (val) {
        return { ...defaultSettings, ...JSON.parse(val) };
      }
      return defaultSettings;
    } catch {
      return defaultSettings;
    }
  },

  saveChartSettings(settings: Partial<ChartUserSettings>): void {
    try {
      const current = this.getChartSettings();
      const updated = { ...current, ...settings };
      setRaw(STORAGE_KEYS.CHART_SETTINGS, JSON.stringify(updated));
    } catch (e) {
      console.error('Failed to save chart settings', e);
    }
  },

  getIsOverviewOpen(): boolean {
    try {
      const val = getRaw(STORAGE_KEYS.IS_OVERVIEW_OPEN);
      if (val !== null) {
        return JSON.parse(val);
      }
      return true; // Defaults to true on startup as requested
    } catch {
      return true;
    }
  },

  saveIsOverviewOpen(isOpen: boolean): void {
    try {
      setRaw(STORAGE_KEYS.IS_OVERVIEW_OPEN, JSON.stringify(isOpen));
    } catch (e) {
      console.error('Failed to save isOverviewOpen state', e);
    }
  },

  getIsLadderOpen(): boolean {
    try {
      const val = getRaw(STORAGE_KEYS.IS_LADDER_OPEN);
      if (val !== null) {
        return JSON.parse(val);
      }
      return true; // Open by default on startup
    } catch {
      return true;
    }
  },

  saveIsLadderOpen(isOpen: boolean): void {
    try {
      setRaw(STORAGE_KEYS.IS_LADDER_OPEN, JSON.stringify(isOpen));
    } catch (e) {
      console.error('Failed to save isLadderOpen state', e);
    }
  },

  getTokenStrategies(): Record<string, StrategyConfig> {
    try {
      const val = getRaw(STORAGE_KEYS.TOKEN_STRATEGIES);
      return val ? JSON.parse(val) : {};
    } catch {
      return {};
    }
  },

  saveTokenStrategy(tokenAddress: string, chainId: number, config: StrategyConfig): void {
    try {
      const current = this.getTokenStrategies();
      const key = `${chainId}_${tokenAddress.toLowerCase()}`;
      current[key] = config;
      setRaw(STORAGE_KEYS.TOKEN_STRATEGIES, JSON.stringify(current));
    } catch (e) {
      console.error('Failed to save token strategy', e);
    }
  },

  getTheme(): ThemeId {
    try {
      const data = getRaw(STORAGE_KEYS.THEME);
      if (data) return data as ThemeId;
      return DEFAULT_THEME_ID;
    } catch {
      return DEFAULT_THEME_ID;
    }
  },

  saveTheme(themeId: ThemeId): void {
    try {
      setRaw(STORAGE_KEYS.THEME, themeId);
    } catch (e) {
      console.error('Failed to save theme', e);
    }
  },

  getTrackedTokens(chainId?: number): TokenConfig[] {
    try {
      const orders = this.getOrders();
      const all: TokenConfig[] = JSON.parse(getRaw(STORAGE_KEYS.TRACKED_TOKENS) || '[]');

      for (const order of orders) {
        const cId = order.chainId || DEFAULT_CHAIN_ID;
        const chainCfg = getChainConfig(cId);
        const wrappedLower = chainCfg.nativeToken.wrappedAddress.toLowerCase();
        const usdtLower = chainCfg.usdtToken.address.toLowerCase();

        if (order.sellToken) {
          const sLower = order.sellToken.toLowerCase();
          if (sLower !== wrappedLower && sLower !== usdtLower) {
            if (!all.some((t) => (t.chainId || DEFAULT_CHAIN_ID) === cId && t.address.toLowerCase() === sLower)) {
              all.push({
                symbol: order.sellSymbol || 'TOKEN',
                name: order.sellSymbol || 'Traded Token',
                address: order.sellToken,
                decimals: order.sellDecimals ?? 18,
                chainId: cId,
              });
            }
          }
        }

        if (order.buyToken) {
          const bLower = order.buyToken.toLowerCase();
          if (bLower !== wrappedLower && bLower !== usdtLower) {
            if (!all.some((t) => (t.chainId || DEFAULT_CHAIN_ID) === cId && t.address.toLowerCase() === bLower)) {
              all.push({
                symbol: order.buySymbol || 'TOKEN',
                name: order.buySymbol || 'Traded Token',
                address: order.buyToken,
                decimals: order.buyDecimals ?? 18,
                chainId: cId,
              });
            }
          }
        }
      }

      if (JSON.stringify(all) !== getRaw(STORAGE_KEYS.TRACKED_TOKENS)) this.saveTrackedTokens(all);

      if (chainId) {
        return all.filter((t) => (t.chainId || DEFAULT_CHAIN_ID) === chainId);
      }
      return all;
    } catch (e) {
      console.error('Failed to get tracked tokens:', e);
      return [];
    }
  },

  saveTrackedTokens(tokens: TokenConfig[]): void {
    try {
      // Deduplicate by chainId and lowercase address
      const unique: TokenConfig[] = [];
      tokens.forEach((tok) => {
        const cId = tok.chainId || DEFAULT_CHAIN_ID;
        const lower = tok.address.toLowerCase();
        if (!unique.some((u) => (u.chainId || DEFAULT_CHAIN_ID) === cId && u.address.toLowerCase() === lower)) {
          unique.push(tok);
        }
      });
      setRaw(STORAGE_KEYS.TRACKED_TOKENS, JSON.stringify(unique));
    } catch (e) {
      console.error('Failed to save tracked tokens', e);
    }
  },

  addTrackedToken(token: TokenConfig): TokenConfig[] {
    if (!token || !token.address) return this.getTrackedTokens();
    const current = this.getTrackedTokens();
    const cId = token.chainId || DEFAULT_CHAIN_ID;
    const lower = token.address.toLowerCase();
    const existingIdx = current.findIndex(
      (t) => (t.chainId || DEFAULT_CHAIN_ID) === cId && t.address.toLowerCase() === lower
    );
    let updated: TokenConfig[];
    if (existingIdx >= 0) {
      updated = [...current];
      updated[existingIdx] = { ...updated[existingIdx], ...token };
    } else {
      updated = [...current, token];
    }
    this.saveTrackedTokens(updated);
    return updated;
  },

  getCustomRpcs(): Record<number, string> {
    try {
      const data = getRaw(STORAGE_KEYS.CUSTOM_RPCS);
      return data ? JSON.parse(data) : {};
    } catch (e) {
      console.error('Failed to get custom RPCs:', e);
      return {};
    }
  },

  saveCustomRpcs(rpcs: Record<number, string>): void {
    try {
      setRaw(STORAGE_KEYS.CUSTOM_RPCS, JSON.stringify(rpcs));
    } catch (e) {
      console.error('Failed to save custom RPCs:', e);
    }
  },

  getRpcApiKey(): { provider: string; apiKey: string } {
    try {
      const data = getRaw(STORAGE_KEYS.RPC_API_KEYS);
      return data ? JSON.parse(data) : { provider: '', apiKey: '' };
    } catch (e) {
      console.error('Failed to get RPC API key:', e);
      return { provider: '', apiKey: '' };
    }
  },

  saveRpcApiKey(config: { provider: string; apiKey: string }): void {
    try {
      setRaw(STORAGE_KEYS.RPC_API_KEYS, JSON.stringify(config));
    } catch (e) {
      console.error('Failed to save RPC API key:', e);
    }
  },

  getDynamicRpcs(): Record<number, string[]> {
    try {
      const data = getRaw(STORAGE_KEYS.DYNAMIC_RPCS);
      return data ? JSON.parse(data) : {};
    } catch (e) {
      console.error('Failed to get dynamic RPCs:', e);
      return {};
    }
  },

  saveDynamicRpcs(rpcs: Record<number, string[]>): void {
    try {
      setRaw(STORAGE_KEYS.DYNAMIC_RPCS, JSON.stringify(rpcs));
    } catch (e) {
      console.error('Failed to save dynamic RPCs:', e);
    }
  },
};

