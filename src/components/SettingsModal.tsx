import { ModalDialog } from './ModalDialog';
import React, { useState, useEffect } from 'react';
import { 
  X, 
  Sliders, 
  Palette,
  Check,
  Globe,
  Server,
  Activity,
  ExternalLink,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Info,
  Sparkles
} from 'lucide-react';
import { startupService } from '../services/startupService';
import { ThemeId, THEME_PRESETS } from '../types/theme';
import { SUPPORTED_CHAINS, ChainConfig } from '../types/chains';
import { storageService } from '../services/storageService';
import { rpcService, RPC_PROVIDER_PRESETS, RpcHealthResult } from '../services/rpcService';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentTheme?: ThemeId;
  onSelectTheme?: (themeId: ThemeId) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  currentTheme = 'blue-purple',
  onSelectTheme,
}) => {
  // Custom RPC & Provider States
  const [customRpcs, setCustomRpcs] = useState<Record<number, string>>(() => storageService.getCustomRpcs());
  const [selectedProvider, setSelectedProvider] = useState<string>('custom');
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [testResults, setTestResults] = useState<Record<number, { testing: boolean; result?: RpcHealthResult }>>({});
  const [saveSuccessNotice, setSaveSuccessNotice] = useState<boolean>(false);
  const [isSyncingChainlist, setIsSyncingChainlist] = useState<boolean>(false);
  const [startupEnabled, setStartupEnabled] = useState(false);
  const [startupBusy, setStartupBusy] = useState(false);
  const [startupError, setStartupError] = useState('');

  useEffect(() => {
    if (isOpen) {
      startupService.state().then(state => setStartupEnabled(state.enabled)).catch(error => setStartupError(String(error)));
      setCustomRpcs(storageService.getCustomRpcs());
      const savedKey = storageService.getRpcApiKey();
      if (savedKey.provider) setSelectedProvider(savedKey.provider);
      if (savedKey.apiKey) setApiKeyInput(savedKey.apiKey);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleApplyProviderKey = () => {
    if (!apiKeyInput.trim()) return;
    const preset = RPC_PROVIDER_PRESETS.find(p => p.id === selectedProvider);
    if (!preset) return;

    const updated = { ...customRpcs };
    Object.entries(preset.urlTemplate).forEach(([cIdStr, template]) => {
      const chainId = parseInt(cIdStr, 10);
      updated[chainId] = template.replace('${API_KEY}', apiKeyInput.trim());
    });

    setCustomRpcs(updated);
    storageService.saveCustomRpcs(updated);
    storageService.saveRpcApiKey({ provider: selectedProvider, apiKey: apiKeyInput.trim() });
    setSaveSuccessNotice(true);
    setTimeout(() => setSaveSuccessNotice(false), 3000);
  };

  const handleSaveCustomRpcs = () => {
    storageService.saveCustomRpcs(customRpcs);
    storageService.saveRpcApiKey({ provider: selectedProvider, apiKey: apiKeyInput.trim() });
    setSaveSuccessNotice(true);
    setTimeout(() => setSaveSuccessNotice(false), 3000);
  };

  const handleResetToDefaults = () => {
    setCustomRpcs({});
    setApiKeyInput('');
    setSelectedProvider('custom');
    storageService.saveCustomRpcs({});
    storageService.saveRpcApiKey({ provider: '', apiKey: '' });
    setSaveSuccessNotice(true);
    setTimeout(() => setSaveSuccessNotice(false), 3000);
  };

  const handleTestRpc = async (chainId: number, urlToTest: string) => {
    if (!urlToTest) return;
    setTestResults(prev => ({
      ...prev,
      [chainId]: { testing: true },
    }));

    const res = await rpcService.testRpc(urlToTest, 3500, chainId);
    setTestResults(prev => ({
      ...prev,
      [chainId]: { testing: false, result: res },
    }));
  };

  const handleSyncChainlist = async () => {
    setIsSyncingChainlist(true);
    await rpcService.syncChainlistRpcs();
    setIsSyncingChainlist(false);
  };

  const activePreset = RPC_PROVIDER_PRESETS.find(p => p.id === selectedProvider);

  return (
    <ModalDialog label="Settings" onClose={onClose} busy={false}>
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150 select-text">
      <div className="bg-surface border border-surface-border rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-surface-border bg-surface-hover/30 shrink-0">
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-theme-primary" />
            <h3 className="font-bold text-base text-white">Terminal Settings</h3>
          </div>
          <button
            aria-label="Close" disabled={false} onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-surface-border transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-6 overflow-y-auto font-mono text-xs">
          
          {/* 1. Network & Custom RPC Configuration Section */}
          <div className="space-y-3.5 p-4 rounded-xl bg-background/80 border border-surface-border">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-theme-primary" />
                <span className="font-bold text-sm text-white">Custom RPC Nodes & Network Configuration</span>
              </div>
              <button
                type="button"
                onClick={handleSyncChainlist}
                disabled={isSyncingChainlist}
                className="btn-tactile px-2.5 py-1 rounded-lg bg-surface border border-surface-border hover:border-theme-primary text-[10px] text-slate-300 hover:text-white flex items-center gap-1.5 transition-all cursor-pointer"
                title="Re-probe dynamic public RPCs from chainlist.org"
              >
                <RefreshCw className={`w-3 h-3 ${isSyncingChainlist ? 'animate-spin text-theme-primary' : ''}`} />
                <span>{isSyncingChainlist ? 'Syncing...' : 'Sync Chainlist'}</span>
              </button>
            </div>

            {/* Educational Warning / Suggestion Note */}
            <div className="p-3 rounded-xl bg-theme-primary-10/40 border border-theme-primary/30 text-slate-300 space-y-1.5">
              <div className="flex items-start gap-2">
                <Info className="w-4 h-4 text-theme-primary shrink-0 mt-0.5" />
                <div className="text-[11px] leading-relaxed">
                  <span className="font-bold text-theme-primary">RPC Reliability Notice: </span>
                  Free public RPC endpoints frequently experience rate limits and downtime during market volatility. We strongly recommend registering a <span className="text-white font-bold">free tier RPC node</span> with a dedicated provider and entering your endpoint or API key below.
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1 text-[10px]">
                <span className="text-slate-400">Sign Up Free:</span>
                <a 
                  href="https://dashboard.alchemy.com/signup" 
                  target="_blank" 
                  rel="noreferrer"
                  className="px-2 py-0.5 rounded bg-surface border border-surface-border hover:border-theme-primary text-theme-primary font-bold flex items-center gap-1"
                >
                  <span>Alchemy</span>
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
                <a 
                  href="https://www.ankr.com/rpc/" 
                  target="_blank" 
                  rel="noreferrer"
                  className="px-2 py-0.5 rounded bg-surface border border-surface-border hover:border-theme-primary text-theme-primary font-bold flex items-center gap-1"
                >
                  <span>Ankr</span>
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
                <a 
                  href="https://www.quicknode.com/" 
                  target="_blank" 
                  rel="noreferrer"
                  className="px-2 py-0.5 rounded bg-surface border border-surface-border hover:border-theme-primary text-theme-primary font-bold flex items-center gap-1"
                >
                  <span>QuickNode</span>
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
                <a 
                  href="https://www.infura.io/" 
                  target="_blank" 
                  rel="noreferrer"
                  className="px-2 py-0.5 rounded bg-surface border border-surface-border hover:border-theme-primary text-theme-primary font-bold flex items-center gap-1"
                >
                  <span>Infura</span>
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
            </div>

            {/* Provider Auto-Config Wizard */}
            <div className="p-3 rounded-xl bg-surface border border-surface-border space-y-2.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-bold text-slate-200 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-theme-secondary" />
                  <span>Provider API Key Quick-Fill</span>
                </span>
                {activePreset?.dashboardUrl && (
                  <a
                    href={activePreset.dashboardUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-theme-primary hover:underline flex items-center gap-1 text-[10px]"
                  >
                    <span>Get {activePreset.name} Key</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <select
                  value={selectedProvider}
                  onChange={(e) => setSelectedProvider(e.target.value)}
                  className="bg-background border border-surface-border rounded-lg px-2.5 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-theme-primary"
                >
                  <option value="custom">Custom URLs (Manual)</option>
                  <option value="alchemy">Alchemy API Key</option>
                  <option value="ankr">Ankr API Key</option>
                  <option value="infura">Infura API Key</option>
                </select>

                <input
                  type="text"
                  placeholder={selectedProvider === 'custom' ? 'Manual mode active' : 'Paste API Key / Token'}
                  disabled={selectedProvider === 'custom'}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  className="bg-background border border-surface-border rounded-lg px-2.5 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-theme-primary disabled:opacity-40"
                />

                <button
                  type="button"
                  disabled={selectedProvider === 'custom' || !apiKeyInput.trim()}
                  onClick={handleApplyProviderKey}
                  className="btn-tactile py-1.5 rounded-lg bg-theme-primary text-slate-950 font-bold text-xs disabled:opacity-40 transition-all cursor-pointer"
                >
                  Apply to All Chains
                </button>
              </div>
              {activePreset?.description && (
                <p className="text-[10px] text-slate-400">{activePreset.description}</p>
              )}
            </div>

            {/* Per-Chain Custom RPC Inputs */}
            <div className="space-y-2.5 pt-1">
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">
                Active RPC Endpoints per Network
              </span>

              {Object.entries(SUPPORTED_CHAINS).map(([cIdStr, chainCfg]) => {
                const chainId = parseInt(cIdStr, 10);
                const customVal = customRpcs[chainId] || '';
                const activeUrls = rpcService.getRpcUrls(chainId);
                const currentActiveUrl = customVal || activeUrls[0] || chainCfg.rpcUrls[0];
                const testState = testResults[chainId];

                return (
                  <div key={chainId} className="p-2.5 rounded-xl bg-surface/60 border border-surface-border space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-xs">{chainCfg.name}</span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-surface-border text-slate-400 font-bold">
                          ID: {chainId}
                        </span>
                      </div>
                      
                      {/* Test Result Indicator */}
                      {testState?.testing ? (
                        <div className="flex items-center gap-1 text-[10px] text-theme-primary animate-pulse">
                          <Activity className="w-3 h-3 animate-spin" />
                          <span>Pinging node...</span>
                        </div>
                      ) : testState?.result ? (
                        testState.result.ok ? (
                          <div className="flex items-center gap-1 text-[10px] text-emerald-400 font-bold">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>{testState.result.latencyMs}ms (Block #{testState.result.blockNumber})</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 text-[10px] text-rose-400 font-bold" title={testState.result.error}>
                            <AlertCircle className="w-3 h-3" />
                            <span>Failed: {testState.result.error?.slice(0, 20)}...</span>
                          </div>
                        )
                      ) : null}
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        placeholder={`Default: ${activeUrls[0] || chainCfg.rpcUrls[0]}`}
                        value={customVal}
                        onChange={(e) => {
                          const val = e.target.value;
                          setCustomRpcs(prev => ({
                            ...prev,
                            [chainId]: val,
                          }));
                        }}
                        className="flex-1 bg-background border border-surface-border focus:border-theme-primary rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleTestRpc(chainId, currentActiveUrl)}
                        className="btn-tactile px-3 py-1.5 rounded-lg bg-surface border border-surface-border hover:border-theme-primary text-[10px] font-bold text-slate-300 hover:text-white transition-all cursor-pointer shrink-0"
                      >
                        Ping Node
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Save & Reset Actions */}
            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={handleResetToDefaults}
                className="text-[11px] text-slate-400 hover:text-rose-400 hover:underline cursor-pointer"
              >
                Reset to Chainlist Defaults
              </button>

              <div className="flex items-center gap-2">
                {saveSuccessNotice && (
                  <span className="text-[11px] text-emerald-400 font-bold flex items-center gap-1 animate-in fade-in">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Saved!</span>
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleSaveCustomRpcs}
                  className="btn-tactile px-4 py-2 rounded-xl bg-theme-primary text-slate-950 font-bold text-xs shadow-glow-primary transition-all cursor-pointer"
                >
                  Save RPC Settings
                </button>
              </div>
            </div>

          </div>

          {/* 2. Color Scheme & Theme Selection */}
          {onSelectTheme && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                  <Palette className="w-3.5 h-3.5 text-theme-primary" />
                  <span>Color Scheme & Theme</span>
                </label>
                <span className="text-[10px] text-slate-400">Click to switch</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {THEME_PRESETS.map((theme) => {
                  const isSelected = theme.id === currentTheme;
                  return (
                    <button
                      key={theme.id}
                      onClick={() => onSelectTheme(theme.id)}
                      className={`btn-tactile p-2.5 rounded-xl border text-left flex items-center justify-between gap-2 transition-all cursor-pointer ${
                        isSelected
                          ? 'bg-theme-primary-10 border-theme-primary shadow-glow-primary'
                          : 'bg-background/80 border-surface-border hover:border-slate-600 hover:bg-slate-900/40 text-slate-300'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-white truncate">{theme.name}</div>
                        <div className="flex items-center gap-1.5 mt-0.5 text-[9px] text-slate-400">
                          <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: theme.primaryColor }}></span>
                          <span>{theme.primaryName}</span>
                          <span>·</span>
                          <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: theme.secondaryColor }}></span>
                          <span>{theme.secondaryName}</span>
                        </div>
                      </div>
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 border transition-all ${
                        isSelected
                          ? 'bg-theme-primary border-theme-primary text-slate-950 font-bold'
                          : 'border-slate-700 bg-slate-950 text-transparent'
                      }`}>
                        <Check className="w-3 h-3 stroke-[3]" />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 6. Protocol Settlement Network Information */}
          <div className="p-3.5 rounded-xl bg-background border border-surface-border flex items-center justify-between">
            <div className="pr-3">
              <div className="text-xs font-bold text-slate-200">Start with Windows and restart after a crash</div>
              <div className="text-[11px] text-slate-400">Starts DEKXDIS when you sign in to Windows. If DEKXDIS ends unexpectedly, a small local watchdog restarts it. Confirmed manual closing keeps it closed.</div>
              {startupError && <div className="text-[11px] text-rose-400 mt-1">{startupError}</div>}
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input type="checkbox" checked={startupEnabled} disabled={startupBusy} onChange={async event => {
                const enabled = event.target.checked; setStartupBusy(true); setStartupError('');
                try { const state = await startupService.setEnabled(enabled); setStartupEnabled(state.enabled); }
                catch (error) { setStartupError(String(error)); }
                finally { setStartupBusy(false); }
              }} className="sr-only peer" />
              <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-theme-primary"></div>
            </label>
          </div>

          {/* Close Button */}
          <button
            onClick={onClose}
            className="btn-tactile w-full py-3 rounded-xl bg-theme-gradient text-slate-950 font-extrabold text-xs shadow-glow-primary transition-all shrink-0 cursor-pointer"
          >
            Done
          </button>

        </div>

      </div>
    </div>
    </ModalDialog>
  );
};



