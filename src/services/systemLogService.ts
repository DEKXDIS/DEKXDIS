import { nativeStore } from './nativeStore';
export interface SystemLogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'success' | 'warn' | 'error';
  category: 'SWAP' | 'BRIDGE' | 'STRATEGY' | 'ORDER' | 'NETWORK' | 'SYSTEM' | 'SECURITY' | 'RPC' | 'MARKET_DATA' | 'WALLET';
  title: string;
  details?: string;
  txHash?: string;
  explorerUrl?: string;
  chainId?: number;
}

const STORAGE_KEY = 'haven_defi_terminal_system_logs_v1';
const MAX_LOG_ENTRIES = 500;

// Listeners for real-time UI updates
type LogListener = (logs: SystemLogEntry[]) => void;
const listeners = new Set<LogListener>();

function loadLogsFromStorage(): SystemLogEntry[] {
  try {
    const raw = typeof window !== 'undefined' ? nativeStore.getItem(STORAGE_KEY) : null;
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load system logs:', e);
    return [];
  }
}

function saveLogsToStorage(logs: SystemLogEntry[]): void {
  try {
    if (typeof window !== 'undefined') {
      nativeStore.setItem(STORAGE_KEY, JSON.stringify(logs.slice(0, MAX_LOG_ENTRIES)));
    }
  } catch (e) {
    console.error('Failed to save system logs:', e);
  }
}

let inMemoryLogs: SystemLogEntry[] = loadLogsFromStorage();

// If empty on first boot, initialize with startup entry
if (inMemoryLogs.length === 0) {
  const initialEntry: SystemLogEntry = {
    id: `log_init_${Date.now()}`,
    timestamp: Date.now(),
    level: 'info',
    category: 'SYSTEM',
    title: 'Terminal Initialized',
    details: 'Multi-chain settlement engine and RPC connections active.',
  };
  inMemoryLogs.push(initialEntry);
  saveLogsToStorage(inMemoryLogs);
}

export const systemLogService = {
  getLogs(): SystemLogEntry[] {
    return [...inMemoryLogs];
  },

  addLog(entry: Omit<SystemLogEntry, 'id' | 'timestamp'> & { timestamp?: number }): SystemLogEntry {
    const fullEntry: SystemLogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: entry.timestamp || Date.now(),
      ...entry,
    };

    inMemoryLogs = [fullEntry, ...inMemoryLogs].slice(0, MAX_LOG_ENTRIES);
    saveLogsToStorage(inMemoryLogs);

    // Notify active listeners
    listeners.forEach((listener) => {
      try {
        listener(inMemoryLogs);
      } catch (err) {
        console.error('Error in log listener:', err);
      }
    });

    return fullEntry;
  },

  logInfo(category: SystemLogEntry['category'], title: string, details?: string, chainId?: number): SystemLogEntry {
    return this.addLog({ level: 'info', category, title, details, chainId });
  },

  logSuccess(category: SystemLogEntry['category'], title: string, details?: string, txHash?: string, explorerUrl?: string, chainId?: number): SystemLogEntry {
    return this.addLog({ level: 'success', category, title, details, txHash, explorerUrl, chainId });
  },

  logWarning(category: SystemLogEntry['category'], title: string, details?: string, chainId?: number): SystemLogEntry {
    console.warn(`[${category}] ${title}${details ? ` - ${details}` : ''}${chainId ? ` (Chain ${chainId})` : ''}`);
    return this.addLog({ level: 'warn', category, title, details, chainId });
  },

  logError(category: SystemLogEntry['category'], title: string, details?: string, chainId?: number): SystemLogEntry {
    console.error(`[${category}] ${title}${details ? ` - ${details}` : ''}${chainId ? ` (Chain ${chainId})` : ''}`);
    return this.addLog({ level: 'error', category, title, details, chainId });
  },

  clearLogs(): void {
    inMemoryLogs = [];
    saveLogsToStorage(inMemoryLogs);
    listeners.forEach((listener) => listener([]));
  },

  subscribe(listener: LogListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  exportLogsAsJson(): string {
    return JSON.stringify(inMemoryLogs, null, 2);
  },
};
