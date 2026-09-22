type QueueOptions = { maxCooldownMs?: number; rateLimitDelayMs?: number };
type Job = QueueOptions & { run: () => Promise<Response>; resolve: (response: Response) => void; reject: (error: unknown) => void };

export class MarketCooldownError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Market data provider cooldown exceeds the 30-second retry cap (${Math.ceil(retryAfterMs / 1000)} seconds remaining)`);
  }
}

/** A shared FIFO dispatch queue for each provider, with at most two requests in flight. */
export class MarketRequestBatch {
  private jobs: Job[] = [];
  private active = 0;
  private next = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private spacing: number) {}
  enqueue(run: () => Promise<Response>, options: QueueOptions = {}): Promise<Response> {
    return new Promise((resolve, reject) => { this.jobs.push({ run, resolve, reject, ...options }); this.pump(); });
  }
  private pump() {
    // A caller with a finite retry budget must not silently wait through a long
    // provider ban caused by another chart/window. Leave that cooldown intact.
    const remaining = this.next - Date.now();
    this.jobs = this.jobs.filter(job => {
      if (job.maxCooldownMs !== undefined && remaining > job.maxCooldownMs) {
        job.reject(new MarketCooldownError(remaining));
        return false;
      }
      return true;
    });
    if (!this.jobs.length && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.timer || this.active >= 2 || !this.jobs.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const job = this.jobs.shift()!;
      this.next = Date.now() + this.spacing;
      this.active++;
      void job.run().then(response => {
        if (response.status === 429 || response.status === 418) {
          const header = response.headers.get('Retry-After');
          const fallback = job.rateLimitDelayMs ?? 60000;
          const delay = header && Number.isFinite(Number(header)) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : fallback;
          this.next = Math.max(this.next, Date.now() + Math.max(Number.isFinite(delay) ? delay : fallback, this.spacing));
          if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        }
        job.resolve(response);
      }, job.reject).finally(() => { this.active--; this.pump(); });
      this.pump();
    }, Math.max(0, this.next - Date.now()));
  }
}

const providers = new Map<string, MarketRequestBatch>();
const reads = new Map<string, { expires: number; receivedAt?: number; promise: Promise<Response> }>();

/** Coalesce identical chart/ladder requests and pace the combined provider batch. */
export async function marketFetch(url: string, options: QueueOptions & { maxAgeMs?: number } = {}): Promise<Response> {
  const now = Date.now();
  for (const [key, entry] of reads) if (entry.expires <= now) reads.delete(key);
  let entry = reads.get(url);
  if (entry?.receivedAt !== undefined && now - entry.receivedAt >= (options.maxAgeMs ?? 4000)) entry = undefined;
  if (!entry) {
    const host = new URL(url).hostname;
    const provider = host.endsWith('binance.com') ? 'binance' : host;
    let queue = providers.get(provider);
    if (!queue) {
      // GeckoTerminal public API: 30/minute. Binance requests share a modest 4/s budget.
      queue = new MarketRequestBatch(host === 'api.geckoterminal.com' ? 2100 : 250);
      providers.set(provider, queue);
    }
    const promise = queue.enqueue(() => fetch(url, { signal: AbortSignal.timeout(12000) }), options);
    entry = { expires: Infinity, promise };
    const created = entry;
    reads.set(url, entry);
    void promise.then(response => {
      if (response.ok) { created.receivedAt = Date.now(); created.expires = created.receivedAt + 4000; }
      else if (reads.get(url) === created) reads.delete(url);
    }, () => { if (reads.get(url) === created) reads.delete(url); });
  }
  // Every consumer owns its response body, including concurrent chart and ladder callers.
  return (await entry.promise).clone();
}
