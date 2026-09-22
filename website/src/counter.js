const DAY = 86400000;
const STATS_URL = 'https://haven-update-check-production.up.railway.app/stats';

export function validateDailyStats(data) {
  const start = Date.parse(data?.periodStart);
  const end = Date.parse(data?.periodEnd);
  const next = Date.parse(data?.nextUpdateAt);
  if (data?.startingCount !== 1000 || data.timeZone !== 'UTC'
      || !Number.isSafeInteger(data.dailyChecks) || data.dailyChecks < 0
      || !Number.isSafeInteger(data.total) || data.total !== 1000 + data.dailyChecks
      || !Number.isFinite(start) || end - start !== DAY || next - end !== DAY
      || start % DAY !== 0) throw new Error('Invalid daily counter response');
  return data;
}

export async function fetchDailyStats(fetcher = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let retryable = true;
    let delay = 2000 * 2 ** attempt;
    try {
      const response = await fetcher(STATS_URL, {
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) {
          const cooldown = /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
          if (!Number.isFinite(cooldown) || cooldown > 30000) retryable = false;
          else delay = Math.max(delay, cooldown);
        }
        throw new Error(`Counter HTTP ${response.status}`);
      }
      retryable = false;
      return validateDailyStats(await response.json());
    } catch (error) {
      if (!retryable || attempt === 2) throw error;
      await wait(delay);
    }
  }
}

export function mountDailyCounter(number, period, {
  load = fetchDailyStats, now = Date.now, schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  let timer;
  let inFlight;
  let nextUpdate = 0;
  function refresh() {
    if (inFlight) return inFlight;
    cancel(timer);
    inFlight = load().then(data => {
      number.textContent = data.total.toLocaleString('en-US');
      period.textContent = `${data.periodStart.slice(0, 10)} · UTC`;
      nextUpdate = Date.parse(data.nextUpdateAt);
      timer = schedule(refresh, Math.max(1000, Math.min(DAY, nextUpdate - now() + 1000)));
    }).catch(error => {
      number.textContent = 'Unavailable';
      period.textContent = 'Counter unavailable';
      nextUpdate = 0;
      console.error('DEKXDIS daily counter failed:', error);
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }
  return { refresh, refreshIfDue: () => { if (now() >= nextUpdate) return refresh(); } };
}

if (typeof document !== 'undefined') {
  const number = document.getElementById('checkin-count');
  const period = document.querySelector('[data-counter-period]');
  if (number && period) {
    const counter = mountDailyCounter(number, period);
    void counter.refresh();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void counter.refreshIfDue();
    });
    window.addEventListener('pageshow', () => { void counter.refreshIfDue(); });
  }
}
