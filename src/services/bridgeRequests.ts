import { systemLogService } from './systemLogService';

export class BridgeRequestError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs = 0, readonly httpStatus?: number) { super(message); }
}

const cooldowns = new Map<string, number>();
export async function bridgeFetch(input: RequestInfo | URL, init: RequestInit = {}, transport: typeof fetch = fetch): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const remaining = (cooldowns.get(url.origin) || 0) - Date.now();
  if (remaining > 0) throw new BridgeRequestError(`${url.hostname} is cooling down for ${Math.ceil(remaining / 1000)} seconds`, true, remaining);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 15000);
  try {
    const response = await transport(input, { ...init, signal: controller.signal });
    // Read the body inside the timeout too, so an incomplete HTTP response cannot stall the SDK queue.
    const body = await response.text();
    if (!response.ok) {
      const header = response.headers.get('Retry-After');
      const numeric = header == null ? NaN : Number(header);
      const delay = Math.max(0, Number.isFinite(numeric) ? numeric * 1000 : header ? Date.parse(header) - Date.now() || 0 : 0);
      if (delay) cooldowns.set(url.origin, Date.now() + delay);
      throw new BridgeRequestError(`${url.hostname} HTTP ${response.status}: ${body.slice(0, 1500)}`, response.status === 408 || response.status === 429 || response.status >= 500, delay, response.status);
    }
    return new Response(response.status === 204 ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    if (error instanceof BridgeRequestError) throw error;
    throw new BridgeRequestError(`${url.hostname}: ${String(error)}`, true, Number((error as { retryAfterMs?: number })?.retryAfterMs) || 0);
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

// The pinned SDK's provider clients do not expose a fetch/timeout option. Limit only their
// endpoints; RPCs, ordinary CoW trading, and all other application requests keep their transport.
const sdkHosts = new Set(['app.across.to', 'across.to', 'public-backend.bungee.exchange', 'microservices.socket.tech', 'files.cow.fi', '1click.chaindefuser.com']);
export function installBridgeRequestTimeouts() {
  const current = globalThis.fetch as typeof fetch & { dekxdisBridgeTimeouts?: boolean };
  if (current.dekxdisBridgeTimeouts) return;
  const wrapped: typeof current = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return sdkHosts.has(url.hostname) ? bridgeFetch(input, init, current) : current(input, init);
  };
  wrapped.dekxdisBridgeTimeouts = true;
  globalThis.fetch = wrapped;
}

export interface BridgeRetryState { failures?: number; nextCheckAt?: number; trackingStopped?: boolean; trackingReported?: boolean }
export function bridgeRetryFailure(state: BridgeRetryState, error: unknown, identity: string, chainId: number): BridgeRetryState {
  const failures = (state.failures || 0) + 1;
  const retryable = error instanceof BridgeRequestError ? error.retryable : !/invalid|mismatch|unsupported|unknown bridge provider/i.test(String(error));
  const serverDelay = error instanceof BridgeRequestError ? error.retryAfterMs : 0;
  const delay = Math.min(30000, 2000 * 2 ** (failures - 1) + Math.floor(Math.random() * 250));
  const trackingStopped = !retryable || failures >= 6 || serverDelay > 30000;
  const trackingReported = state.trackingReported || trackingStopped || delay === 30000;
  if (trackingReported && (!state.trackingReported || trackingStopped)) {
    systemLogService.logError('BRIDGE', trackingStopped ? 'Transfer tracking stopped' : 'Repeated transfer tracking failure',
      `${identity}\nAttempt ${failures}: ${String(error)}\n${trackingStopped ? 'Transfer outcome remains unconfirmed. Reopen the application to retry status checks; do not resubmit the transfer.' : 'Next status check in 30 seconds.'}`, chainId);
  } else console.warn(`[Bridge status ${identity}] attempt ${failures}`, error);
  return { failures, trackingStopped, trackingReported, nextCheckAt: Date.now() + Math.max(delay, serverDelay) };
}
