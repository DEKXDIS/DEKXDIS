import { marketFetch, MarketCooldownError } from './marketRequests';
import { systemLogService } from './systemLogService';

const URL = 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list';
const MAX_ATTEMPTS = 6;
let terminalError: Error | undefined;
let reported = false;

class AlphaResponseError extends Error {
  constructor(message: string, readonly retryable = false, readonly retryAfterMs = 0) { super(message); }
}

// marketDataService shares one promise for the entire download and cache update.
// Keep an exhausted sequence stopped until an explicit refresh or app restart.
export async function fetchAlphaTokenList(forceRefresh: boolean): Promise<any[]> {
  if (terminalError && !forceRefresh) throw terminalError;
  terminalError = undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const backoff = Math.min(30000, 2000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    try {
      const response = await marketFetch(URL, { maxAgeMs: 0, maxCooldownMs: 30000, rateLimitDelayMs: backoff });
      if (!response.ok) {
        const header = response.headers.get('Retry-After');
        const seconds = header === null ? NaN : Number(header);
        const retryAfterMs = Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() || 0 : 0);
        throw new AlphaResponseError(`Binance Alpha token list: HTTP ${response.status} ${response.statusText}`,
          response.status === 408 || response.status === 429 || response.status >= 500, retryAfterMs);
      }
      const json = await response.json();
      if (!json?.success || !Array.isArray(json.data)) throw new AlphaResponseError('Invalid response format from Binance Alpha token list API');
      if (json.data.some((item: any) => !item || typeof item !== 'object' ||
          (item.contractAddress && typeof item.contractAddress !== 'string') ||
          (item.symbol && typeof item.symbol !== 'string') || (item.name && typeof item.name !== 'string'))) {
        throw new AlphaResponseError('Invalid token metadata in Binance Alpha token list');
      }
      if (reported) systemLogService.logSuccess('MARKET_DATA', 'Binance Alpha token list recovered',
        `Downloaded ${json.data.length} tokens on attempt ${attempt}/${MAX_ATTEMPTS}.`);
      reported = false;
      return json.data;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const retryable = error instanceof AlphaResponseError ? error.retryable :
        error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name));
      const serverDelay = error instanceof AlphaResponseError || error instanceof MarketCooldownError ? error.retryAfterMs : 0;
      const delay = Math.max(backoff, serverDelay);
      const stopped = !retryable || attempt === MAX_ATTEMPTS || serverDelay > 30000;
      const details = `Attempt ${attempt}/${MAX_ATTEMPTS}: ${failure.message}`;
      if (stopped) {
        terminalError = failure;
        reported = true;
        systemLogService.logError('MARKET_DATA', 'Binance Alpha token list download stopped',
          `${details}\n${serverDelay > 30000 ? 'Provider cooldown exceeds 30 seconds; no early retry was sent. ' : ''}Restart the application to retry the download.`);
        throw failure;
      }
      if (delay === 30000 && !reported) {
        reported = true;
        systemLogService.logError('MARKET_DATA', 'Repeated Binance Alpha token list failure', `${details}\nRetrying in 30 seconds.`);
      } else console.warn(`[Binance Alpha token list] ${details}; retrying in ${delay} ms`);
      await new Promise<void>(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Binance Alpha retry sequence ended unexpectedly');
}

