import { marketFetch, MarketCooldownError } from './marketRequests';
import { systemLogService } from './systemLogService';

type AttemptOptions = { maxAgeMs: number; maxCooldownMs: number; rateLimitDelayMs: number };
type HistoryRequest = { pending?: Promise<unknown>; terminal?: Error; reported: boolean; failures: number };
const requests = new Map<string, HistoryRequest>();
const reportedFailures = new WeakSet<Error>();
const MAX_ATTEMPTS = 6;

export const isReportedCandleFailure = (error: unknown): boolean => error instanceof Error && reportedFailures.has(error);

class CandleResponseError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs: number) { super(message); }
}

export async function candleJson(url: string, options: AttemptOptions): Promise<any> {
  const response = await marketFetch(url, options);
  if (!response.ok) {
    const header = response.headers.get('Retry-After');
    const seconds = header === null ? NaN : Number(header);
    const retryAfter = Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() || 0 : 0);
    throw new CandleResponseError(`Chart history request failed: HTTP ${response.status} ${response.statusText} (${url})`,
      response.status === 408 || response.status === 429 || response.status >= 500, retryAfter);
  }
  return response.json();
}

/** Share the entire retry sequence, not just each HTTP attempt. Polling cannot restart an exhausted sequence. */
export function requestCandleHistory<T>(key: string, description: string, chainId: number,
  load: (options: AttemptOptions) => Promise<T>, forceRefresh = false): Promise<T> {
  let state = requests.get(key);
  if (state?.pending) return state.pending as Promise<T>;
  if (state?.terminal && !forceRefresh) return Promise.reject(state.terminal);
  if (!state) { state = { reported: false, failures: 0 }; requests.set(key, state); }
  state.terminal = undefined;
  const current = state;
  const work = async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const backoff = Math.min(30000, 2000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
      try {
        const result = await load({ maxAgeMs: attempt > 1 || forceRefresh ? 0 : 4000, maxCooldownMs: 30000, rateLimitDelayMs: backoff });
        if (current.reported) systemLogService.logSuccess('MARKET_DATA', `Chart history recovered: ${description}`,
          `Loaded on attempt ${attempt}/${MAX_ATTEMPTS} after ${current.failures} consecutive failures.`, undefined, undefined, chainId);
        current.failures = 0; current.reported = false;
        return result;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        current.failures++;
        const retryable = error instanceof CandleResponseError ? error.retryable :
          error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name));
        const serverDelay = error instanceof CandleResponseError || error instanceof MarketCooldownError ? error.retryAfterMs : 0;
        const delay = Math.max(backoff, serverDelay);
        const details = `Attempt ${attempt}/${MAX_ATTEMPTS}: ${failure.message}`;
        if (!retryable || attempt === MAX_ATTEMPTS || serverDelay > 30000) {
          current.terminal = failure; current.reported = true;
          reportedFailures.add(failure);
          systemLogService.logError('MARKET_DATA', `Chart history download stopped: ${description}`,
            `${details}\n${serverDelay > 30000 ? 'Provider cooldown exceeds 30 seconds; no early retry was sent. ' : ''}Use Retry on the chart, or resume the stopped strategy, to start another attempt sequence.`, chainId);
          throw failure;
        }
        if (delay === 30000 && !current.reported) {
          current.reported = true;
          systemLogService.logError('MARKET_DATA', `Repeated chart history failure: ${description}`, `${details}\nRetrying in 30 seconds.`, chainId);
        } else console.warn(`[Chart history: ${description}] ${details}; retrying in ${delay} ms`);
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Chart history retry sequence ended unexpectedly');
  };
  current.pending = work().finally(() => {
    current.pending = undefined;
    // Successful operations do not leave an unbounded catalogue of tokens in memory.
    if (!current.terminal) requests.delete(key);
  });
  return current.pending as Promise<T>;
}
