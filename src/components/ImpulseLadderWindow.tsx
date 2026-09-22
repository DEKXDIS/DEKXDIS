import { STRATEGIES_ENABLED } from '../config/releaseFeatures';
import React from 'react';
import type { TokenConfig, TradeOrder, WalletState } from '../types/trading';
import { ModuleLibrary } from './modules/ModuleLibrary';

/** Historical component/layout key is retained to preserve saved window positions. */
export const ImpulseLadderWindow: React.FC<{ selectedToken: TokenConfig; selectedChainId: number;
  wallet: WalletState | null; orders: TradeOrder[]; onRequireWallet(): void }> = ({ selectedToken, selectedChainId, wallet }) =>
  STRATEGIES_ENABLED ? <ModuleLibrary token={selectedToken} chainId={selectedChainId} wallet={wallet} /> : null;
