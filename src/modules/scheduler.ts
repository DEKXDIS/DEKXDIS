import { TIMEFRAMES, type ModuleEvent, type ModuleManifest } from './contracts';
import type { ModuleRun } from './stateStore';

/** Deterministic event ids make repeated timers and React remounts harmless. */
export function scheduledEvents(run: ModuleRun, manifest: ModuleManifest, now: number): ModuleEvent[] {
  const events: ModuleEvent[] = [];
  for (const [index, subscription] of manifest.eventSubscriptions.entries()) {
    if (subscription.type === 'order') continue;
    const ms = subscription.type === 'candle-close' ? TIMEFRAMES[subscription.timeframe] * 1000 : subscription.intervalMs;
    if (!Number.isFinite(ms) || ms < 6000) throw new Error('Invalid module scheduler interval');
    const boundary = Math.floor(now / ms) * ms;
    if (subscription.type === 'candle-close' && now - boundary < 2000) continue;
    const id = `${subscription.type}:${index}:${boundary}`;
    if (!run.events.includes(id)) events.push({ id, type: subscription.type, time: boundary,
      data: subscription.type === 'candle-close' ? { timeframe: subscription.timeframe, closedAt: boundary } : undefined });
  }
  for (const scheduled of run.scheduled) if (scheduled.time <= now && !run.events.includes(`scheduled:${scheduled.id}`)) {
    events.push({ id: `scheduled:${scheduled.id}`, type: 'timer', time: scheduled.time, name: scheduled.name });
  }
  return events;
}
