import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_CHAIN_ID, getChainConfig, SUPPORTED_CHAINS } from '../types/chains';
import type { AllowanceState, Balances, TokenConfig, WalletValuation } from '../types/trading';
import { storageService } from '../services/storageService';
import { systemLogService } from '../services/systemLogService';
import { web3Service, type ChainBalanceReport } from '../services/web3Service';

const emptyBalances: Balances = {
  bnb: '0', wbnb: '0', usdt: '0', totalUsdValue: '', lastUpdated: 0, isLoading: true, tokenBalances: {},
};
const emptyAllowances: AllowanceState = { wbnbAllowed: false, usdtAllowed: false, isChecking: true, tokenAllowances: {} };
type ChainSnapshot = {
  balances?: Balances;
  allowances?: AllowanceState;
  report?: ChainBalanceReport;
  valuation?: WalletValuation;
  loading: boolean;
};

/** One wallet polling owner for both Workspace and Overview. */
export function useWalletBalances(ownerAddress: string | undefined, selectedChainId: number, selectedToken: TokenConfig, customTokens: TokenConfig[]) {
  const owner = ownerAddress?.toLowerCase();
  const [state, setState] = useState<{ owner?: string; chains: Record<number, ChainSnapshot> }>({ chains: {} });
  const inputs = useRef({ selectedChainId, selectedToken, customTokens });
  inputs.current = { selectedChainId, selectedToken, customTokens };
  const generation = useRef(0);
  const inFlight = useRef(new Map<number, Promise<void>>());

  const refreshChain = useCallback((chainId: number): Promise<void> => {
    if (!owner) return Promise.resolve();
    const pending = inFlight.current.get(chainId);
    if (pending) return pending;
    const currentGeneration = generation.current;
    const current = () => generation.current === currentGeneration;
    const update = (apply: (previous: ChainSnapshot) => ChainSnapshot) => {
      if (!current()) return;
      setState(previous => {
        if (!current()) return previous;
        const chains = previous.owner === owner ? previous.chains : {};
        return { owner, chains: { ...chains, [chainId]: apply(chains[chainId] || { loading: false }) } };
      });
    };
    // Callers waiting after an approval/trade need quantities, not slow display prices.
    let finishBalances!: () => void;
    const balancesReady = new Promise<void>(resolve => { finishBalances = resolve; });
    inFlight.current.set(chainId, balancesReady);
    update(previous => ({ ...previous, loading: true }));
    const { selectedToken: selected, customTokens: custom } = inputs.current;
    const tokens = [selected, ...custom, ...storageService.getTrackedTokens()]
      .filter(token => (token.chainId || DEFAULT_CHAIN_ID) === chainId);
    void web3Service.getChainBalanceReport(owner, chainId, tokens, (balances, allowances) => {
      update(previous => ({ ...previous, balances, allowances }));
      finishBalances();
    }).then(report => {
      update(previous => {
        const chain = getChainConfig(chainId);
        const tokenPricesUsd: Record<string, number> = { [chain.usdtToken.address.toLowerCase()]: 1 };
        if (report.nativePriceUsd !== null) tokenPricesUsd[chain.nativeToken.wrappedAddress.toLowerCase()] = report.nativePriceUsd;
        for (const asset of report.tokens) if (asset.priceUsd !== null) tokenPricesUsd[asset.token.address.toLowerCase()] = asset.priceUsd;
        const valuation: WalletValuation = {
          ownerAddress: owner, chainId, balanceUpdatedAt: report.balanceUpdatedAt || previous.balances?.lastUpdated || 0,
          ...(report.totalChainUsd !== null
            ? { totalUsdValue: report.totalChainUsd.toFixed(2), tokenPricesUsd, updatedAt: report.updatedAt }
            : { totalUsdValue: previous.valuation?.totalUsdValue, tokenPricesUsd: previous.valuation?.tokenPricesUsd,
              updatedAt: previous.valuation?.updatedAt, error: report.error || 'Wallet USD prices unavailable' }),
        };
        return { ...previous, report, valuation, loading: false,
          ...(report.nativeBalance === null ? { balances: { ...(previous.balances || emptyBalances), isLoading: false, error: report.error } } : {}) };
      });
      if (current() && report.error) systemLogService.logWarning('WALLET', 'Wallet balance/valuation refresh incomplete', report.error, chainId);
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      update(previous => ({ ...previous, loading: false,
        balances: { ...(previous.balances || emptyBalances), isLoading: false, error: message },
        valuation: { ...previous.valuation, ownerAddress: owner, chainId, balanceUpdatedAt: previous.balances?.lastUpdated || 0, error: message },
      }));
      if (current()) systemLogService.logError('WALLET', 'Wallet balance refresh failed', message, chainId);
    }).finally(() => {
      if (current()) inFlight.current.delete(chainId);
      finishBalances();
    });
    return balancesReady;
  }, [owner]);

  const refreshBalances = useCallback(async () => {
    const selectedReady = refreshChain(inputs.current.selectedChainId);
    for (const id of Object.keys(SUPPORTED_CHAINS)) if (Number(id) !== inputs.current.selectedChainId) void refreshChain(Number(id));
    await selectedReady;
  }, [refreshChain]);

  useEffect(() => {
    generation.current++;
    inFlight.current.clear();
    setState({ owner, chains: {} });
    if (owner) void refreshBalances();
    const timer = owner ? setInterval(() => { void refreshBalances(); }, 12000) : undefined;
    return () => { generation.current++; inFlight.current.clear(); if (timer !== undefined) clearInterval(timer); };
  }, [owner, refreshBalances]);

  // Query a newly selected/imported token immediately without resetting the polling clock.
  useEffect(() => { void refreshChain(selectedChainId); }, [selectedChainId, selectedToken, customTokens, refreshChain]);

  const chains = state.owner === owner ? state.chains : {};
  const selected = chains[selectedChainId];
  const balances = selected?.balances || emptyBalances;
  const reports = Object.fromEntries(Object.entries(chains).flatMap(([id, snapshot]) => snapshot.report ? [[id, snapshot.report]] : []));
  return {
    balances, allowances: selected?.allowances || emptyAllowances,
    fundingSnapshot: owner && selected?.balances ? { ownerAddress: owner, chainId: selectedChainId, balances } : undefined,
    walletValuation: selected?.valuation,
    chainBalances: reports,
    isLoadingBalances: !!owner && (!Object.keys(chains).length || Object.values(chains).some(snapshot => snapshot.loading)),
    refreshBalances,
  };
}
