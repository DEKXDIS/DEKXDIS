import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getChainConfig, getTradingQuoteToken } from '../types/chains';
import type { OrderFundingSnapshot } from '../utils/orderFunding';
import type { TokenConfig, WalletValuation } from '../types/trading';
import { formatTokenDisplay, formatUsdDisplay } from '../utils/displayFormat';
import { useFreshTimestamp } from '../hooks/useFreshTimestamp';

export interface WalletTradeDropdownProps {
  chainId: number;
  walletAddress?: string;
  balanceSnapshot?: OrderFundingSnapshot;
  nativePriceSnapshot?: { chainId: number; price: number; timestamp: number };
  selectedToken?: TokenConfig;
  tokenPriceSnapshot?: { chainId: number; address: string; price: number; timestamp: number };
  walletValuation?: WalletValuation;
  onRefreshBalances: () => void;
  isWorkspaceActive: boolean;
  isModalOpen: boolean;
  isOpen: boolean;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  buttonRef: React.RefObject<HTMLButtonElement>;
  panelId: string;
  children: React.ReactNode;
}

/** Visibility never unmounts the trade form or interrupts an operation. */
export const WalletTradeDropdown: React.FC<WalletTradeDropdownProps> = ({
  chainId, walletAddress, balanceSnapshot, nativePriceSnapshot,
  selectedToken, tokenPriceSnapshot, walletValuation, onRefreshBalances,
  isWorkspaceActive, isModalOpen, isOpen, setIsOpen, buttonRef, panelId, children,
}) => {
  const [position, setPosition] = useState({ top: 0, left: 0, width: 620, maxHeight: 500 });
  const [now, setNow] = useState(Date.now);
  const panelRef = useRef<HTMLDivElement>(null);
  const token = getTradingQuoteToken(chainId);
  const chain = getChainConfig(chainId);
  const visible = isOpen && isWorkspaceActive && !isModalOpen;
  const displayTime = Math.max(now, Date.now());

  useEffect(() => {
    if (!isWorkspaceActive || isModalOpen) setIsOpen(false);
  }, [isWorkspaceActive, isModalOpen, setIsOpen]);

  // Expire display valuation even if no other state changes after a failed refresh.
  useEffect(() => {
    const expiries = [nativePriceSnapshot?.timestamp, tokenPriceSnapshot?.timestamp]
      .filter((timestamp): timestamp is number => timestamp !== undefined)
      .map(timestamp => timestamp + 30000).filter(expiry => expiry > Date.now());
    if (!expiries.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(...expiries) - Date.now()));
    return () => clearTimeout(timer);
  }, [nativePriceSnapshot, tokenPriceSnapshot, now]);

  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const button = buttonRef.current;
      if (!button) return;
      const anchor = button.getBoundingClientRect();
      const width = Math.min(620, window.innerWidth - 24);
      const top = anchor.bottom + 8;
      setPosition({
        top, width,
        left: Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12)),
        maxHeight: Math.max(0, window.innerHeight - top - 12),
      });
    };
    place();
    panelRef.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    const strip = buttonRef.current?.closest('[data-workspace-bar]');
    if (strip) observer.observe(strip);
    const header = document.querySelector('header');
    if (header) observer.observe(header);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [visible, buttonRef]);

  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !panelRef.current?.contains(target)) setIsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setIsOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
    };
  }, [visible, buttonRef, setIsOpen]);

  const snapshot = walletAddress && balanceSnapshot?.chainId === chainId &&
    balanceSnapshot.ownerAddress.toLowerCase() === walletAddress.toLowerCase() ? balanceSnapshot : undefined;
  const raw = snapshot?.balances.tokenBalances?.[token.address.toLowerCase()] ?? snapshot?.balances.wbnb;
  const amount = raw !== undefined && /^\d+(\.\d+)?$/.test(raw) && Number.isFinite(Number(raw)) ? raw : undefined;
  const price = nativePriceSnapshot?.chainId === chainId && displayTime - nativePriceSnapshot.timestamp < 30000 &&
    Number.isFinite(nativePriceSnapshot.price) && nativePriceSnapshot.price > 0 ? nativePriceSnapshot.price : undefined;
  const usd = amount !== undefined && price !== undefined ? Number(amount) * price : undefined;
  const selected = selectedToken?.chainId === chainId ? selectedToken : undefined;
  const selectedRaw = selected ? snapshot?.balances.tokenBalances?.[selected.address.toLowerCase()] : undefined;
  const selectedAmount = selectedRaw !== undefined && /^\d+(\.\d+)?$/.test(selectedRaw) && Number.isFinite(Number(selectedRaw)) ? selectedRaw : undefined;
  const selectedPrice = selected && tokenPriceSnapshot?.chainId === chainId &&
    tokenPriceSnapshot.address.toLowerCase() === selected.address.toLowerCase() && displayTime - tokenPriceSnapshot.timestamp < 30000 &&
    Number.isFinite(tokenPriceSnapshot.price) && tokenPriceSnapshot.price > 0 ? tokenPriceSnapshot.price : undefined;
  const selectedUsd = selectedAmount !== undefined && Number(selectedAmount) === 0 ? 0 : selectedAmount !== undefined && selectedPrice !== undefined ? Number(selectedAmount) * selectedPrice : undefined;
  const valuation = walletAddress && walletValuation?.chainId === chainId &&
    walletValuation.ownerAddress.toLowerCase() === walletAddress.toLowerCase() ? walletValuation : undefined;
  const total = valuation?.totalUsdValue;
  const valuationFresh = useFreshTimestamp(valuation?.updatedAt, 60000);
  const valuationStale = !!valuation?.error || !!snapshot?.balances.error || !valuationFresh;
  const totalAvailable = total !== undefined && /^\d+(\.\d+)?$/.test(total) && Number.isFinite(Number(total));
  const showSelected = selected && selected.address.toLowerCase() !== token.address.toLowerCase();

  return (
    <div className="bg-surface/90 border border-surface-border rounded-xl px-3.5 py-2 flex items-center justify-between gap-3 shadow-sm min-w-0 col-span-2 lg:col-span-4 2xl:col-span-1">
      <div className="min-w-0 flex-1 flex items-center gap-4 overflow-x-auto">
        <div className="shrink-0 whitespace-nowrap">
        <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider block">{token.symbol} · {chain.shortName}</span>
        <div className="text-xs font-bold font-mono text-white" data-wallet-balance>
          {!walletAddress ? 'No wallet' : amount !== undefined ? `${formatTokenDisplay(amount)} ${token.symbol}` : 'Unavailable'}
        </div>
        {walletAddress && <div className="text-[10px] font-mono text-slate-400">
          {usd !== undefined && Number.isFinite(usd) ? `$${formatUsdDisplay(usd)} USD` : 'USD value unavailable'}
        </div>}
        </div>
        {walletAddress && showSelected && <div className="shrink-0 whitespace-nowrap" data-selected-wallet-balance>
          <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider block">{selected.symbol} balance</span>
          <span className="text-xs font-bold font-mono text-white block">
            {selectedAmount !== undefined ? `${formatTokenDisplay(selectedAmount)} ${selected.symbol}` : `${selected.symbol} unavailable`}
          </span>
          <span className="text-[10px] font-mono text-slate-400 block">
            {selectedUsd !== undefined && Number.isFinite(selectedUsd) ? `$${formatUsdDisplay(selectedUsd)} USD` : 'USD value unavailable'}
          </span>
        </div>}
        {walletAddress && <div className="shrink-0 whitespace-nowrap text-[10px]" data-wallet-total
          title={`Includes native, wrapped native, ${chain.usdtToken.symbol}, and tokens tracked on ${chain.name}.`}>
          <span className="text-slate-400 uppercase tracking-wider block">Wallet total</span>
          <span className="text-xs font-bold font-mono text-theme-primary block">{totalAvailable ? `$${formatUsdDisplay(total)} USD` : 'Unavailable'}</span>
          {valuationStale && <span className="text-amber-300 block" title={valuation?.error}>
            {totalAvailable ? 'Last known · stale' : 'Value unavailable'} · <button type="button" className="underline" onClick={onRefreshBalances}>Retry</button>
          </span>}
        </div>}
      </div>
      {createPortal(<div ref={panelRef} id={panelId} role="region" aria-label="Wallet and manual trade" tabIndex={-1}
        hidden={!visible}
        style={{ ...position, display: visible ? 'block' : 'none' }}
        className="wallet-trade-dropdown fixed z-[150] overflow-y-auto overscroll-contain rounded-xl border border-slate-600 bg-surface shadow-2xl outline-none">
        {children}
      </div>, document.body)}
    </div>
  );
};
