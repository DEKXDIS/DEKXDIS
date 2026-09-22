// Per-network budgets shared by all CoW callers in this app instance.
type Bucket = { tail: Promise<void>; next: number; blockedUntil: number };
const buckets = new Map<string, Bucket>();
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function cowFetch(url: string, options: RequestInit & { timeoutMs?: number; retryLimit?: number } = {}): Promise<Response> {
  const method = options.method || 'GET';
  const network = url.split('/api/')[0];
  const category = method === 'GET' ? 'read' : url.endsWith('/quote') ? 'quote' : method;
  // Conservative spacing: reads <100/min, quotes <10/s, writes <5/s.
  const spacing = category === 'read' ? 650 : category === 'quote' ? 125 : 250;
  const key = `${network}:${category}`;
  let bucket = buckets.get(key);
  if (!bucket) { bucket = { tail: Promise.resolve(), next: 0, blockedUntil: 0 }; buckets.set(key, bucket); }
  const { timeoutMs = 12000, retryLimit = 2, ...init } = options;
  for (let attempt = 0; ; attempt++) {
    const turn = bucket.tail.then(async () => {
      while (Date.now() < Math.max(bucket.next, bucket.blockedUntil)) {
        const delay = Math.max(bucket.next, bucket.blockedUntil) - Date.now();
        if (delay > 30000) throw Object.assign(new Error(`CoW server cooldown exceeds the 30-second retry cap (${Math.ceil(delay / 1000)} seconds remaining)`), { retryAfterMs: delay });
        await sleep(delay);
      }
      bucket.next = Date.now() + spacing;
    });
    bucket.tail = turn.catch(() => {});
    await turn;
    // Queue time must not consume the network timeout.
    if (init.signal?.aborted) throw new Error('CoW request aborted before dispatch');
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    if (response.status !== 429) return response;
    const header = response.headers.get('Retry-After');
    const seconds = header === null ? NaN : Number(header);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : NaN;
    const backoff = Math.min(30000, 1000 * 2 ** attempt + Math.random() * 250);
    bucket.blockedUntil = Math.max(bucket.blockedUntil, Date.now() + Math.max(backoff, Number.isFinite(delay) ? delay : 0));
    if (attempt >= retryLimit || delay > 30000) return response;
    await response.body?.cancel();
  }
}

export class OrderStatusQueryError extends Error {
  constructor(message: string, public readonly statusCode?: number, public readonly retryAfterMs?: number) { super(message); }
}

// Recognize warnings persisted by older versions, without masking protection failures.
export function isLegacyStatusWarning(message?: string): boolean {
  return !!message && /^(Error: )?(Network error querying status for order |CoW API HTTP \d+ when querying status for order )/.test(message);
}

const quotes = new Map<string, { expires: number; promise: Promise<any> }>();
export function sharedQuote<T>(key: string, fetchQuote: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [id, entry] of quotes) if (entry.expires <= now) quotes.delete(id);
  const existing = quotes.get(key);
  if (existing) return existing.promise;
  const entry = { expires: Infinity, promise: Promise.resolve().then(fetchQuote) };
  quotes.set(key, entry);
  void entry.promise.then(() => { entry.expires = Date.now() + 15000; }, () => { if (quotes.get(key) === entry) quotes.delete(key); });
  return entry.promise;
}
