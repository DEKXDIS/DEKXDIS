import { STRATEGIES_ENABLED } from '../../config/releaseFeatures';
import React, { useState, useEffect } from 'react';
import { systemLogService, SystemLogEntry } from '../../services/systemLogService';
import { 
  FileText, 
  Trash2, 
  Download, 
  Search, 
  CheckCircle2, 
  AlertCircle, 
  AlertTriangle, 
  Info,
  ExternalLink,
  ArrowRightLeft,
  Activity,
  Zap,
  Lock
} from 'lucide-react';

export const SystemLogWindow: React.FC = () => {
  const [logs, setLogs] = useState<SystemLogEntry[]>(() => systemLogService.getLogs());
  const [filterCategory, setFilterCategory] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  useEffect(() => {
    const unsubscribe = systemLogService.subscribe((updated) => {
      setLogs(updated);
    });
    return () => unsubscribe();
  }, []);

  const filteredLogs = logs.filter((log) => {
    if (filterCategory === 'ERROR') {
      if (log.level !== 'error') return false;
    } else if (filterCategory !== 'ALL' && log.category !== filterCategory) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        log.title.toLowerCase().includes(q) ||
        (log.details && log.details.toLowerCase().includes(q)) ||
        (log.txHash && log.txHash.toLowerCase().includes(q)) ||
        log.category.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const handleExport = () => {
    const json = systemLogService.exportLogsAsJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `terminal-system-log-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const categories = ['ALL', 'SWAP', 'BRIDGE', ...(STRATEGIES_ENABLED ? ['STRATEGY'] : []), 'ORDER', 'RPC', 'NETWORK', 'SECURITY', 'SYSTEM', 'ERROR'];

  return (
    <div className="h-full flex flex-col justify-between p-2.5 font-mono text-xs select-text">
      
      {/* Top Filter Toolbar */}
      <div className="flex items-center justify-between gap-2 pb-2 border-b border-surface-border shrink-0 flex-wrap">
        <div className="flex items-center gap-1 overflow-x-auto">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setFilterCategory(cat)}
              className={`btn-tactile px-2 py-0.5 rounded-md text-[10px] font-bold transition-all cursor-pointer ${
                filterCategory === cat
                  ? 'bg-theme-primary text-slate-950 shadow-glow-primary'
                  : 'bg-background hover:bg-surface-hover text-slate-400 hover:text-white border border-surface-border'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <div className="flex items-center gap-1 bg-background border border-surface-border focus-within:border-theme-primary rounded-md px-2 py-0.5">
            <Search className="w-3 h-3 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search log..."
              className="bg-transparent text-[10px] text-white focus:outline-none w-24 sm:w-32"
            />
          </div>

          <button
            onClick={handleExport}
            className="btn-tactile p-1 rounded bg-surface hover:bg-surface-hover border border-surface-border hover:border-theme-primary text-slate-300 hover:text-white transition-colors cursor-pointer"
            title="Export JSON Log"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => systemLogService.clearLogs()}
            className="btn-tactile p-1 rounded bg-surface hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 border border-surface-border transition-colors cursor-pointer"
            title="Clear Logs"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Scrolling Log Feed */}
      <div className="flex-1 overflow-y-auto min-h-0 space-y-1.5 py-2">
        {filteredLogs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-slate-500 text-xs">
            <FileText className="w-6 h-6 mb-1 opacity-40" />
            <span>No log entries recorded for current filter.</span>
          </div>
        ) : (
          filteredLogs.map((log) => {
            const timeStr = new Date(log.timestamp).toLocaleTimeString();

            return (
              <div
                key={log.id}
                className="bg-background/80 hover:bg-background border border-surface-border/70 rounded-lg p-2 transition-colors flex items-start gap-2"
              >
                {/* Icon */}
                <div className="mt-0.5 shrink-0">
                  {log.level === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                  {log.level === 'error' && <AlertCircle className="w-3.5 h-3.5 text-rose-400" />}
                  {log.level === 'warn' && <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />}
                  {log.level === 'info' && <Info className="w-3.5 h-3.5 text-cyan-400" />}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 truncate">
                      <span className="text-[9px] px-1 py-0.2 rounded font-bold bg-surface border border-surface-border text-slate-300">
                        {log.category}
                      </span>
                      <span className="font-bold text-slate-200 truncate text-[11px]">{log.title}</span>
                    </div>

                    <span className="text-[10px] text-slate-500 shrink-0">{timeStr}</span>
                  </div>

                  {log.details && (
                    <p className="text-[10px] text-slate-400 mt-0.5 break-all whitespace-pre-wrap leading-tight">
                      {log.details}
                    </p>
                  )}

                  {log.txHash && (
                    <div className="mt-1 flex items-center gap-1">
                      <span className="text-[9px] text-slate-500 truncate">Tx: {log.txHash.slice(0, 18)}...</span>
                      {log.explorerUrl && (
                        <a
                          href={log.explorerUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[9px] text-cow-cyan hover:underline flex items-center gap-0.5"
                        >
                          <span>Explorer</span>
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer Info */}
      <div className="pt-1.5 border-t border-surface-border text-[9px] text-slate-500 flex justify-between shrink-0">
        <span>Universal System Logger ({logs.length} events)</span>
        <span>Auto-synced</span>
      </div>

    </div>
  );
};
