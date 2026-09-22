import { requireStrategiesEnabled } from '../services/strategyAvailability';
import { STRATEGIES_ENABLED } from '../config/releaseFeatures';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { nativeStore } from '../services/nativeStore';
import { storageService } from '../services/storageService';
import { exclusive } from '../services/executionEngine';
import { systemLogService } from '../services/systemLogService';
import type { TokenConfig, TradeOrder, WalletState } from '../types/trading';
import { moduleRegistry } from './registry';
import { moduleStateStore, type ModuleRun } from './stateStore';
import { ModuleHostEngine, validateModuleOutput } from './hostEngine';
import { scheduledEvents } from './scheduler';
import { validateConfiguration, validateLimits, draftToLimits, type ChartInput, type HttpInput, type Json, type LimitDraft, type ModuleIdentity,
  type ModuleOutput, type ModuleRequest, type NativeScope, type RunLimits } from './contracts';
import { moduleCandles, modulePrice } from './capabilities/market';
import { executeLimitEntry, executeLimitExit, cancelModuleOrder, observeModuleFunding, ModuleFundingError, ModulePositionChangedError, refreshModuleOrders, observeModuleOrders as observeOrders, recoverModuleOrderIntents, type ModuleLimitEntry, type ModuleLimitExit, type ModuleOrderScope } from './capabilities/orders';
import type { ModuleFunding } from './contracts';
import { chartSnapshotService } from '../services/chartSnapshotService';

export function identity(run: ModuleIdentity): ModuleIdentity { return { moduleId: run.moduleId, packageHash: run.packageHash, generation: run.generation }; }
export function scope(run: NativeScope): NativeScope { return { runId: run.runId, walletAddress: run.walletAddress,
  walletGeneration: run.walletGeneration, configurationRevision: run.configurationRevision, secretRevision: run.secretRevision }; }
let walletAddress = nativeStore.getWallet()?.address.toLowerCase();
let walletGeneration = Date.now();
const perRunTicks = new Set<string>();
let lastScan = 0;
let initialization: Promise<void> | null = null;
let recoveredWallet: string | undefined;
const controllers = new Map<string, AbortController>();
const orderSignatures = new Map<string, string>();
const report = (run: ModuleRun, message: string) => systemLogService.logError('STRATEGY', `Module needs attention: ${run.moduleId} / ${run.token.symbol}`, message, run.chainId);
/** The run limits as the settings panel last saved them, if they can be read. */
function savedLimits(run: ModuleRun): RunLimits | undefined {
  const installed = moduleRegistry.get(run.moduleId);
  if (!installed) return undefined;
  try {
    const stored = JSON.parse(nativeStore.getItem('haven_defi_terminal_module_config_saved_v1') || '{}');
    const key = `${run.moduleId}:${run.chainId}:${run.token.address.toLowerCase()}`;
    const draft = stored?.[key]?.limits as LimitDraft | undefined;
    if (!draft || typeof draft.maxQuotePerOrder !== 'string' || typeof draft.duration !== 'string') return undefined;
    return draftToLimits(draft, installed.manifest.tradeCountControl === 'module',
      installed.manifest.orderAmountControl === 'module');
  } catch { return undefined; }
}
// The chosen strategy is per token workspace, not per app. Stored with the wallet's other
// per-token settings so switching wallets never drags a strategy choice across.
const chosenKey = 'haven_defi_terminal_module_token_strategies_v1';
const tokenKey = (chainId: number, tokenAddress: string) => `${chainId}:${tokenAddress.toLowerCase()}`;
function chosenMap(): Record<string, string> {
  try {
    if (!nativeStore.isHealthy()) return {};
    const value = JSON.parse(nativeStore.getItem(chosenKey) || '{}');
    return value && !Array.isArray(value) && typeof value === 'object' ? value as Record<string, string> : {};
  } catch { return {}; }
}
function chosenModuleFor(chainId: number, tokenAddress: string): string | undefined {
  return chosenMap()[tokenKey(chainId, tokenAddress)];
}
function rememberChosenModule(chainId: number, tokenAddress: string, moduleId: string) {
  if (!nativeStore.isHealthy()) return;
  nativeStore.setItem(chosenKey, JSON.stringify({ ...chosenMap(), [tokenKey(chainId, tokenAddress)]: moduleId }));
}

export async function observeModuleOrders(run: ModuleRun): Promise<Json> {
  await refreshModuleOrders(orderScope(run));
  return JSON.parse(JSON.stringify(observeOrders(orderScope(run)))) as Json;
}
function orderScope(run: ModuleRun, request?: ModuleRequest): ModuleOrderScope {
  const wallet = nativeStore.getWallet();
  if (!wallet) throw new Error('Active wallet is unavailable');
  return { moduleId: run.moduleId, moduleVersion: run.moduleVersion, packageHash: run.packageHash,
    configurationRevision: run.configurationRevision, priorPackages: run.priorPackages,
    runId: run.runId, wallet, token: run.token, chainId: run.chainId,
    isCurrent: async () => engine.isCurrent(run) && await invoke<boolean>('modules_scope_check', { identity: identity(run), scope: scope(run) }) && engine.isCurrent(run) };
}
async function reportFunding(run: ModuleRun, funding: ModuleFunding) {
  if (!engine.isCurrent(run)) throw new Error('Module changed during funding check');
  const blocked = funding.status === 'insufficient-funds';
  const previouslyBlocked = moduleStateStore.get(run.runId)?.fundingBlocked === true;
  if (blocked === previouslyBlocked) return;
  await moduleStateStore.update(run, current => { current.fundingBlocked = blocked; });
  if (blocked) systemLogService.logWarning('STRATEGY', `Waiting for funds: ${run.moduleId} / ${run.token.symbol}`, funding.message, run.chainId);
  else systemLogService.logInfo('STRATEGY', `Funding restored: ${run.moduleId} / ${run.token.symbol}`,
    `USD ${funding.availableUsd} available in ${funding.symbol}. Fresh trade analysis can resume.`, run.chainId);
}
async function dispatch(run: ModuleRun, request: ModuleRequest): Promise<Json> {
  if (!engine.isCurrent(run)) throw new Error('Module run changed');
  switch (request.capability) {
    case 'market.price.v1': return modulePrice(run);
    case 'market.candles.v1': return moduleCandles(run, request.input);
    case 'chart.snapshot.v1': {
      const capture = await chartSnapshotService.capture(run.token, run.chainId, request.input as unknown as ChartInput, controllers.get(run.runId)?.signal);
      if (!engine.isCurrent(run)) throw new Error('Module changed during chart capture');
      return invoke<Json>('modules_blob_put', { identity: identity(run), scope: scope(run), requestId: request.id,
        dataUrl: capture.dataUrl, metadata: capture.metadata });
    }
    case 'http.request.v1': return invoke<Json>('modules_http', { identity: identity(run), scope: scope(run), request: request.input as unknown as HttpInput });
    case 'orders.limit-entry.v1': {
      try {
        const saved = savedLimits(run);
        const result = await executeLimitEntry({ ...orderScope(run, request), intentId: request.id, request: request.input as unknown as ModuleLimitEntry,
          budget: { maxOrders: saved?.maxOrders ?? run.limits.maxOrders,
            maxQuoteAmount: saved?.maxQuotePerOrder ?? run.limits.maxTotalQuote,
            maxQuotePerOrder: saved?.maxQuotePerOrder ?? run.limits.maxQuotePerOrder,
            maxOpenOrders: saved?.maxOpenOrders ?? run.limits.maxOpenOrders,
            maxSlippageBps: 50, orderExpirySeconds: saved?.orderExpirySeconds ?? run.limits.orderExpirySeconds } });
        return { orderId: result?.id ?? null, timestamp: result?.timestamp ?? null, consumed: true };
      } catch (error) {
        if (!(error instanceof ModuleFundingError) || !moduleRegistry.get(run.moduleId)?.manifest.requestedCapabilities.includes('orders.funding.v1')) throw error;
        await reportFunding(run, error.funding);
        return { orderId: null, consumed: false, funding: { ...error.funding } };
      }
    }
    case 'orders.limit-exit.v1': {
      try {
        const order = await executeLimitExit({ ...orderScope(run, request), intentId: request.id,
          orderExpirySeconds: run.limits.orderExpirySeconds, request: request.input as unknown as ModuleLimitExit });
        return { orderId: order.id, consumed: true };
      } catch (error) {
        if (!(error instanceof ModulePositionChangedError)) throw error;
        return { orderId: null, consumed: false, positionChanged: true };
      }
    }
    case 'orders.funding.v1': {
      if (typeof request.input.quoteAmount !== 'string') throw new Error('Funding check requires a USD amount');
      const funding = await observeModuleFunding(orderScope(run), request.input.quoteAmount);
      await reportFunding(run, funding);
      return { ...funding };
    }
    case 'orders.observe.v1': return observeModuleOrders(run);
    case 'orders.cancel.v1': {
      if (typeof request.input.orderId !== 'string') throw new Error('Order cancellation requires an order ID');
      await cancelModuleOrder(orderScope(run), request.input.orderId); return { confirmed: true, orderId: request.input.orderId };
    }
    case 'events.schedule.v1': {
      const afterMs = Number(request.input.afterMs), name = String(request.input.name ?? request.id);
      if (!Number.isInteger(afterMs) || afterMs < 6000 || afterMs > 86400000 || name.length > 120) throw new Error('Invalid scheduled event');
      await moduleStateStore.update(run, current => {
        current.scheduled = current.scheduled.filter(item => !current.events.includes(`scheduled:${item.id}`));
        if (current.scheduled.length >= 32) throw new Error('Module scheduled event limit exceeded');
        if (!current.scheduled.some(item => item.id === request.id)) current.scheduled.push({ id: request.id, name, time: Date.now() + afterMs });
      });
      return { scheduled: true, name };
    }
    case 'log.module.v1': {
      const message = String(request.input.message ?? '').replace(/[\x00-\x1f]/g, ' ').slice(0, 512);
      const level = request.input.level ?? 'info';
      if (!['info', 'warn', 'error'].includes(String(level))) throw new Error('Invalid module log level');
      const log = level === 'error' ? systemLogService.logError : level === 'warn' ? systemLogService.logWarning : systemLogService.logInfo;
      log.call(systemLogService, 'STRATEGY', `${run.moduleId} / ${run.token.symbol}`, message, run.chainId);
      return { logged: true };
    }
    default: throw new Error(`Capability ${request.capability} is declarative and cannot be dispatched as an action`);
  }
}
export const engine = new ModuleHostEngine({
  get: moduleStateStore.get, update: moduleStateStore.update.bind(moduleStateStore), installed: moduleRegistry.get,
  current: run => STRATEGIES_ENABLED && nativeStore.isHealthy() && nativeStore.getWallet()?.address.toLowerCase() === run.walletAddress.toLowerCase() &&
    run.walletGeneration === walletGeneration && moduleRegistry.get(run.moduleId)?.status === 'installed' &&
    chosenModuleFor(run.chainId, run.token.address) === run.moduleId,
  invoke: (run, event, context) => invoke<ModuleOutput>('modules_invoke', { identity: identity(run), scope: scope(run), event,
    context: { ...context, chart: { timeframe: storageService.getChartSettings().interval } }, state: run.state }),
  dispatch, report, now: Date.now,
});
nativeStore.subscribe(() => {
  const next = nativeStore.getWallet()?.address.toLowerCase();
  if (walletAddress !== next) {
    controllers.forEach(controller => controller.abort()); controllers.clear();
    walletAddress = next; walletGeneration = Math.max(Date.now(), walletGeneration + 1); recoveredWallet = undefined;
  }
});

async function migrateLegacy() {
  if (!nativeStore.isHealthy() || nativeStore.getItem('haven_defi_terminal_module_config_migration_v1')) return;
  const records = storageService.getTokenLadders(), global = storageService.getImpulseLadderSettings();
  nativeStore.setItem('haven_defi_terminal_module_config_legacy_archive_v1', JSON.stringify({ records, global, archivedAt: Date.now() }));
  for (const [key, settings] of Object.entries(records)) records[key] = { ...settings, isActive: false };
  nativeStore.setItem('haven_defi_terminal_token_ladders_v1', JSON.stringify(records));
  nativeStore.setItem('haven_defi_terminal_impulse_ladder_settings_v1', JSON.stringify({ ...global, isActive: false }));
  await nativeStore.flush();
  nativeStore.setItem('haven_defi_terminal_module_config_migration_v1', '1'); await nativeStore.flush();
}
export const moduleHost = {
  async initialize(): Promise<void> {
    if (!STRATEGIES_ENABLED || !isTauri()) return;
    if (initialization) {
      await initialization;
      if (nativeStore.isHealthy() && recoveredWallet !== walletAddress) return this.initialize();
      return;
    }
    if (recoveredWallet && recoveredWallet === walletAddress) return;
    if (!nativeStore.isHealthy()) return;
    const recoveringAddress = walletAddress, recoveringGeneration = walletGeneration;
    const sameWallet = () => nativeStore.isHealthy() && walletAddress === recoveringAddress && walletGeneration === recoveringGeneration;
    initialization = (async () => {
      await moduleRegistry.refresh(true);
      if (!sameWallet() || recoveredWallet === recoveringAddress) return;
      await migrateLegacy();
      if (!sameWallet()) return;
      await recoverModuleOrderIntents(nativeStore.getWallet()!);
      if (!sameWallet()) return;
      for (const run of moduleStateStore.getSnapshot().filter(r => r.status === 'running')) {
        if (!sameWallet()) return;
        const installed = moduleRegistry.get(run.moduleId);
        if (!installed || installed.status !== 'installed' || installed.packageHash !== run.packageHash || installed.generation !== run.generation) {
          await moduleStateStore.update(run, current => { current.status = 'paused'; current.error = 'Installed module identity changed; start a new run'; }); continue;
        }
        if (chosenModuleFor(run.chainId, run.token.address) !== run.moduleId) {
          await moduleStateStore.update(run, current => { current.status = 'paused'; current.error = 'A different strategy is active for this token; start a new run'; }); continue;
        }
        try {
          const secrets = await moduleRegistry.secretStatus(run.moduleId);
          if (!sameWallet()) return;
          if (secrets.revision !== run.secretRevision) throw new Error('Module credentials changed; start a new run');
          await moduleStateStore.update(run, current => { current.walletGeneration = walletGeneration; });
          if (!sameWallet()) return;
          const current = moduleStateStore.get(run.runId)!;
          controllers.set(run.runId, new AbortController());
          await invoke('modules_scope_register', { identity: identity(current), scope: scope(current) });
          if (!sameWallet()) return;
          await engine.recover(run.runId);
        } catch (error) {
          if (!sameWallet()) return;
          await moduleStateStore.update(run, current => { current.status = 'error'; current.error = String(error).slice(0, 512); }); report(run, String(error));
        }
      }
      if (sameWallet()) recoveredWallet = recoveringAddress;
    })().finally(() => { initialization = null; });
    return initialization;
  },
  async start(moduleId: string, token: TokenConfig, chainId: number, configuration: Record<string, Json>, limits: RunLimits, wallet: WalletState) {
    requireStrategiesEnabled();
    await this.initialize();
    const installed = moduleRegistry.get(moduleId);
    if (!installed || installed.status !== 'installed') throw new Error('Select an installed module first');
    // Starting this strategy on this workspace is the choice, so it is recorded here. Choosing a
    // strategy for one token never changes any other token's strategy.
    const chosen = chosenModuleFor(chainId, token.address);
    if (chosen && chosen !== moduleId) {
      for (const run of moduleStateStore.getSnapshot().filter(candidate => candidate.status === 'running' &&
        candidate.moduleId !== moduleId && candidate.chainId === chainId &&
        candidate.token.address.toLowerCase() === token.address.toLowerCase())) await this.pause(run.runId);
    }
    rememberChosenModule(chainId, token.address, moduleId);
    if (!installed.manifest.supportedChains.includes(chainId) || token.chainId !== chainId) throw new Error('Module does not support this token chain');
    const validated = validateConfiguration(installed.manifest, configuration); validateLimits(limits);
    const secrets = await moduleRegistry.secretStatus(moduleId);
    if (secrets.conflicts?.length) throw new Error('This module has a different saved provider key. Save the key you want all modules to use.');
    if (installed.manifest.secretSlots.some(slot => slot.required && !secrets.configured.includes(slot.id))) throw new Error('Configure the required module keys before starting');
    const run = await exclusive(async () => {
      const startingGeneration = walletGeneration;
      const assertCurrent = () => {
        const current = moduleRegistry.get(moduleId);
        if (!current || current.status !== 'installed' || current.packageHash !== installed.packageHash || current.generation !== installed.generation ||
          chosenModuleFor(chainId, token.address) !== moduleId) throw new Error('Selected module changed before start');
        if (walletGeneration !== startingGeneration || nativeStore.getWallet()?.address.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('Active wallet changed before start');
      };
      assertCurrent();
      if (!nativeStore.isHealthy() || wallet.needsBackup || nativeStore.getWallet()?.address.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('Active wallet is unavailable or needs its backup');
      const currentSecrets = await moduleRegistry.secretStatus(moduleId);
      assertCurrent();
      if (currentSecrets.revision !== secrets.revision) throw new Error('Module credentials changed before start');
      if (moduleStateStore.getSnapshot().some(r => r.status === 'running' && r.chainId === chainId && r.token.address.toLowerCase() === token.address.toLowerCase())) throw new Error('This token already has an active module run');
      // Previous orders are not this run's concern. A buy that filled and is waiting for its exit
      // is the previous run's, not a reason to refuse a new one, and an old resting order is just
      // another order on the book.
      const now = Date.now();
      const created: ModuleRun = { ...identity(installed), moduleVersion: installed.manifest.moduleVersion, stateSchemaVersion: installed.manifest.stateSchemaVersion,
        runId: `run-${crypto.randomUUID()}`, walletAddress: wallet.address.toLowerCase(), walletGeneration, configurationRevision: 1, secretRevision: secrets.revision,
        token: { ...token }, chainId, configuration: validated, limits: { ...limits }, state: null, view: {}, status: 'running', createdAt: now, updatedAt: now,
        events: [], effects: {}, scheduled: [], requestTimes: [], eventTimes: [] };
      await moduleStateStore.transaction(wallet.address, runs => { assertCurrent(); runs[created.runId] = created; });
      rememberChosenModule(chainId, token.address, moduleId);
      return created;
    });
    controllers.set(run.runId, new AbortController());
    try {
      await invoke('modules_scope_register', { identity: identity(run), scope: scope(run) });
      if (!engine.isCurrent(run) || !await invoke<boolean>('modules_scope_check', { identity: identity(run), scope: scope(run) }) || !engine.isCurrent(run)) {
        throw new Error('Selected module or active wallet changed during start');
      }
      await engine.enqueue(run.runId, { id: 'start', type: 'start', time: Date.now() });
      const started = moduleStateStore.get(run.runId);
      if (started?.status === 'error') throw new Error(started.error);
      if (!started || started.status !== 'running' || !engine.isCurrent(run)) throw new Error('Module was paused or changed during start');
      return started;
    } catch (error) {
      engine.invalidate(run.runId); controllers.get(run.runId)?.abort(); controllers.delete(run.runId);
      await invoke('modules_scope_invalidate', { runId: run.runId });
      if (nativeStore.isHealthy() && nativeStore.getWallet()?.address.toLowerCase() === run.walletAddress) {
        await moduleStateStore.update(run, current => {
          if (current.status === 'running') { current.status = 'error'; current.error = String(error).slice(0, 512); }
        });
      }
      throw error;
    }
  },
  async resume(runId: string, configuration: Record<string, Json>, limits: RunLimits, wallet: WalletState) {
    requireStrategiesEnabled();
    await this.initialize();
    const previous = moduleStateStore.get(runId);
    if (!previous || !['paused', 'error'].includes(previous.status)) throw new Error('Select a paused or errored run to resume');
    const installed = moduleRegistry.get(previous.moduleId);
    if (!installed || installed.status !== 'installed') throw new Error('Select the installed module before resuming');
    if (chosenModuleFor(previous.chainId, previous.token.address) !== previous.moduleId) throw new Error('A different strategy is active for this token; start a new run');
    if (installed.manifest.stateSchemaVersion !== previous.stateSchemaVersion) throw new Error('This module update cannot resume the previous state');
    const validated = validateConfiguration(installed.manifest, configuration); validateLimits(limits);
    const secrets = await moduleRegistry.secretStatus(previous.moduleId);
    if (secrets.conflicts?.length) throw new Error('This module has a different saved provider key. Save the key you want all modules to use.');
    if (installed.manifest.secretSlots.some(slot => slot.required && !secrets.configured.includes(slot.id))) throw new Error('Configure the required module keys before resuming');
    const startingGeneration = walletGeneration;
    const assertCurrent = () => {
      const current = moduleRegistry.get(previous.moduleId), saved = moduleStateStore.get(runId);
      if (!nativeStore.isHealthy() || wallet.needsBackup || wallet.address.toLowerCase() !== previous.walletAddress ||
        nativeStore.getWallet()?.address.toLowerCase() !== previous.walletAddress || walletGeneration !== startingGeneration) throw new Error('Active wallet changed before resume');
      if (!current || current.status !== 'installed' || current.packageHash !== installed.packageHash || current.generation !== installed.generation ||
        chosenModuleFor(previous.chainId, previous.token.address) !== previous.moduleId ||
        saved?.status !== previous.status || saved.configurationRevision !== previous.configurationRevision) throw new Error('Module changed before resume');
    };
    assertCurrent();
    engine.invalidate(runId); controllers.get(runId)?.abort(); controllers.delete(runId);
    await invoke('modules_scope_invalidate', { runId });
    await recoverModuleOrderIntents(wallet); // Serialized with prepared order submission; never replay provider work.
    const run = await exclusive(async () => {
      assertCurrent();
      if (moduleStateStore.getSnapshot().some(r => r.runId !== runId && r.status === 'running' && r.chainId === previous.chainId && r.token.address.toLowerCase() === previous.token.address.toLowerCase())) throw new Error('This token already has an active module run');
      const next: ModuleRun = { ...previous, ...identity(installed), moduleVersion: installed.manifest.moduleVersion,
        configuration: validated, limits: { ...limits }, configurationRevision: previous.configurationRevision + 1,
        secretRevision: secrets.revision, walletGeneration, status: 'running', error: undefined, updatedAt: Date.now(),
        view: { ...previous.view, status: 'Resuming with saved settings' },
        priorPackages: [...(previous.priorPackages ?? [])] };
      if (previous.packageHash !== next.packageHash && !next.priorPackages!.some(p => p.packageHash === previous.packageHash)) {
        if (next.priorPackages!.length >= 64) throw new Error('Module update history limit reached');
        next.priorPackages!.push({ moduleVersion: previous.moduleVersion, packageHash: previous.packageHash });
      }
      next.effects = structuredClone(previous.effects);
      for (const effect of Object.values(next.effects)) if (effect.status !== 'applied') {
        effect.status = 'applied'; effect.error = 'Superseded by explicit resume';
      }
      next.scheduled = [];
      await moduleStateStore.transaction(wallet.address, runs => { assertCurrent(); runs[runId] = next; });
      return next;
    });
    controllers.set(runId, new AbortController()); engine.activate(runId); orderSignatures.delete(runId);
    try {
      await invoke('modules_scope_register', { identity: identity(run), scope: scope(run) });
      if (!engine.isCurrent(run)) throw new Error('Module changed during resume');
      await engine.enqueue(runId, { id: `resume:${run.configurationRevision}`, type: 'recovery', time: Date.now(),
        data: { resumed: true, orders: await observeModuleOrders(run) } });
      const resumed = moduleStateStore.get(runId);
      if (resumed?.status !== 'running') throw new Error(resumed?.error ?? 'Module did not resume');
      return resumed;
    } catch (error) {
      await engine.fail(runId, error); controllers.get(runId)?.abort(); controllers.delete(runId);
      await invoke('modules_scope_invalidate', { runId }); throw error;
    }
  },
  async pause(runId: string, drain = true) {
    const run = moduleStateStore.get(runId); if (!run) return;
    engine.invalidate(runId);
    controllers.get(runId)?.abort(); controllers.delete(runId);
    let pausedOutput: ModuleOutput | undefined;
    // Package cleanup is a bounded interpreter call only. No returned effect can be dispatched.
    // Removal/update may already have invalidated the scope, in which case there is no callback.
    try {
      const installed = moduleRegistry.get(run.moduleId);
      if (run.status === 'running' && installed?.status === 'installed' && installed.packageHash === run.packageHash && installed.generation === run.generation &&
          await invoke<boolean>('modules_scope_check', { identity: identity(run), scope: scope(run) })) {
        const now = Date.now();
        const output = await invoke<ModuleOutput>('modules_invoke', { identity: identity(run), scope: scope(run), state: run.state,
          event: { id: `pause:${now}`, type: 'pause', time: now },
          context: { hostApiVersion: 1, moduleId: run.moduleId, moduleVersion: run.moduleVersion, runId: run.runId, now,
            chainId: run.chainId, token: { address: run.token.address, symbol: run.token.symbol, decimals: run.token.decimals },
            configuration: run.configuration, limits: run.limits } });
        validateModuleOutput(output, installed, run);
        pausedOutput = output;
      }
    } catch (error) {
      systemLogService.logWarning('STRATEGY', `Module pause callback failed: ${run.moduleId}`, String(error).slice(0, 512), run.chainId);
    }
    let invalidationError: unknown;
    try { await invoke('modules_scope_invalidate', { runId }); }
    catch (error) { invalidationError = error; }
    await moduleStateStore.update(run, current => {
      current.status = 'paused';
      if (pausedOutput) { current.state = pausedOutput.nextState; current.view = pausedOutput.view ?? current.view; }
      if (invalidationError) current.error = `Native scope invalidation failed: ${String(invalidationError)}`.slice(0, 512);
    });
    if (drain) await exclusive(async () => {});
    if (invalidationError) throw new Error(`Module paused locally; native scope invalidation failed: ${String(invalidationError)}`);
  },
  async select(moduleId: string | null) {
    requireStrategiesEnabled();
    await moduleRegistry.select(moduleId);
  },
  /** Choose the strategy for one token workspace. Only this token's other strategies stop. */
  async chooseForToken(token: TokenConfig, chainId: number, moduleId: string) {
    requireStrategiesEnabled();
    await this.initialize();
    const installed = moduleRegistry.get(moduleId);
    if (!installed || installed.status !== 'installed') throw new Error('Select an installed module first');
    if (!installed.manifest.supportedChains.includes(chainId) || token.chainId !== chainId) throw new Error('Module does not support this token chain');
    await moduleRegistry.select(moduleId);
    // Read the pause list before any pause: a pause rewrites the store we are reading.
    const replaced = moduleStateStore.getSnapshot().filter(run => run.status === 'running' && run.moduleId !== moduleId &&
      run.chainId === chainId && run.token.address.toLowerCase() === token.address.toLowerCase());
    for (const run of replaced) await this.pause(run.runId);
    rememberChosenModule(chainId, token.address, moduleId);
    return { replaced };
  },
  async pauseAll(drain = true) {
    const runs = moduleStateStore.getSnapshot().filter(r => r.status === 'running');
    runs.forEach(run => { engine.invalidate(run.runId); controllers.get(run.runId)?.abort(); });
    for (const run of runs) await this.pause(run.runId, false);
    if (drain) await exclusive(async () => {});
  },
  async remove(moduleId: string) {
    await invoke('modules_remove_begin', { moduleId });
    await moduleRegistry.refresh(false, true);
    for (const run of moduleStateStore.getSnapshot().filter(r => r.moduleId === moduleId && r.status === 'running')) await this.pause(run.runId);
    await exclusive(async () => {});
    await invoke('modules_remove_finish', { moduleId }); await moduleRegistry.refresh(false, true);
  },
  async secret(moduleId: string, slotId: string, value: string | null) {
    requireStrategiesEnabled();
    // A provider key can serve runs from more than one installed module.
    await this.pauseAll();
    await invoke(value === null ? 'modules_secret_delete' : 'modules_secret_set', { moduleId, slotId, ...(value === null ? {} : { value }) });
    return moduleRegistry.secretStatus(moduleId);
  },
  async ui(runId: string, name: string) {
    requireStrategiesEnabled();
    const run = moduleStateStore.get(runId);
    if (!run || !moduleRegistry.get(run.moduleId)?.manifest.viewSchema.buttons.some(b => b.id === name)) throw new Error('Unknown module control');
    await engine.enqueue(runId, { id: `ui:${crypto.randomUUID()}`, type: 'ui', name, time: Date.now() });
  },
  async tick() {
    if (!STRATEGIES_ENABLED || !isTauri()) return;
    await this.initialize();
    if (Date.now() - lastScan > 5000) { lastScan = Date.now(); await moduleRegistry.refresh(true); }
    if (!nativeStore.isHealthy()) return;
    // Short local ledger reconciliation shares entry serialization, never a provider/status wait.
    // Stop-price monitoring remains on its independent engine path.
    await recoverModuleOrderIntents(nativeStore.getWallet()!);
    await Promise.allSettled(moduleStateStore.getSnapshot().filter(r => r.status === 'running').map(async run => {
      if (perRunTicks.has(run.runId)) return;
      perRunTicks.add(run.runId);
      try {
        if (!engine.isCurrent(run)) { await this.pause(run.runId); return; }
        const manifest = moduleRegistry.get(run.moduleId)!.manifest;
        for (const event of scheduledEvents(run, manifest, Date.now())) {
          if (event.type === 'price') event.data = await modulePrice(run);
          await engine.enqueue(run.runId, event);
        }
        if (manifest.eventSubscriptions.some(s => s.type === 'order')) {
          const orders = JSON.parse(JSON.stringify(observeOrders(orderScope(run)))) as Json, signature = JSON.stringify(orders);
          if (orderSignatures.get(run.runId) !== signature) {
            orderSignatures.set(run.runId, signature);
            await engine.enqueue(run.runId, { id: `orders:${crypto.randomUUID()}`, type: 'order', time: Date.now(), data: orders });
          }
        }
      } catch (error) { await engine.fail(run.runId, error); }
      finally { perRunTicks.delete(run.runId); }
    }));
  },
};
