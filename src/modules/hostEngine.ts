import { CAPABILITIES, type InstalledModule, type Json, type ModuleContext, type ModuleEvent, type ModuleOutput, type ModuleRequest } from './contracts';
import { resultEvent, type ModuleEffect, type ModuleRun } from './stateStore';

export interface HostDependencies {
  get(runId: string): ModuleRun | undefined;
  update(run: ModuleRun, mutate: (current: ModuleRun) => void): Promise<void>;
  installed(moduleId: string): InstalledModule | undefined;
  current(run: ModuleRun): boolean;
  invoke(run: ModuleRun, event: ModuleEvent, context: ModuleContext): Promise<ModuleOutput>;
  dispatch(run: ModuleRun, request: ModuleRequest): Promise<Json>;
  report(run: ModuleRun, message: string): void;
  now(): number;
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
/**
 * How much answered history to keep.
 *
 * A stored result is the whole answer — an order list for this run, or a full model exchange — and
 * keeping every one of them for the life of a run grew a run's saved state past three megabytes in
 * a day of one-minute cycles, and the file holding it past ten. They exist so a request interrupted
 * by the program closing can be replayed, so only recent ones are ever read back.
 *
 * A window is kept rather than a bare count because these records are also how a repeated request
 * is recognised as the same one: dropping them too eagerly makes a module that re-sends an id with
 * different content look like it changed a committed intent.
 */
const KEEP_ANSWERED = 32;
const KEEP_ANSWERED_MS = 10 * 60 * 1000;
/** How long a dispatch interrupted mid-flight is remembered before it stops needing review. */
const AMBIGUOUS_MS = 24 * 60 * 60 * 1000;
function prune(effects: Record<string, ModuleEffect>, now: number) {
  const finished = Object.values(effects)
    .filter(effect => effect.status === 'applied' || effect.status === 'ambiguous');
  const stale = finished.filter(effect => effect.status === 'ambiguous' && now - effect.createdAt > AMBIGUOUS_MS);
  const rest = finished.filter(effect => !stale.includes(effect))
    .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt));
  const drop = rest.filter((effect, index) =>
    index >= KEEP_ANSWERED && now - (effect.completedAt ?? effect.createdAt) > KEEP_ANSWERED_MS);
  for (const effect of [...stale, ...drop]) delete effects[effect.request.id];
}
function byteLength(value: unknown) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Module returned a non-JSON state');
  return new TextEncoder().encode(json).length;
}
export function validateModuleOutput(output: ModuleOutput, module: InstalledModule, run: ModuleRun) {
  if (!output || !('nextState' in output) || !Array.isArray(output.requests) || output.requests.length > 16) throw new Error('Module returned invalid state or requests');
  if (byteLength(output.nextState) > Math.min(262144, module.manifest.resourceRequirements.maxStateBytes)) throw new Error('Module state limit exceeded');
  if (byteLength({ requests: output.requests, view: output.view }) > 65536) throw new Error('Module control output limit exceeded');
  const ids = new Set<string>();
  for (const request of output.requests) {
    if (!request || !idPattern.test(request.id) || ids.has(request.id) || !CAPABILITIES.includes(request.capability) ||
      !module.manifest.requestedCapabilities.includes(request.capability) || !request.input || Array.isArray(request.input) || typeof request.input !== 'object') throw new Error('Module requested an invalid or undeclared capability');
    ids.add(request.id);
    const prior = has(run.effects, request.id) ? run.effects[request.id] : undefined;
    if (prior && JSON.stringify(prior.request) !== JSON.stringify(request)) throw new Error('Module changed a previously committed intent');
    if (request.capability === 'orders.limit-entry.v1' || request.capability === 'orders.limit-exit.v1') {
      if (request.input.protection && !module.manifest.requestedCapabilities.includes('orders.protection.v1')) throw new Error('Module has not declared order protection');
    }
  }
  if (output.view) for (const key of Object.keys(output.view)) {
    if (!module.manifest.viewSchema.fields.some(f => f.key === key)) throw new Error('Module returned an undeclared view field');
  }
}

/** Per-run event serialization. Slow capabilities never hold this queue or the trading queue. */
export class ModuleHostEngine {
  private queues = new Map<string, Promise<void>>();
  private queued = new Map<string, number>();
  private inFlight = new Map<string, Promise<void>>();
  private invalid = new Set<string>();
  private epochs = new Map<string, number>();
  constructor(private deps: HostDependencies) {}
  invalidate(runId: string) { this.invalid.add(runId); this.epochs.set(runId, (this.epochs.get(runId) ?? 0) + 1); }
  activate(runId: string) { this.invalid.delete(runId); }
  isCurrent(run: ModuleRun): boolean {
    const current = this.deps.get(run.runId), installed = this.deps.installed(run.moduleId);
    return !this.invalid.has(run.runId) && !!current && current.status === 'running' && this.deps.current(run) &&
      current.configurationRevision === run.configurationRevision && current.secretRevision === run.secretRevision &&
      !!installed && installed.status === 'installed' && installed.generation === run.generation && installed.packageHash === run.packageHash;
  }
  enqueue(runId: string, event: ModuleEvent): Promise<void> {
    const epoch = this.epochs.get(runId) ?? 0;
    if ((this.queued.get(runId) ?? 0) >= 32) return this.fail(runId, new Error('Module event queue limit exceeded'));
    this.queued.set(runId, (this.queued.get(runId) ?? 0) + 1);
    const operation = (this.queues.get(runId) ?? Promise.resolve()).catch(() => {}).then(() => {
      if ((this.epochs.get(runId) ?? 0) === epoch) return this.handle(runId, event);
    }).catch(error => { if ((this.epochs.get(runId) ?? 0) === epoch) return this.fail(runId, error); })
      .finally(() => { this.queued.set(runId, (this.queued.get(runId) ?? 1) - 1); });
    this.queues.set(runId, operation);
    const cleanup = () => { if (this.queues.get(runId) === operation) this.queues.delete(runId); };
    void operation.then(cleanup, cleanup);
    return operation;
  }
  async fail(runId: string, error: unknown) {
    const run = this.deps.get(runId);
    if (!run || !this.isCurrent(run)) return;
    this.invalidate(runId);
    const message = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f]/g, ' ').slice(0, 512);
    try { await this.deps.update(run, current => { current.status = 'error'; current.error = message; }); }
    finally { this.deps.report(run, message); }
  }
  private async handle(runId: string, event: ModuleEvent) {
    const run = this.deps.get(runId);
    if (!run || !this.isCurrent(run) || run.events.includes(event.id)) return;
    const module = this.deps.installed(run.moduleId)!;
    const now = this.deps.now();
    if (run.eventTimes.filter(time => now - time < 60000).length >= 120) throw new Error('Module event rate limit exceeded');
    const context: ModuleContext = { hostApiVersion: 1, moduleId: run.moduleId, moduleVersion: run.moduleVersion,
      runId, now, chainId: run.chainId, token: { address: run.token.address, symbol: run.token.symbol, decimals: run.token.decimals },
      configuration: run.configuration, limits: run.limits };
    const output = await this.deps.invoke(run, event, context);
    if (!this.isCurrent(run)) return;
    validateModuleOutput(output, module, run);
    await this.deps.update(run, current => {
      if (!this.isCurrent(current)) throw new Error('Module run changed before event commit');
      const requests = output.requests.filter(request => !has(current.effects, request.id));
      const times = current.requestTimes.filter(time => now - time < 60000);
      if (times.length + requests.length > run.limits.maxRequestsPerMinute) throw new Error('Module request rate limit exceeded');
      current.state = output.nextState; current.view = output.view ?? current.view;
      current.events.push(event.id); current.eventTimes = [...current.eventTimes.filter(t => now - t < 60000), now];
      // Retain recent event deduplication and the start marker without a lifetime event-count stop.
      // Durable capability/order intents are retained separately and never replayed by pruning events.
      if (current.events.length > 4096) current.events = current.events.includes('start')
        ? ['start', ...current.events.filter(id => id !== 'start').slice(-4095)] : current.events.slice(-4096);
      current.requestTimes = [...times, ...requests.map(() => now)];
      for (const request of requests) current.effects[request.id] = { request, eventId: event.id, status: 'planned', createdAt: now };
      if (event.requestId && current.effects[event.requestId]) current.effects[event.requestId].status = 'applied';
      // Answered requests are dropped here, after the strategy has been handed their results and
      // before the next ones are remembered. A request still in flight is never touched.
      prune(current.effects, now);
    });
    if (!this.isCurrent(run)) return;
    for (const request of output.requests) this.dispatch(runId, request.id);
  }
  private dispatch(runId: string, intentId: string) {
    const epoch = this.epochs.get(runId) ?? 0;
    const key = `${runId}:${intentId}`;
    if (this.inFlight.has(key)) return;
    const work = this.perform(runId, intentId).catch(error => {
      if ((this.epochs.get(runId) ?? 0) === epoch) return this.fail(runId, error);
    }).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, work);
  }
  private async perform(runId: string, intentId: string) {
    let run = this.deps.get(runId);
    if (!run || !this.isCurrent(run)) return;
    const effect = run.effects[intentId];
    if (!effect || effect.status !== 'planned') return;
    await this.deps.update(run, current => {
      if (!this.isCurrent(current)) throw new Error('Module run changed before capability dispatch');
      current.effects[intentId].status = 'dispatching';
    });
    if (!this.isCurrent(run)) return;
    let result: Json | undefined, error: string | undefined;
    try { result = await this.deps.dispatch(run, effect.request); }
    catch (failure) { error = (failure instanceof Error ? failure.message : String(failure)).replace(/[\x00-\x1f]/g, ' ').slice(0, 512); }
    if (!this.isCurrent(run)) return;
    const now = this.deps.now();
    // Freshness is about when the data was captured, not when the work started. A module that
    // waited 30 seconds for an answer would otherwise be told its own answer is 30 seconds stale
    // and be refused the order it just decided on.
    let dataTime = now;
    if (effect.request.capability === 'http.request.v1') {
      // An image sent with the request is only as fresh as the capture behind it.
      for (const attachment of (effect.request.input.attachments ?? []) as { handle: string }[]) {
        const source = Object.values(this.deps.get(runId)!.effects).find(e => e.result && typeof e.result === 'object' && !Array.isArray(e.result) && e.result.handle === attachment.handle);
        if (source) dataTime = Math.min(dataTime, source.dataTime ?? source.createdAt);
      }
    }
    await this.deps.update(run, current => {
      if (!this.isCurrent(current)) throw new Error('Module run changed before capability result commit');
      const item = current.effects[intentId]; item.status = 'result'; item.result = result; item.error = error; item.completedAt = now; item.dataTime = dataTime;
    });
    run = this.deps.get(runId)!;
    // Correlated results are replayable from the journal, never from another API call.
    void this.enqueue(runId, resultEvent(run.effects[intentId]));
  }
  async recover(runId: string) {
    const run = this.deps.get(runId);
    if (!run || !this.isCurrent(run)) return;
    for (const effect of Object.values(run.effects)) {
      if (effect.status === 'dispatching' || effect.status === 'ambiguous') {
        // Even GET providers can charge per call. Reconcile CoW through its own prepared UID journal.
        await this.deps.update(run, current => { current.effects[effect.request.id].status = 'ambiguous'; });
        await this.fail(runId, new Error('Interrupted capability dispatch needs review; it was not replayed. Existing orders continue to reconcile.'));
        return;
      }
    }
    for (const effect of Object.values(run.effects)) {
      if (effect.status === 'result') await this.enqueue(runId, resultEvent(effect));
      else if (effect.status === 'planned') this.dispatch(runId, effect.request.id);
    }
    if (!run.events.includes('start')) await this.enqueue(runId, { id: 'start', type: 'start', time: this.deps.now() });
    else await this.enqueue(runId, { id: `recovery:${this.deps.now()}`, type: 'recovery', time: this.deps.now() });
  }
  async idle(runId: string) {
    // Test/controlled shutdown helper. Pause itself never waits on slow external capabilities.
    // Result events can enqueue another capability, so drain until this run is actually idle.
    for (;;) {
      const queue = this.queues.get(runId);
      const effects = [...this.inFlight].filter(([key]) => key.startsWith(`${runId}:`)).map(([, work]) => work);
      if (!queue && !effects.length) return;
      await Promise.all([queue, ...effects]);
    }
  }
}
