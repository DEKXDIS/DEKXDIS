import { STRATEGIES_ENABLED } from '../config/releaseFeatures';
import React, { useState, useRef, useEffect } from 'react';
import { UpdateNotice } from './UpdateNotice';
import { UserGuideLink } from './UserGuideLink';
import { ShieldCheck, RefreshCw, LayoutGrid, Settings, ChevronDown, Plus, Globe, Sparkles, Pin, LayoutDashboard, Palette, Zap, TrendingUp } from 'lucide-react';
import { MarketPrice, TokenConfig, getDefaultTokensForChain } from '../types/trading';
import { SUPPORTED_CHAINS, getChainConfig } from '../types/chains';
import { storageService } from '../services/storageService';
import { marketDataService } from '../services/marketDataService';
import { getPricePrecision } from './TradingViewChart';
import { ThemeId, getThemeConfig } from '../types/theme';

interface HeaderProps {
  activeLadders?: ReturnType<typeof storageService.getAllRunningLadders>;
  onSelectActiveLadder?: (token: TokenConfig, chainId: number) => void;
  selectedChainId: number;
  onSelectChain: (chainId: number) => void;
  selectedToken: TokenConfig;
  onSelectToken: (token: TokenConfig) => void;
  customTokens: TokenConfig[];
  alphaTokens: TokenConfig[];
  onOpenAddTokenModal: () => void;
  marketPrice: MarketPrice;
  onRefreshPrice: () => void;
  isPriceLoading: boolean;
  onResetLayout: () => void;
  onOpenSettings: () => void;
  onOpenTokenAudit?: () => void;
  onOpenThemeModal?: () => void;
  currentTheme?: ThemeId;
  isOverviewOpen?: boolean;
  onToggleOverview?: () => void;
  onToggleLadder?: () => void;
  isLadderOpen?: boolean;
}


export const Header: React.FC<HeaderProps> = ({
  activeLadders = [],
  onSelectActiveLadder,
  selectedChainId,
  onSelectChain,
  selectedToken,
  onSelectToken,
  customTokens,
  alphaTokens,
  onOpenAddTokenModal,
  marketPrice,
  onRefreshPrice,
  isPriceLoading,
  onResetLayout,
  onOpenSettings,
  onOpenTokenAudit,
  onOpenThemeModal,
  currentTheme = 'blue-purple',
  isOverviewOpen = false,
  onToggleOverview,
  onToggleLadder,
  isLadderOpen = false,
}) => {
  const [isChainOpen, setIsChainOpen] = useState(false);
  const [isTokenOpen, setIsTokenOpen] = useState(false);
  const [tokenSearch, setTokenSearch] = useState('');
  const [pinnedTokens, setPinnedTokens] = useState<string[]>(() =>
    storageService.getPinnedTokens(selectedChainId)
  );

  const chainRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef<HTMLDivElement>(null);

  const activeChainConfig = getChainConfig(selectedChainId);
  const isPositive = marketPrice.change24h >= 0;

  useEffect(() => {
    setPinnedTokens(storageService.getPinnedTokens(selectedChainId));
  }, [selectedChainId]);

  const handleTogglePin = (e: React.MouseEvent, address: string) => {
    e.stopPropagation();
    const updated = storageService.togglePinnedToken(address, selectedChainId);
    setPinnedTokens(updated);
  };

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (chainRef.current && !chainRef.current.contains(event.target as Node)) {
        setIsChainOpen(false);
      }
      if (tokenRef.current && !tokenRef.current.contains(event.target as Node)) {
        setIsTokenOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const defaultTokens = getDefaultTokensForChain(selectedChainId);
  const currentChainCustom = customTokens.filter((t) => t.chainId === selectedChainId);
  const effectiveAlphaTokens: TokenConfig[] = alphaTokens.length > 0 ? alphaTokens : marketDataService.getCachedAlphaTokens(selectedChainId);
  const currentChainAlpha: TokenConfig[] = effectiveAlphaTokens.filter((t: TokenConfig) => (t.chainId || selectedChainId) === selectedChainId);

  // All chain tokens combined
  const allChainTokens = [...defaultTokens, ...currentChainAlpha, ...currentChainCustom].filter(
    (t, index, self) => index === self.findIndex((o) => o.address.toLowerCase() === t.address.toLowerCase())
  );

  const pinnedList = allChainTokens.filter((t) =>
    pinnedTokens.some((p) => p.toLowerCase() === t.address.toLowerCase())
  );

  // Filter tokens by search query
  const query = tokenSearch.toLowerCase().trim();
  const filteredPinned = pinnedList.filter(
    (t) => t.symbol.toLowerCase().includes(query) || t.name.toLowerCase().includes(query) || t.address.toLowerCase().includes(query)
  );
  const filteredDefaults = defaultTokens.filter(
    (t) => t.symbol.toLowerCase().includes(query) || t.name.toLowerCase().includes(query) || t.address.toLowerCase().includes(query)
  );
  const filteredCustom = currentChainCustom.filter(
    (t) => t.symbol.toLowerCase().includes(query) || t.name.toLowerCase().includes(query) || t.address.toLowerCase().includes(query)
  );
  const filteredAlpha: TokenConfig[] = currentChainAlpha.filter(
    (t: TokenConfig) => t.symbol.toLowerCase().includes(query) || t.name.toLowerCase().includes(query) || t.address.toLowerCase().includes(query)
  );

  return (
    <header className="relative border-b border-surface-border bg-surface/95 backdrop-blur-md px-3 lg:px-6 py-2.5 shrink-0 z-[100]">
      <div className="flex flex-col md:flex-row items-center justify-between gap-3">
        
        {/* Left: Brand + Chain Selector + Global Token Selector + Overview */}
        <div className="flex items-center gap-2.5 w-full md:w-auto justify-between md:justify-start flex-wrap">
          {/* Logo & Terminal Brand */}
          <div className="flex items-center gap-2 mr-1">
            <div className="w-8 h-8 rounded-xl bg-theme-gradient flex items-center justify-center text-slate-950 font-black text-sm shadow-glow-primary border border-white/20">
              <Zap className="w-4 h-4 fill-slate-950 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="font-bold text-sm text-white tracking-tight flex items-center gap-1">
                  <span className="text-theme-gradient font-extrabold">DEKXDIS</span>
                </h1>
              </div>
            </div>
          </div>

          <UpdateNotice />
          {STRATEGIES_ENABLED && activeLadders.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-emerald-300">
              <span>Active strategies ({activeLadders.length})</span>
              <select
                aria-label="Switch to active strategy token"
                className="max-w-48 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-100"
                value={activeLadders.some(l => l.chainId === selectedChainId && l.tokenAddress.toLowerCase() === selectedToken.address.toLowerCase()) ? `${selectedChainId}:${selectedToken.address.toLowerCase()}` : ''}
                onChange={event => {
                  const item = activeLadders.find(l => `${l.chainId}:${l.tokenAddress.toLowerCase()}` === event.target.value);
                  if (item?.token) onSelectActiveLadder?.(item.token, item.chainId);
                }}
              >
                <option value="" disabled>Switch active token</option>
                {activeLadders.map(item => (
                  <option key={`${item.chainId}:${item.tokenAddress}`} value={`${item.chainId}:${item.tokenAddress.toLowerCase()}`} disabled={!item.token}>
                    {item.token?.symbol || item.settings.symbol || 'Unknown token'} | {getChainConfig(item.chainId).shortName} | ...{item.tokenAddress.slice(-6)}{!item.token ? ' (needs setup)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {/* Chain Selector Dropdown */}
          <div className="relative" ref={chainRef}>
            <button
              onClick={() => {
                setIsChainOpen(!isChainOpen);
                setIsTokenOpen(false);
              }}
              className="btn-tactile flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-850 border border-slate-700 hover:border-theme-primary text-xs font-mono text-slate-200 transition-all cursor-pointer shadow-sm group"
            >
              <Globe className="w-3.5 h-3.5 text-theme-primary" />
              <span className="font-bold">{activeChainConfig.shortName}</span>
              <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-theme-primary transition-colors" />
            </button>

            {isChainOpen && (
              <div className="absolute left-0 mt-1.5 w-48 bg-slate-900 border border-slate-700/80 rounded-xl shadow-2xl z-[9999] overflow-hidden py-1 animate-in fade-in duration-100">
                <div className="px-3 py-1.5 text-[10px] uppercase font-bold text-slate-400 tracking-wider border-b border-slate-800">
                  Select Settlement Chain
                </div>
                {Object.values(SUPPORTED_CHAINS).map((chain) => (
                  <button
                    key={chain.chainId}
                    onClick={() => {
                      onSelectChain(chain.chainId);
                      setIsChainOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                      chain.chainId === selectedChainId
                        ? 'bg-theme-primary-10 text-theme-primary font-bold border-l-2 border-theme-primary'
                        : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                    }`}
                  >
                    <span>{chain.name}</span>
                    <span className="text-[10px] font-mono text-slate-400">ID: {chain.chainId}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Global Active Token Selector Dropdown */}
          <div className="relative" ref={tokenRef}>
            <button
              onClick={() => {
                setIsTokenOpen(!isTokenOpen);
                setIsChainOpen(false);
              }}
              className="btn-tactile flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-850 border border-slate-700 hover:border-theme-secondary text-xs font-semibold text-white transition-all shadow-sm cursor-pointer group"
            >
              {selectedToken.logoUrl ? (
                <img src={selectedToken.logoUrl} alt={selectedToken.symbol} className="w-4 h-4 rounded-full object-cover" />
              ) : (
                <div className="w-4 h-4 rounded-full bg-theme-secondary-10 text-theme-secondary flex items-center justify-center text-[9px] font-bold">
                  {selectedToken.symbol.slice(0, 2)}
                </div>
              )}
              <span className="font-bold tracking-wide">{selectedToken.symbol}</span>
              {selectedToken.isAlpha && (
                <span className="px-1.5 py-0.2 rounded bg-theme-secondary-10 text-theme-secondary text-[9px] font-mono border border-theme-secondary-30">
                  ALPHA
                </span>
              )}
              <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-theme-secondary transition-colors" />
            </button>

            {isTokenOpen && (
              <div className="absolute left-0 mt-1.5 w-80 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-[9999] overflow-hidden flex flex-col max-h-96 animate-in fade-in duration-100">
                {/* Search Bar */}
                <div className="p-2 border-b border-slate-800 bg-slate-950/60">
                  <input
                    type="text"
                    value={tokenSearch}
                    onChange={(e) => setTokenSearch(e.target.value)}
                    placeholder="Search by Symbol, Name or 0x..."
                    className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700/70 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                    autoFocus
                  />
                </div>

                <div className="overflow-y-auto divide-y divide-slate-800/60 flex-1">
                  {/* 1. TOP PINNED TOKENS (if any) */}
                  {filteredPinned.length > 0 && (
                    <div className="py-1 bg-blue-500/5 border-b border-blue-500/20">
                      <div className="px-3 py-1 text-[10px] uppercase font-bold text-blue-400 tracking-wider flex items-center justify-between">
                        <span className="flex items-center gap-1">
                          <Pin className="w-3 h-3 text-blue-400" />
                          Pinned
                        </span>
                        <span className="text-[9px] font-mono text-slate-400">{filteredPinned.length}</span>
                      </div>
                      {filteredPinned.map((token) => (
                        <div
                          key={`pinned-${token.address}`}
                          onClick={() => {
                            onSelectToken(token);
                            setIsTokenOpen(false);
                            setTokenSearch('');
                          }}
                          className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                            token.address.toLowerCase() === selectedToken.address.toLowerCase()
                              ? 'bg-blue-500/15 text-blue-400 font-semibold'
                              : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                          }`}
                        >
                          <div className="flex items-center space-x-2">
                            <input
                              type="checkbox"
                              checked={true}
                              onChange={(e) => handleTogglePin(e as any, token.address)}
                              onClick={(e) => e.stopPropagation()}
                              className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-900 text-blue-500 focus:ring-0 focus:ring-offset-0 cursor-pointer accent-blue-500"
                              title="Unpin"
                            />
                            {token.logoUrl ? (
                              <img src={token.logoUrl} alt={token.symbol} className="w-4 h-4 rounded-full" />
                            ) : (
                              <div className="w-4 h-4 rounded-full bg-slate-800 text-[9px] flex items-center justify-center font-bold">
                                {token.symbol.slice(0, 2)}
                              </div>
                            )}
                            <span className="font-bold">{token.symbol}</span>
                            <span className="text-[11px] text-slate-400 truncate max-w-[130px]">{token.name}</span>
                          </div>
                          {token.isAlpha && (
                            <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-purple-500/10 text-purple-300">
                              Alpha
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 2. UNIFIED CHAIN TOKEN LIST */}
                  <div className="py-1">
                    {allChainTokens
                      .filter((t) => !pinnedTokens.some((p) => p.toLowerCase() === t.address.toLowerCase()))
                      .filter((t) => t.symbol.toLowerCase().includes(query) || t.name.toLowerCase().includes(query) || t.address.toLowerCase().includes(query))
                      .map((token) => (
                        <div
                          key={token.address}
                          onClick={() => {
                            onSelectToken(token);
                            setIsTokenOpen(false);
                            setTokenSearch('');
                          }}
                          className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                            token.address.toLowerCase() === selectedToken.address.toLowerCase()
                              ? 'bg-blue-500/15 text-blue-400 font-semibold'
                              : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                          }`}
                        >
                          <div className="flex items-center space-x-2">
                            <input
                              type="checkbox"
                              checked={false}
                              onChange={(e) => handleTogglePin(e as any, token.address)}
                              onClick={(e) => e.stopPropagation()}
                              className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-900 text-blue-500 focus:ring-0 focus:ring-offset-0 cursor-pointer accent-blue-500"
                              title="Pin to top"
                            />
                            {token.logoUrl ? (
                              <img src={token.logoUrl} alt={token.symbol} className="w-4 h-4 rounded-full" />
                            ) : (
                              <div className="w-4 h-4 rounded-full bg-slate-800 text-[9px] flex items-center justify-center font-bold">
                                {token.symbol.slice(0, 2)}
                              </div>
                            )}
                            <span className="font-bold">{token.symbol}</span>
                            <span className="text-[11px] text-slate-400 truncate max-w-[130px]">{token.name}</span>
                          </div>
                          {token.isAlpha && (
                            <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-purple-500/10 text-purple-300">
                              Alpha
                            </span>
                          )}
                        </div>
                      ))}
                  </div>
                </div>

                {/* Bottom Action: + Add Custom Token by Address */}
                <div className="p-2 border-t border-slate-800 bg-slate-950/80">
                  <button
                    onClick={() => {
                      setIsTokenOpen(false);
                      onOpenAddTokenModal();
                    }}
                    className="btn-tactile w-full py-1.5 px-3 bg-theme-gradient text-slate-950 font-bold rounded-lg text-xs flex items-center justify-center space-x-1.5 transition-all shadow-glow-primary cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>+ Add Token by Contract Address</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Overview Dashboard Toggle Button */}
          {onToggleOverview && (
            <button
              onClick={onToggleOverview}
              className={`btn-tactile flex items-center justify-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold font-mono transition-all min-w-[130px] cursor-pointer ${
                isOverviewOpen
                  ? 'bg-theme-gradient text-slate-950 font-extrabold shadow-glow-primary'
                  : 'bg-slate-900 border border-slate-700 text-slate-300 hover:text-white hover:border-theme-primary hover:bg-slate-850 shadow-sm'
              }`}
              title={isOverviewOpen ? 'Return to Trading Workspace' : 'Open Multi-Chain Portfolio Overview'}
            >
              <LayoutDashboard className="w-4 h-4 shrink-0" />
              <span>{isOverviewOpen ? 'Dashboard Active' : 'Overview'}</span>
            </button>
          )}

          <UserGuideLink />

          {/* Quick Actions (Mobile) */}
          <div className="flex md:hidden items-center gap-1.5">
            {onOpenThemeModal && (
              <button
                onClick={onOpenThemeModal}
                className="btn-tactile p-1.5 rounded-lg bg-slate-900 border border-slate-700 text-theme-primary hover:text-white cursor-pointer"
                title="Theme Colors"
              >
                <Palette className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={onResetLayout}
              className="btn-tactile p-1.5 rounded-lg bg-surface border border-surface-border text-slate-300 hover:text-white cursor-pointer"
              title="Reset Window Layout"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onOpenSettings}
              className="btn-tactile p-1.5 rounded-lg bg-surface border border-surface-border text-slate-300 hover:text-white cursor-pointer"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Center: Live Market Price Ticker */}
        <div className="flex items-center gap-3 bg-slate-950/80 border border-surface-border px-3 py-1 rounded-xl">
          <div className="flex items-center gap-1.5 font-mono text-xs">
            <span className="text-slate-400">{selectedToken.symbol}/USD:</span>
            <span className="font-bold text-white">
              ${marketPrice.price > 0 ? getPricePrecision(marketPrice.price).format(marketPrice.price) : '---.--'}
            </span>
          </div>

          <div
            className={`flex items-center gap-0.5 text-[11px] font-mono font-semibold px-1.5 py-0.2 rounded ${
              isPositive 
                ? 'bg-theme-primary-10 text-theme-primary border border-theme-primary-30' 
                : 'bg-theme-secondary-10 text-theme-secondary border border-theme-secondary-30'
            }`}
          >
            {isPositive ? '+' : ''}{marketPrice.change24h.toFixed(2)}%
          </div>

          <div className="hidden sm:flex items-center gap-2 text-[10px] font-mono text-slate-400 border-l border-surface-border pl-2">
            <span>24h H: <strong className="text-slate-300">${marketPrice.high24h > 0 ? getPricePrecision(marketPrice.high24h).format(marketPrice.high24h) : '0.00'}</strong></span>
            <span>24h L: <strong className="text-slate-300">${marketPrice.low24h > 0 ? getPricePrecision(marketPrice.low24h).format(marketPrice.low24h) : '0.00'}</strong></span>
          </div>

          <button
            onClick={onRefreshPrice}
            disabled={isPriceLoading}
            title="Refresh Price"
            className="btn-tactile text-slate-400 hover:text-theme-primary transition-colors p-0.5 cursor-pointer"
          >
            <RefreshCw className={`w-3 h-3 ${isPriceLoading ? 'animate-spin text-theme-primary' : ''}`} />
          </button>

          {onOpenTokenAudit && (
            <button
              onClick={onOpenTokenAudit}
              title={`Audit ${selectedToken.symbol} (GoPlus Security & Liquidity)`}
              className="btn-tactile flex items-center gap-1 px-2 py-0.5 rounded-lg bg-theme-primary-10 hover:bg-theme-primary-20 border border-theme-primary-30 text-theme-primary text-[10px] font-mono font-semibold transition-colors cursor-pointer"
            >
              <ShieldCheck className="w-3 h-3 text-theme-primary" />
              <span>Audit</span>
            </button>
          )}
        </div>

        {/* Right: Network Status (BORDERLESS) & Workspace Controls */}
        <div className="hidden md:flex items-center gap-3">
          {/* Borderless Status Badges */}
          <div className="flex items-center gap-3 text-[11px] font-mono text-slate-400">
            <div className="flex items-center gap-1.5 text-theme-primary">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-theme-primary opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-theme-primary"></span>
              </span>
              <span>{activeChainConfig.shortName} Live</span>
            </div>

          </div>

          {/* Action Button Controls */}
          <div className="flex items-center gap-1.5 border-l border-surface-border pl-3">
            {STRATEGIES_ENABLED && onToggleLadder && (
              <button
                onClick={onToggleLadder}
                className={`btn-tactile flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-all text-xs font-medium cursor-pointer shadow-sm ${
                  isLadderOpen
                    ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-400 font-bold'
                    : 'bg-slate-900 border-slate-700 text-slate-300 hover:text-white hover:border-emerald-500/50'
                }`}
                title="Toggle Strategy Modules"
              >
                <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                <span className="hidden sm:inline">Strategy Modules</span>
              </button>
            )}

            {onOpenThemeModal && (
              <button
                onClick={onOpenThemeModal}
                className="btn-tactile flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 hover:border-theme-primary text-slate-300 hover:text-white transition-all text-xs font-medium cursor-pointer shadow-sm"
                title="Change Color Scheme & Theme"
              >
                <Palette className="w-3.5 h-3.5 text-theme-primary" />
                <span className="hidden lg:inline">{getThemeConfig(currentTheme).name.split(' ')[0]}</span>
              </button>
            )}

            <button
              onClick={onResetLayout}
              className="btn-tactile flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-300 hover:text-white hover:border-theme-primary transition-all text-xs font-medium cursor-pointer shadow-sm"
              title="Reset All Windows to Default Layout"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span className="hidden xl:inline">Reset Layout</span>
            </button>

            <button
              onClick={onOpenSettings}
              className="btn-tactile p-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 transition-colors cursor-pointer shadow-sm"
              title="Terminal Settings"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

      </div>
    </header>
  );
};
