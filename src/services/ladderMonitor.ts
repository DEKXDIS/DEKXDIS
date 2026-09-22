import { STRATEGIES_ENABLED } from '../config/releaseFeatures';
import type { WalletState } from '../types/trading';
import { nativeStore } from './nativeStore';
import { moduleHost } from '../modules/host';
import { systemLogService } from './systemLogService';

/** Compatibility name for the app-level scheduler; never depends on the visible chart. */
export function createLadderMonitor(wallet: WalletState) {
  let stopped = false;
  return { stop() { stopped = true; }, async tick() {
    if (!STRATEGIES_ENABLED || stopped || nativeStore.getWallet()?.address !== wallet.address) return;
    try { await moduleHost.tick(); }
    catch (error) { systemLogService.logError('STRATEGY', 'Module host needs attention', String(error)); }
  } };
}
