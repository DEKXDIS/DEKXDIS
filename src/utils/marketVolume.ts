/** Prefer dollar quote volume; estimate from token volume at the current price otherwise. */
export function volume24hUsd(quoteVolume: unknown, tokenVolume: unknown, price: number): number {
  const parseVolume = (value: unknown): number => {
    if (typeof value !== 'number' && typeof value !== 'string') return NaN;
    if (typeof value === 'string' && !value.trim()) return NaN;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN;
  };
  const quoted = parseVolume(quoteVolume);
  if (Number.isFinite(quoted)) return quoted;
  const tokens = parseVolume(tokenVolume);
  const estimated = tokens * price;
  return Number.isFinite(tokens) && Number.isFinite(estimated) && price > 0 ? estimated : NaN;
}
