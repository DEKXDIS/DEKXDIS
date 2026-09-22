/**
 * LLM Grid.
 *
 * The workspace runs this on its own timer. Each cycle asks the program for the data package, puts
 * it to the model, and sends back the order the model answers with.
 *
 * The package holds the chart, the trades still working, and the trades that closed. That is
 * everything this strategy is allowed to know about the workspace.
 *
 * The ledger below holds only what this run bought. A buy counts as bought once the program
 * reports it filled. Tokens committed to a sell that has not filled are still held, so they are
 * never offered up twice, and a sell that was cancelled or expired puts them straight back. The
 * ledger is saved with the run, so waking up reloads it and the package shows anything that
 * changed while the run was away. Because it only ever holds this run's own buys, a manual trade
 * can never be sold by this strategy.
 *
 * The program attaches the take profit the model names and manages it through to the sale.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Held = { quantity: number; price: number };

type Ledger = {
  /** Bought and not committed to a sell, keyed by the order that bought it. */
  held: Record<string, Held>;
  /** Committed to a sell that has not filled, keyed by that sell order. */
  selling: Record<string, Held & { from: string }>;
};

/** A buy resting unfilled: it occupies a level, and it is the only thing this strategy may cancel. */
type RestingBuy = { id: string; price: number };

type State = {
  ledger: Ledger;
  /** Buys resting unfilled, which occupy a level but are not bought yet. */
  resting: RestingBuy[];
  stage: 'idle' | 'orders' | 'chart';
  lastStatus: string;
  lastReason: string;
  lastPrice: string;
  /** Which cycle produced the reason above, so it shows for that cycle and no longer. */
  reasonCycle: number;
  /** When the last cycle ran, so one wake is one cycle. */
  lastCycleAt: number;
  /** Counts cycles. Request ids are built from this, and the cancel cooldown counts in cycles. */
  sequence: number;
  /** The cycle a cancel was last taken in, so the cooldown can be measured in cycles. */
  lastCancelCycle: number;
};

function text(value: Json | undefined): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function count(value: Json | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function fieldOf(source: Json | undefined, key: string): Json | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  return (source as Record<string, Json>)[key];
}

const timeframeOf = (context: Record<string, Json>): string => text(fieldOf(context.chart, 'timeframe')) || '15m';

/** One row per order, whatever shape the program hands back. */
function orderRows(orders: Json): Record<string, Json>[] {
  const list = Array.isArray(orders) ? orders : [];
  return list.filter(row => row && typeof row === 'object' && !Array.isArray(row)) as Record<string, Json>[];
}

/**
 * Replay the program's report into the ledger.
 *
 * A buy adds to held only when it is filled. A sell moves its amount out of held and into selling
 * while it rests, and only leaves once it is filled. A cancelled or expired sell puts its amount
 * back. Nothing leaves the ledger on the strength of a sell merely being placed.
 */
function reconcile(ledger: Ledger, orders: Json): Ledger {
  const held: Record<string, Held> = { ...ledger.held };
  const selling: Record<string, Held & { from: string }> = { ...ledger.selling };
  for (const row of orderRows(orders)) {
    const id = text(row.id);
    if (!id) continue;
    const status = text(row.status);
    const parent = text(row.parentOrderId);
    if (!parent) {
      // A buy this run placed.
      if (status === 'fulfilled' && count(row.executedBuyAmount) > 0 && !held[id] && !Object.values(selling).some(entry => entry.from === id)) {
        held[id] = { quantity: count(row.executedBuyAmount), price: count(row.executionPrice) || count(row.limitPrice) };
      }
      if (row.positionClosed === true) delete held[id];
      continue;
    }
    // A sell against one of those buys.
    if (status === 'fulfilled') {
      const committed = selling[id];
      if (committed) delete held[committed.from];
      delete selling[id];
      continue;
    }
    if (status === 'cancelled' || status === 'expired' || status === 'failed') {
      const committed = selling[id];
      if (committed) {
        held[committed.from] = { quantity: committed.quantity, price: committed.price };
        delete selling[id];
      }
      continue;
    }
    if (!selling[id] && held[parent]) {
      selling[id] = { ...held[parent], from: parent };
      delete held[parent];
    }
  }
  // An entry whose order the program no longer reports at all is spent, so it leaves the ledger
  // rather than accumulating for the life of the run.
  const reported = new Set(orderRows(orders).map(row => text(row.id)));
  for (const id of Object.keys(held)) if (!reported.has(id)) delete held[id];
  return { held, selling };
}

/**
 * Levels in use.
 *
 * A level is a buy the grid is still working on: one resting unfilled, or one that filled and has
 * nothing selling it. Once a buy fills and its take profit takes over, that buy is done and its
 * level is released, so the grid may take the next one. Positions whose take profit is working are
 * not counted, which is what keeps a grid from stalling for as long as its take profits sit away
 * from the price.
 */
const levelsInUse = (ledger: Ledger, resting: RestingBuy[]): number =>
  resting.length + Object.keys(ledger.held).length;

/** The prices already spoken for, so the model does not name one twice. */
const pricesInUse = (ledger: Ledger, resting: RestingBuy[]): number[] =>
  [...resting.map(entry => entry.price), ...Object.values(ledger.held), ...Object.values(ledger.selling)]
    .map(entry => typeof entry === 'number' ? entry : entry.price)
    .filter(price => price > 0);

/** Buys that are resting unfilled, and so are neither bought nor sellable yet. */
const restingBuys = (orders: Json): RestingBuy[] =>
  orderRows(orders)
    .filter(row => !text(row.parentOrderId) && (text(row.status) === 'pending' || text(row.status) === 'open'))
    .map(row => ({ id: text(row.id), price: count(row.limitPrice) }))
    .filter(entry => entry.id && entry.price > 0);

/** The model's answer, or the provider's own reason the call failed. */
function readAnswer(data: Json): { text: string; failure: string | null } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { text: '', failure: 'the request returned nothing' };
  const envelope = data as Record<string, Json>;
  const status = Number(envelope.status);
  const body = envelope.body;
  const object = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, Json> : undefined;
  if (object) {
    const error = object.error;
    if (error) {
      if (typeof error === 'object' && !Array.isArray(error)) {
        const fields = error as Record<string, Json>;
        return { text: '', failure: [text(fields.code), text(fields.message)].filter(Boolean).join(' ') || 'the provider refused the request' };
      }
      return { text: '', failure: text(error) };
    }
    const incomplete = object.incomplete_details;
    if (incomplete && typeof incomplete === 'object' && !Array.isArray(incomplete)) {
      const reason = text((incomplete as Record<string, Json>).reason);
      if (reason) return { text: '', failure: `the answer stopped early (${reason})` };
    }
  }
  if (Number.isFinite(status) && status !== 200) return { text: '', failure: `HTTP ${status}` };
  const output = object?.output;
  if (!Array.isArray(output)) return { text: '', failure: 'the answer had no content' };
  const parts = output
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => item as Record<string, Json>)
    .filter(item => item.type === 'message')
    .flatMap(item => Array.isArray(item.content) ? item.content : [])
    .filter(part => part && typeof part === 'object' && !Array.isArray(part))
    .map(part => part as Record<string, Json>);
  if (parts.some(part => part.type === 'refusal')) return { text: '', failure: 'the model refused this chart' };
  const answer = parts.filter(part => part.type === 'output_text').map(part => text(part.text)).join('\n');
  return { text: answer, failure: answer ? null : 'the answer was empty' };
}

/** The single JSON object the model was asked for. */
function decision(answer: string): { price: number; takeProfitPercent: number; cancelOrderId: string; reason: string } | null {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(answer.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const reason = typeof row.reason === 'string' ? row.reason : '';
  const cancelOrderId = typeof row.cancelOrderId === 'string' ? row.cancelOrderId : '';
  const price = Number(row.price);
  const takeProfitPercent = Number(row.takeProfitPercent);
  if (!Number.isFinite(price) || price <= 0) return { price: 0, takeProfitPercent: 0, cancelOrderId, reason };
  return { price, takeProfitPercent: Number.isFinite(takeProfitPercent) && takeProfitPercent > 0 ? takeProfitPercent : 0, cancelOrderId, reason };
}

function readState(raw: Json): State {
  const base: State = { ledger: { held: {}, selling: {} }, resting: [], stage: 'idle', lastStatus: 'Starting', lastReason: '', lastPrice: '', lastCycleAt: 0, sequence: 0, lastCancelCycle: 0, reasonCycle: 0 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const saved = raw as Record<string, Json>;
  const ledger = saved.ledger && typeof saved.ledger === 'object' && !Array.isArray(saved.ledger)
    ? saved.ledger as Record<string, Json> : {};
  const part = <T,>(key: string): Record<string, T> => {
    const value = ledger[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, T> = {};
    for (const [id, entry] of Object.entries(value as Record<string, Json>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const row = entry as Record<string, Json>;
      const quantity = count(row.quantity);
      if (quantity <= 0) continue;
      const price = count(row.price);
      const from = text(row.from);
      out[id] = (from ? { quantity, price, from } : { quantity, price }) as T;
    }
    return out;
  };
  return {
    ledger: { held: part<Held>('held'), selling: part<Held & { from: string }>('selling') },
    resting: (Array.isArray(saved.resting) ? saved.resting : [])
      .map(entry => entry && typeof entry === 'object' && !Array.isArray(entry)
        ? { id: text((entry as Record<string, Json>).id), price: count((entry as Record<string, Json>).price) }
        : { id: '', price: count(entry) })
      .filter(entry => entry.id && entry.price > 0),
    stage: saved.stage === 'orders' || saved.stage === 'chart' ? saved.stage : 'idle',
    lastStatus: text(saved.lastStatus) || base.lastStatus,
    lastReason: text(saved.lastReason),
    lastPrice: text(saved.lastPrice),
    lastCycleAt: Number(saved.lastCycleAt) || 0,
    sequence: Number(saved.sequence) || 0,
    lastCancelCycle: Number(saved.lastCancelCycle) || 0,
    reasonCycle: Number(saved.reasonCycle) || 0,
  };
}

function numericSetting(configuration: Record<string, Json>, key: string, fallback: number, min: number, max: number): number {
  const value = Number(configuration[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export const dekxdisModule = {
  handle(event: Record<string, Json>, context: Record<string, Json>, rawState: Json): Json {
    const state = readState(rawState);
    const settings = (context.configuration ?? {}) as Record<string, Json>;

    const instructions = text(settings.instructions).trim();
    if (!instructions) throw new Error('Chart instructions are required in the strategy settings');
    const model = text(settings.model).trim();
    if (!model) throw new Error('Choose a model in the strategy settings');
    const quoteAmount = text(settings.quoteAmount).trim();
    if (!/^\d+(\.\d{1,18})?$/.test(quoteAmount) || Number(quoteAmount) <= 0) throw new Error('Order amount (USD) must be a positive amount');

    const wakeMs = numericSetting(settings, 'wakeSeconds', 60, 6, 86400) * 1000;
    const maxOpenBuys = Math.round(numericSetting(settings, 'maxOpenBuys', 4, 1, 20));
    const candleCount = Math.round(numericSetting(settings, 'candleCount', 120, 60, 200));
    const cancelEnabled = settings.cancelEnabled !== false;
    const cancelCooldown = Math.round(numericSetting(settings, 'cancelCooldownCycles', 5, 1, 1000));

    const now = Number(event.time) || Date.now();
    const at = Date.now();
    const kind = text(event.type);
    const requestId = text(event.requestId);
    // Request ids are numbered, never derived from the event that triggered them. A reply is named
    // after the request that caused it, so building an id from the incoming event would nest one
    // layer deeper every cycle until it grew past the length the program allows and was refused.
    const cycle = String(state.sequence);

    // The reason belongs to the cycle that produced it. It stays on screen for the whole of that
    // cycle — including while the order it asked for is being placed — and is dropped when the next
    // cycle begins, so it is never read as though it were the newest answer.
    const reasonAge = state.sequence - state.reasonCycle;
    const lastReason = reasonAge <= 1 ? state.lastReason : '';
    const lastPrice = reasonAge <= 1 ? state.lastPrice : '';

    const shown = (status: string, extra: Record<string, Json> = {}): Record<string, Json> => ({
      status,
      reason: text(extra.reason ?? lastReason),
      price: text(extra.price ?? lastPrice),
      ...(extra.image ? { image: extra.image } : {}),
    });

    /** Save the lesson, and come back on this strategy's own timer. */
    const wakeLater = (next: State, view: Record<string, Json>): Json => ({
      nextState: { ...next, lastStatus: text(view.status), lastReason: text(view.reason),
        lastPrice: text(view.price), reasonCycle: next.sequence } as unknown as Json,
      requests: [{ id: `timer:${cycle}`, capability: 'events.schedule.v1',
        input: { afterMs: wakeMs, name: 'grid-cycle' } as Record<string, Json> }],
      view,
    });

    // A request the program could not carry out. Say so and wait for the next cycle.
    if (kind === 'capability-error') {
      return wakeLater({ ...state, stage: 'idle' },
        shown(`The program refused a request: ${text(event.error).slice(0, 200)}`));
    }

    if (kind === 'capability-result') {
      // The package. The ledger learns what actually happened while the run was away.
      if (requestId.startsWith('orders:')) {
        const next: State = { ...state, stage: 'chart', ledger: reconcile(state.ledger, event.data),
          resting: restingBuys(event.data) };
        return {
          nextState: next as unknown as Json,
          requests: [{ id: `chart:${cycle}`, capability: 'chart.snapshot.v1',
            input: { timeframe: timeframeOf(context), count: candleCount, width: 1200, height: 800,
              indicators: { volume: true } } as Record<string, Json> }],
          view: shown('Reading the chart'),
        };
      }

      // The picture is in hand. One cycle is one wake, so the wake setting is the only clock: a
      // cycle either places its buy or it does not, and the next one is a full interval away.
      if (requestId.startsWith('chart:')) {
        const handle = text((event.data as Record<string, Json> | undefined)?.handle);
        const levels = levelsInUse(state.ledger, state.resting);
        const room = maxOpenBuys - levels;
        // Moving an order only exists for a full grid. The cooldown is counted in cycles, and the
        // model is told the answer either way, so it never asks for something that is closed.
        const cooling = state.sequence - state.lastCancelCycle < cancelCooldown;
        const canCancel = cancelEnabled && room <= 0 && !cooling;

        if (!handle) return wakeLater({ ...state, stage: 'idle' }, shown('No chart was available this cycle'));

        const policy = !cancelEnabled
          ? 'Canceling is OFF. You may not cancel any order. Choose where to buy, or wait.'
          : canCancel
            ? 'Canceling is ON. You may cancel ONE of your open buys this cycle if the chart tells you it is doing nothing useful and a better level is worth taking. Canceling is a choice, not a routine: cancel only when you would genuinely place its replacement higher, and say why in the reason. An order you do not replace should be left alone.'
            : room > 0
              ? 'Canceling is unavailable while there is room to buy. Place your buy, or wait.'
              : `Canceling is ON but resting this cycle: ${cancelCooldown} cycles must pass between cancels. Place your buy, or wait.`;

        const ask = {
          model, store: false, max_output_tokens: 1024,
          input: [{ role: 'user', content: [
            { type: 'input_text', text: `${instructions}

${policy}

Answer with one JSON object and nothing else:
{"price": <the buy price>, "takeProfitPercent": <percent above the fill>, "cancelOrderId": <an open buy to cancel, or omit>, "reason": "<short why>"}
If there is no worthwhile entry, answer {"price": 0, "takeProfitPercent": 0, "reason": "<short why>"}.
Place at most ${room > 0 ? room : 0} buy this cycle, and do not reuse a price that already has an order.` },
            { type: 'input_image', image_url: '', detail: 'high' },
            { type: 'input_text', text: JSON.stringify({
              symbol: text(fieldOf(context.token, 'symbol')),
              timeframe: timeframeOf(context),
              orderAmountUsd: quoteAmount,
              maxOpenBuys,
              levelsWorking: levels,
              buyingRoom: room,
              canceling: cancelEnabled ? (canCancel ? 'available' : 'resting') : 'off',
              openBuys: state.resting.map(entry => ({ orderId: entry.id, price: entry.price })),
            }) },
          ] }],
        };

        return {
          nextState: { ...state, stage: 'idle' } as unknown as Json,
          requests: [{ id: `model:${cycle}`, capability: 'http.request.v1',
            input: { endpointId: 'model', body: ask as unknown as Record<string, Json>,
              attachments: [{ handle, pointer: '/input/0/content/1/image_url', encoding: 'data-url' }] } as unknown as Record<string, Json> }],
          view: shown('Asking the model', { image: handle }),
        };
      }

      // The model answered, so carry out what it asked for.
      if (requestId.startsWith('model:')) {
        const answer = readAnswer(event.data);
        if (answer.failure) return wakeLater({ ...state, stage: 'idle' }, shown(`The model call failed: ${answer.failure}`));
        const plan = decision(answer.text);
        if (!plan) {
          const raw = answer.text.replace(/\s+/g, ' ').trim().slice(0, 240);
          return wakeLater({ ...state, stage: 'idle' }, shown(`The model did not answer with a decision: ${raw || 'nothing came back'}`));
        }

        // A cancel is granted only when the switch is on, the grid is full, the cooldown has
        // passed, the model named one of this run's own open buys, and it gave a reason. Anything
        // else and no cancel is sent at all.
        const levels = levelsInUse(state.ledger, state.resting);
        const cooling = state.sequence - state.lastCancelCycle < cancelCooldown;
        const target = plan.cancelOrderId ? state.resting.find(entry => entry.id === plan.cancelOrderId) : undefined;
        const cancelGranted = cancelEnabled && levels >= maxOpenBuys && !cooling
          && !!target && plan.reason.trim().length > 0;

        const requests: { id: string; capability: string; input: Record<string, Json> }[] = [];
        if (cancelGranted) requests.push({
          id: `cancel:${cycle}`, capability: 'orders.cancel.v1',
          input: { orderId: target!.id } as Record<string, Json>,
        });

        if (!plan.price) {
          const next: State = { ...state, stage: 'idle',
            lastCancelCycle: cancelGranted ? state.sequence : state.lastCancelCycle };
          return wakeLater(next, shown(cancelGranted
            ? `Canceled the order at ${target!.price}, waiting to buy`
            : 'No trade this cycle', { reason: plan.reason }));
        }
        if (!plan.takeProfitPercent) {
          const next: State = { ...state, stage: 'idle',
            lastCancelCycle: cancelGranted ? state.sequence : state.lastCancelCycle };
          return wakeLater(next, shown('The model named a buy without a take profit, so nothing was placed', { reason: plan.reason }));
        }
        // A level that already has an order is not placed again, whatever the model says. When the
        // cancel is granted that level is being freed, so its own price may be reused.
        if (pricesInUse(state.ledger, state.resting)
          .filter(price => !(cancelGranted && Math.abs(price - target!.price) < 1e-9))
          .some(price => Math.abs(price - plan.price) < 1e-9)) {
          return wakeLater({ ...state, stage: 'idle' },
            shown(`That level already has an order at ${plan.price}, so nothing was placed`, { reason: plan.reason }));
        }

        requests.push({
          id: `buy:${cycle}`, capability: 'orders.limit-entry.v1',
          input: { price: plan.price, quoteAmount,
            // The take profit goes in as a price, the same way an order placed by hand does. The
            // model gives a percent above the entry, so the price is worked out here and the order
            // carries it from the moment it is placed. The basis says 'fixed' because a price is
            // what is being sent.
            protection: { basis: 'fixed', takeProfit: plan.price * (1 + plan.takeProfitPercent / 100) } } as Record<string, Json>,
        });

        const next: State = { ...state, stage: 'idle',
          lastCancelCycle: cancelGranted ? state.sequence : state.lastCancelCycle };
        const moved = cancelGranted ? `Canceled the order at ${target!.price}; ` : '';
        return {
          nextState: next as unknown as Json,
          requests: requests as unknown as Json[],
          view: shown(`${moved}buying at ${plan.price} with a take profit at ${(plan.price * (1 + plan.takeProfitPercent / 100)).toFixed(6)}`,
            { reason: plan.reason, price: String(plan.price) }),
        };
      }

      if (requestId.startsWith('cancel:')) {
        return wakeLater({ ...state, stage: 'idle' },
          shown('Canceled an order that was doing nothing useful', { reason: state.lastReason }));
      }

      if (requestId.startsWith('buy:')) {
        const placed = text((event.data as Record<string, Json> | undefined)?.orderId);
        return wakeLater({ ...state, stage: 'idle' },
          shown(placed ? 'Order placed; the take profit is attached' : 'The program did not place that order'));
      }
    }

    // A new cycle. The wake setting decides how often one actually runs; the timer the program
    // provides is only the heartbeat that tells this strategy to look at the clock.
    if (state.lastCycleAt && at - state.lastCycleAt < wakeMs) {
      return {
        nextState: state as unknown as Json,
        requests: [],
        view: shown(state.lastStatus),
      };
    }
    const sequence = state.sequence + 1;
    return {
      nextState: { ...state, stage: 'orders', lastCycleAt: at, sequence } as unknown as Json,
      requests: [{ id: `orders:${sequence}`, capability: 'orders.observe.v1', input: {} as Record<string, Json> }],
      view: shown('Checking the account'),
    };
  },
};

/** The packaged entrypoint. */
export const handle = dekxdisModule.handle;
