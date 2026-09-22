const USD_SYMBOLS = new Set(['USD', 'USDT', 'USDC', 'USDS', 'DAI', 'BUSD', 'FDUSD']);

function plainDecimal(value: string | number): { sign: string; integer: string; fraction: string } | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;

  const sign = numeric < 0 ? '-' : '';
  const absolute = Math.abs(numeric);
  const raw = absolute.toString().includes('e')
    ? absolute.toFixed(20).replace(/0+$/, '').replace(/\.$/, '')
    : absolute.toString();
  const [integer = '0', fraction = ''] = raw.split('.');
  return { sign, integer, fraction };
}

export function isUsdDisplaySymbol(symbol?: string): boolean {
  return USD_SYMBOLS.has((symbol || '').toUpperCase());
}

export function formatUsdDisplay(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : '0.00';
}

/** Display only: truncate to four decimals, starting after leading fractional zeros. */
export function formatTokenDisplay(value: string | number): string {
  const decimal = plainDecimal(value);
  if (!decimal) return '0.0000';
  const { sign, integer, fraction } = decimal;
  if (Number(integer) !== 0) return `${sign}${integer}.${fraction.padEnd(4, '0').slice(0, 4)}`;

  const firstSignificant = fraction.search(/[1-9]/);
  if (firstSignificant < 0) return '0.0000';
  const displayedDecimals = Math.min(20, firstSignificant + 4);
  return `${sign}0.${fraction.padEnd(displayedDecimals, '0').slice(0, displayedDecimals)}`;
}

export function formatAssetDisplay(value: string | number, symbol?: string): string {
  return isUsdDisplaySymbol(symbol) ? formatUsdDisplay(value) : formatTokenDisplay(value);
}
