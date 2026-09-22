import { ethers } from 'ethers';
export function assertDecimals(decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Verified token decimals required');
}
export function quantityForUsd(usd: string, price: number, decimals: number): string {
  assertDecimals(decimals);
  if (!Number.isFinite(price) || price <= 0) throw new Error('A fresh positive token price is required');
  const priceUnits = ethers.parseUnits(price.toFixed(18), 18);
  if (priceUnits <= 0n) throw new Error('Price is below supported precision');
  const dollars = ethers.parseUnits(usd, 18);
  const amount = dollars * 10n ** BigInt(decimals) / priceUnits;
  if (amount <= 0n) throw new Error('Order amount must be positive and at least one token base unit');
  return ethers.formatUnits(amount, decimals);
}

/**
 * Returns a whole-cent USD amount that stays below the exact balance value by
 * at least `bufferUsd`. Balance arithmetic remains in integer base units.
 */
export function bufferedMaxUsd(
  balances: string[],
  price: number,
  decimals: number,
  bufferUsd: string = '0.05'
): string {
  assertDecimals(decimals);
  if (!Number.isFinite(price) || price <= 0) throw new Error('A fresh positive token price is required');

  const balanceUnits = balances.reduce(
    (total, balance) => total + ethers.parseUnits(balance || '0', decimals),
    0n
  );
  const priceUnits = ethers.parseUnits(price.toFixed(18), 18);
  const grossUsdUnits = balanceUnits * priceUnits / 10n ** BigInt(decimals);
  const bufferUsdUnits = ethers.parseUnits(bufferUsd, 18);
  if (grossUsdUnits <= bufferUsdUnits) return '0.00';

  // Floor to cents. Never round a MAX amount upward toward the wallet balance.
  const wholeCents = (grossUsdUnits - bufferUsdUnits) / 10n ** 16n;
  return ethers.formatUnits(wholeCents, 2);
}

export function quoteForQuantity(quantity: string, price: number, decimals: number, quoteDecimals: number): string {
  assertDecimals(decimals); assertDecimals(quoteDecimals);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid exit price');
  const units = ethers.parseUnits(quantity, decimals) * ethers.parseUnits(price.toFixed(18), 18) * 10n ** BigInt(quoteDecimals) / (10n ** BigInt(decimals) * 10n ** 18n);
  if (units <= 0n) throw new Error('Exit amount rounds to zero');
  return ethers.formatUnits(units, quoteDecimals);
}

/** Convert a USD target and exact base quantity into actual receive-token units. */
export function quoteForQuantityUsd(quantity: string, targetUsd: number, quoteUsd: number, decimals: number, quoteDecimals: number): string {
  assertDecimals(decimals); assertDecimals(quoteDecimals);
  if (!Number.isFinite(targetUsd) || targetUsd <= 0 || !Number.isFinite(quoteUsd) || quoteUsd <= 0) throw new Error('Fresh positive USD prices required');
  const target = ethers.parseUnits(targetUsd.toFixed(18), 18);
  const rate = ethers.parseUnits(quoteUsd.toFixed(18), 18);
  if (rate <= 0n) throw new Error('USD conversion below supported precision');
  const numerator = ethers.parseUnits(quantity, decimals) * target * 10n ** BigInt(quoteDecimals);
  const denominator = 10n ** BigInt(decimals) * rate;
  // Minimum received rounds up so token precision cannot weaken the requested limit.
  const units = (numerator + denominator - 1n) / denominator;
  if (units <= 0n) throw new Error('Exit amount rounds to zero');
  return ethers.formatUnits(units, quoteDecimals);
}
