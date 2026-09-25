import { useEffect, useState } from 'react';
import { tradingQuoteUsdPrice } from '../services/tradingQuote';
import { useFreshTimestamp } from './useFreshTimestamp';

export function useTradingQuotePrice(chainId: number) {
  const [snapshot, setSnapshot] = useState({ chainId: 0, price: 0, error: '', time: 0 });
  useEffect(() => {
    let current = true, busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const price = await tradingQuoteUsdPrice(chainId);
        if (current) setSnapshot({ chainId, price, error: '', time: Date.now() });
      } catch (error) {
        if (current) setSnapshot({ chainId, price: 0, error: String(error), time: Date.now() });
      } finally { busy = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => { current = false; clearInterval(timer); };
  }, [chainId]);
  const fresh = useFreshTimestamp(snapshot.time);
  return snapshot.chainId === chainId && fresh
    ? snapshot : { price: 0, error: 'Waiting for wrapped native USD price' };
}
