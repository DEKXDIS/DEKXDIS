import { systemLogService } from './systemLogService';

export interface TokenSecurityReport {
  isOpenSource: boolean | null;
  isProxy: boolean | null;
  isMintable: boolean | null;
  isHoneypot: boolean | null;
  buyTax: number | null; // in percent, e.g. 5.0
  sellTax: number | null;
  isBlacklisted: boolean | null;
  canTakeBackOwnership: boolean | null;
  ownerChangeBalance: boolean | null;
  cannotBuy: boolean | null;
  cannotSellAll: boolean | null;
  isPausable: boolean | null;
  isAntiWhale: boolean | null;
  isTrustListed: boolean | null;
  holderCount?: number;
  ownerAddress?: string;
  riskScore: 'SAFE' | 'WARNING' | 'DANGER';
  riskReasons: string[];
  warningReasons: string[];
  safeHighlights: string[];
}

export const goPlusSecurityService = {
  /**
   * Runs an automated GoPlus Security scan on a token contract for the specified EVM chain.
   */
  async checkTokenSecurity(
    contractAddress: string,
    chainId: number
  ): Promise<TokenSecurityReport | null> {
    const cleanAddr = contractAddress.toLowerCase().trim();
    const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${cleanAddr}`;

    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!res.ok) {
        throw new Error(`GoPlus API HTTP error ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();
      if (json.code !== 1 || !json.result || !json.result[cleanAddr]) {
        systemLogService.logWarning(
          'SECURITY',
          `GoPlus Security Data Not Found`,
          `No audit report for ${contractAddress.slice(0, 10)}... (Code ${json.code})`,
          chainId
        );
        return null;
      }

      const raw = json.result[cleanAddr];
      const flag = (value: unknown): boolean | null => value === '1' || value === 1 ? true : value === '0' || value === 0 ? false : null;
      const tax = (value: unknown): number | null => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) * 100 : null;

      const isOpenSource = flag(raw.is_open_source);
      const isProxy = flag(raw.is_proxy);
      const isMintable = flag(raw.is_mintable);
      const isHoneypot = flag(raw.is_honeypot);
      const buyTax = tax(raw.buy_tax);
      const sellTax = tax(raw.sell_tax);
      const isBlacklisted = flag(raw.is_blacklisted);
      const canTakeBackOwnership = flag(raw.can_take_back_ownership);
      const ownerChangeBalance = flag(raw.owner_change_balance);
      const cannotBuy = flag(raw.cannot_buy);
      const cannotSellAll = flag(raw.cannot_sell_all);
      const isPausable = flag(raw.transfer_pausable);
      const isAntiWhale = flag(raw.is_anti_whale);
      const isTrustListed = flag(raw.trust_list);
      const holderCount = raw.holder_count ? parseInt(raw.holder_count, 10) : undefined;
      const ownerAddress = raw.owner_address || undefined;

      const riskReasons: string[] = [];
      const warningReasons: string[] = [];
      const safeHighlights: string[] = [];
      if ([isOpenSource, isProxy, isMintable, isHoneypot, buyTax, sellTax, isBlacklisted, canTakeBackOwnership, ownerChangeBalance, cannotBuy, cannotSellAll, isPausable].some(value => value === null)) warningReasons.push('Insufficient evidence: some security checks are unavailable. Unknown checks are not a clean result.');

      // Critical Dangers
      if (isHoneypot) riskReasons.push('Detected as a Honeypot (tokens cannot be sold)');
      if (cannotBuy) riskReasons.push('Buy transactions are blocked');
      if (cannotSellAll) riskReasons.push('Sell transactions are restricted');
      if (ownerChangeBalance) riskReasons.push('Contract owner can manipulate token balances');
      if (canTakeBackOwnership) riskReasons.push('Creator can reclaim contract ownership');
      if (buyTax !== null && buyTax > 15) riskReasons.push(`Extreme Buy Tax: ${buyTax.toFixed(1)}%`);
      if (sellTax !== null && sellTax > 15) riskReasons.push(`Extreme Sell Tax: ${sellTax.toFixed(1)}%`);

      // Warnings
      if (isOpenSource === false) warningReasons.push('Contract source code is unverified');
      if (isProxy) warningReasons.push('Proxy contract (code logic can be altered)');
      if (isMintable && !isTrustListed) warningReasons.push('Mintable function present (can create new tokens)');
      if (isBlacklisted) warningReasons.push('Blacklist function present');
      if (isPausable) warningReasons.push('Transfers can be paused by owner');
      if (buyTax !== null && buyTax > 5 && buyTax <= 15) warningReasons.push(`Elevated Buy Tax: ${buyTax.toFixed(1)}%`);
      if (sellTax !== null && sellTax > 5 && sellTax <= 15) warningReasons.push(`Elevated Sell Tax: ${sellTax.toFixed(1)}%`);

      // Safe highlights
      if (isHoneypot === false && cannotBuy === false && cannotSellAll === false) safeHighlights.push('No Honeypot detected');
      if (buyTax === 0 && sellTax === 0) safeHighlights.push('Zero Buy/Sell Tax (0% / 0%)');
      else if (buyTax !== null && sellTax !== null && buyTax <= 3 && sellTax <= 3) safeHighlights.push(`Low Taxes (${buyTax.toFixed(1)}% / ${sellTax.toFixed(1)}%)`);
      if (isOpenSource) safeHighlights.push('Verified Open-Source Contract');
      if (isProxy === false) safeHighlights.push('Immutable (Not a Proxy)');
      if (ownerChangeBalance === false && canTakeBackOwnership === false) safeHighlights.push('Ownership & Balances Safe');

      let riskScore: 'SAFE' | 'WARNING' | 'DANGER' = 'SAFE';
      if (riskReasons.length > 0) {
        riskScore = 'DANGER';
      } else if (warningReasons.length > 0) {
        riskScore = 'WARNING';
      }

      if (riskScore === 'DANGER') {
        systemLogService.logWarning(
          'SECURITY',
          `High-Risk Token Flagged by GoPlus`,
          `${cleanAddr.slice(0, 10)}... Reasons: ${riskReasons.join(', ')}`,
          chainId
        );
      }

      return {
        isOpenSource,
        isProxy,
        isMintable,
        isHoneypot,
        buyTax,
        sellTax,
        isBlacklisted,
        canTakeBackOwnership,
        ownerChangeBalance,
        cannotBuy,
        cannotSellAll,
        isPausable,
        isAntiWhale,
        isTrustListed,
        holderCount,
        ownerAddress,
        riskScore,
        riskReasons,
        warningReasons,
        safeHighlights,
      };
    } catch (err: any) {
      systemLogService.logWarning(
        'SECURITY',
        `GoPlus Security Audit Request Failed`,
        `Address: ${cleanAddr.slice(0, 10)}... Error: ${err?.message || err}`,
        chainId
      );
      return null;
    }
  },
};
