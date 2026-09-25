import { useEffect, useState } from 'react';

/** Re-render at expiry even when a failed feed stops publishing new values. */
export function useFreshTimestamp(timestamp: number | undefined, maxAgeMs = 30000): boolean {
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!timestamp) return;
    const remaining = timestamp + maxAgeMs - Date.now();
    if (remaining < 0) return;
    const timer = setTimeout(() => refresh(value => value + 1), remaining + 1);
    return () => clearTimeout(timer);
  }, [timestamp, maxAgeMs]);
  return !!timestamp && Date.now() - timestamp < maxAgeMs;
}
