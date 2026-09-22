import { ethers } from 'ethers';
import { getChainConfig, SUPPORTED_CHAINS } from '../types/chains';
import { storageService } from './storageService';
import { systemLogService } from './systemLogService';

export interface RpcHealthResult {
  url: string;
  ok: boolean;
  latencyMs: number;
  blockNumber?: number;
  error?: string;
  tracking?: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  urlTemplate: Record<number, string>;
  dashboardUrl: string;
  description: string;
}

export const RPC_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'alchemy',
    name: 'Alchemy',
    dashboardUrl: 'https://dashboard.alchemy.com/signup',
    description: 'Ultra-fast enterprise RPC for Ethereum, Arbitrum, and Base (Free Tier: 300M compute units/mo).',
    urlTemplate: {
      1: 'https://eth-mainnet.g.alchemy.com/v2/${API_KEY}',
      42161: 'https://arb-mainnet.g.alchemy.com/v2/${API_KEY}',
      8453: 'https://base-mainnet.g.alchemy.com/v2/${API_KEY}',
    },
  },
  {
    id: 'ankr',
    name: 'Ankr Premium / Free',
    dashboardUrl: 'https://www.ankr.com/rpc/',
    description: 'High-speed multi-chain RPC covering all 5 chains (Free Tier available).',
    urlTemplate: {
      1: 'https://rpc.ankr.com/eth/${API_KEY}',
      56: 'https://rpc.ankr.com/bsc/${API_KEY}',
      42161: 'https://rpc.ankr.com/arbitrum/${API_KEY}',
      8453: 'https://rpc.ankr.com/base/${API_KEY}',
      100: 'https://rpc.ankr.com/gnosis/${API_KEY}',
    },
  },
  {
    id: 'infura',
    name: 'Infura',
    dashboardUrl: 'https://www.infura.io/',
    description: 'Consensys institutional RPC for Ethereum, Arbitrum, and Base (Free Tier: 100k req/day).',
    urlTemplate: {
      1: 'https://mainnet.infura.io/v3/${API_KEY}',
      42161: 'https://arbitrum-mainnet.infura.io/v3/${API_KEY}',
      8453: 'https://base-mainnet.infura.io/v3/${API_KEY}',
    },
  },
  {
    id: 'quicknode',
    name: 'QuickNode',
    dashboardUrl: 'https://www.quicknode.com/',
    description: 'Global bare-metal node infrastructure across all major EVM chains.',
    urlTemplate: {},
  },
];

export const RPC_DOMAIN_BLACKLIST = [
  'routeme.sh',
  '1rpc.io',
  'drpc.org',
  'nodies.app',
  'blastapi.io',
  'getblock.io',
  'diamondswap.org',
  'nodeflare.app',
  '4everland.org',
  'tokenview.io',
  'fastnode.io',
  'dwellir.com',
  'thirdweb.com',
  'gateway.tatum.io',
  'nownodes.io',
  'campioneinfrastructure.com',
];

export function isBlacklistedRpc(url: string): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return RPC_DOMAIN_BLACKLIST.some((domain) => lower.includes(domain));
}

class RpcService {
  private dynamicRpcs: Record<number, string[]> = {};
  private failedRpcs: Set<string> = new Set();
  private isSyncing: boolean = false;
  private lastSyncTime: number = 0;

  constructor() {
    this.loadCachedRpcs();
  }

  private loadCachedRpcs() {
    try {
      const cached = storageService.getDynamicRpcs();
      if (cached && Object.keys(cached).length > 0) {
        // Sanitize cached RPCs to remove blacklisted URLs immediately
        const sanitized: Record<number, string[]> = {};
        for (const [cIdStr, urls] of Object.entries(cached)) {
          const cId = parseInt(cIdStr, 10);
          const filtered = urls.filter((u) => !isBlacklistedRpc(u));
          if (filtered.length > 0) {
            sanitized[cId] = filtered;
          }
        }
        this.dynamicRpcs = sanitized;
        storageService.saveDynamicRpcs(sanitized);
      }
    } catch (e) {
      console.warn('[RpcService] Could not load cached dynamic RPCs:', e);
    }
  }

  /**
   * Initializes and triggers background sync with chainlist.org/rpcs.json
   */
  public async init(): Promise<void> {
    const now = Date.now();
    // Cache for 30 minutes
    if (now - this.lastSyncTime > 30 * 60 * 1000) {
      this.syncChainlistRpcs().catch((err) => {
        console.warn('[RpcService] Background Chainlist sync notice:', err);
      });
    }
  }

  /**
   * Fetches latest public RPCs from chainlist.org and benchmarks healthy ones.
   */
  public async syncChainlistRpcs(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const res = await fetch('https://chainlist.org/rpcs.json', {
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`Chainlist returned HTTP ${res.status}`);
      }

      const allChains = await res.json();
      const targetChainIds = [1, 56, 100, 8453, 42161];
      const updatedMap: Record<number, string[]> = {};

      for (const chainId of targetChainIds) {
        const chainData = allChains.find((c: any) => c.chainId === chainId);
        if (!chainData || !chainData.rpc) continue;

        const candidateUrls: string[] = (chainData.rpc || [])
          .map((r: any) => (typeof r === 'string' ? r : r.url))
          .filter((url: string) => 
            url && 
            url.startsWith('https://') && 
            !url.includes('${') && 
            !url.includes('API_KEY') &&
            !isBlacklistedRpc(url)
          );

        // Probe first 10 candidate URLs concurrently
        const probes = await Promise.all(
          candidateUrls.slice(0, 10).map((url) => this.testRpc(url, 2500, chainId))
        );

        const healthy = probes
          .filter((p) => p.ok)
          .sort((a, b) => a.latencyMs - b.latencyMs)
          .map((p) => p.url);

        if (healthy.length > 0) {
          updatedMap[chainId] = healthy;
        }
      }

      if (Object.keys(updatedMap).length > 0) {
        this.dynamicRpcs = { ...this.dynamicRpcs, ...updatedMap };
        storageService.saveDynamicRpcs(this.dynamicRpcs);
        this.lastSyncTime = Date.now();
        systemLogService.logSuccess(
          'NETWORK',
          'Chainlist RPC Sync Completed',
          `Synced active healthy public RPC pools for ${Object.keys(updatedMap).length} chains`
        );
      }
    } catch (err: any) {
      console.warn('[RpcService] Chainlist sync failed:', err);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Returns prioritized list of RPC URLs for a given chainId:
   * 1. User Custom RPC (if configured)
   * 2. Static Chain Config Fallback RPCs (official fast dataseeds)
   * 3. Dynamic Chainlist Probed RPCs (excluding failed/blacklisted ones)
   */
  public getRpcUrls(chainId: number): string[] {
    const list: string[] = [];
    const customRpcs = storageService.getCustomRpcs();
    const userCustom = customRpcs[chainId]?.trim();

    if (userCustom && userCustom.startsWith('http') && !this.failedRpcs.has(userCustom) && !isBlacklistedRpc(userCustom)) {
      list.push(userCustom);
    }

    // Static verified official dataseeds first
    const chainConfig = getChainConfig(chainId);
    for (const url of chainConfig.rpcUrls) {
      if (!this.failedRpcs.has(url) && !isBlacklistedRpc(url) && !list.includes(url)) {
        list.push(url);
      }
    }

    // Dynamic verified pool second
    const dynamicPool = this.dynamicRpcs[chainId] || [];
    for (const url of dynamicPool) {
      if (!this.failedRpcs.has(url) && !isBlacklistedRpc(url) && !list.includes(url)) {
        list.push(url);
      }
    }

    // In case all were marked failed, re-add static defaults so we never return empty
    if (list.length === 0) {
      return [...chainConfig.rpcUrls];
    }

    return list;
  }

  /**
   * Marks an RPC as temporarily failed.
   */
  public markRpcFailed(chainId: number, url: string): void {
    this.failedRpcs.add(url);
    // Un-fail after 3 minutes
    setTimeout(() => {
      this.failedRpcs.delete(url);
    }, 3 * 60 * 1000);
  }

  /**
   * Tests an RPC endpoint with live blockNumber query and latency measurement.
   */
  public async testRpc(url: string, timeoutMs: number = 3500, expectedChainId?: number): Promise<RpcHealthResult> {
    if (isBlacklistedRpc(url)) {
      return { url, ok: false, latencyMs: 0, error: 'Endpoint is blacklisted (commercial quota / paywalled node)' };
    }

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1,
        }),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - start;

      if (!res.ok) {
        const errorMsg = res.status === 429 ? 'Rate limit exceeded (HTTP 429)' : `HTTP ${res.status} ${res.statusText}`;
        return { url, ok: false, latencyMs, error: errorMsg };
      }

      const json = await res.json();
      if (json.error) {
        const msg = json.error.message || 'RPC Error';
        return { url, ok: false, latencyMs, error: msg };
      }

      if (!json.result || typeof json.result !== 'string') {
        return { url, ok: false, latencyMs, error: 'Invalid blockNumber response' };
      }

      const blockNumber = parseInt(json.result, 16);
      if (isNaN(blockNumber) || blockNumber <= 0) {
        return { url, ok: false, latencyMs, error: 'Invalid block number returned' };
      }

      if (expectedChainId !== undefined) {
        const chainResponse = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 2 }), signal: controller.signal });
        const network = await chainResponse.json();
        if (!chainResponse.ok || Number.parseInt(network.result, 16) !== expectedChainId) return { url, ok: false, latencyMs, error: 'RPC serves a different chain or did not identify its chain' };
      }
      return { url, ok: true, latencyMs: Date.now() - start, blockNumber };
    } catch (err: any) {
      clearTimeout(timer);
      const isTimeout = err.name === 'AbortError';
      return {
        url,
        ok: false,
        latencyMs: Date.now() - start,
        error: isTimeout ? `Timeout after ${timeoutMs}ms` : (err.message || 'Network connection failed'),
      };
    } finally { clearTimeout(timer); }
  }
}

export const rpcService = new RpcService();

