import { systemLogService } from './systemLogService';

export function sendErrorText(error: unknown): string {
  const value = error as { shortMessage?: string; message?: string } | null;
  return String(value?.shortMessage || value?.message || error).replace(/0x[0-9a-f]{128,}/gi, '[signed data omitted]');
}

export function sendRetryInfo(error: unknown): { retryable: boolean; delay: number } {
  const e = error as any;
  const status = Number(e?.response?.statusCode ?? e?.response?.status ?? e?.status);
  const headers = e?.response?.headers;
  const header = headers?.get?.('retry-after') ?? headers?.['retry-after'];
  const delay = header == null ? 0 : Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  const code = e?.code;
  return { delay: Math.max(0, delay || 0), retryable: status === 408 || status === 429 || status >= 500 ||
    ['NETWORK_ERROR', 'TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(code) ||
    e?.name === 'TimeoutError' || e?.name === 'AbortError' || (e instanceof TypeError && /fetch|network/i.test(e.message)) };
}

type State = { pending?: Promise<unknown>; terminal?: Error; failures: number; reported: boolean };
const states = new Map<string, State>();
const nextRequest = new Map<number, number>();
export function rememberSendCooldown(chainId: number, error: unknown) {
  const { delay } = sendRetryInfo(error);
  if (delay > 0) nextRequest.set(chainId, Math.max(nextRequest.get(chainId) || 0, Date.now() + delay));
}
export function assertSendRpcReady(chainId: number) {
  const remaining = (nextRequest.get(chainId) || 0) - Date.now();
  if (remaining > 0) throw new Error(`Transfer RPC is cooling down; try again in ${Math.ceil(remaining / 1000)} seconds`);
}
const queues = new Map<number, Promise<unknown>>();
const reported = new WeakSet<Error>();
export const sendFailureReported = (error: unknown) => error instanceof Error && reported.has(error);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Single shared read lane per chain; coalesce identical work and retain exhausted budgets across remounts. */
export function sendRead<T>(key: string, chainId: number, load: () => Promise<T>, manual = false): Promise<T> {
  const scoped = `${chainId}:${key}`;
  let state = states.get(scoped);
  if (state?.pending) return state.pending as Promise<T>;
  if (state?.terminal && !manual) return Promise.reject(state.terminal);
  if (!state) { state = { failures: 0, reported: false }; states.set(scoped, state); }
  const current = state;
  current.terminal = undefined;
  const run = async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const wait = Math.max(0, (nextRequest.get(chainId) || 0) - Date.now());
        if (wait > 30000) throw new Error('RPC cooldown exceeds 30 seconds; try again after the server cooldown');
        if (wait) await sleep(wait);
        const result = await load();
        if (current.reported) systemLogService.logSuccess('WALLET', 'Asset transfer connection recovered',
          `${key}; recovered after ${current.failures} failures`, undefined, undefined, chainId);
        current.failures = 0; current.reported = false;
        return result;
      } catch (error) {
        current.failures++;
        const failure = new Error(sendErrorText(error));
        const retry = sendRetryInfo(error);
        const delay = Math.max(Math.min(30000, 2000 * 2 ** attempt), retry.delay);
        if (retry.retryable) nextRequest.set(chainId, Date.now() + delay);
        const details = `${key}; attempt ${attempt + 1}/6; consecutive failures ${current.failures}: ${failure.message}`;
        if (!retry.retryable || attempt === 5 || delay > 30000) {
          current.terminal = failure; current.reported = true; reported.add(failure);
          systemLogService.logError('WALLET', 'Asset transfer request failed', details + (delay > 30000 ? '; server cooldown exceeds 30 seconds; no early retry sent' : ''), chainId);
          throw failure;
        }
        if (delay === 30000) {
          current.reported = true;
          systemLogService.logError('WALLET', 'Repeated asset transfer request failure', `${details}; next attempt in 30 seconds`, chainId);
        } else console.warn(`[Asset send] ${details}; retry in ${delay} ms`);
      }
    }
    throw new Error('Asset transfer retry budget exhausted');
  };
  const queued = (queues.get(chainId) || Promise.resolve()).then(run, run);
  queues.set(chainId, queued.then(() => undefined, () => undefined));
  current.pending = queued.finally(() => { current.pending = undefined; if (!current.terminal) states.delete(scoped); });
  return current.pending as Promise<T>;
}
