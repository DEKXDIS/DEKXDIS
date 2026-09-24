// Focused offline checks. No wallet files, RPCs, models or CoW endpoints are accessed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const mocks = globalThis.__automationTestMocks = {};
async function load(entry, replacements = {}) {
  Object.assign(mocks, replacements);
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{ name: 'offline-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const key = Object.keys(replacements).find(key => args.path === key || args.path.endsWith('/' + key));
        if (key) return { path: key, namespace: 'mock' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: Object.keys(replacements[args.path])
        .map(name => `export const ${name} = globalThis.__automationTestMocks[${JSON.stringify(args.path)}][${JSON.stringify(name)}];`).join('\n') }));
    } }] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const owner = '0x1111111111111111111111111111111111111111';
const token = { address: '0x2222222222222222222222222222222222222222', chainId: 1, decimals: 6, symbol: 'TEST', name: 'Test' };
const quote = { address: '0x3333333333333333333333333333333333333333', decimals: 18, symbol: 'WETH' };
const w = { owner, token, chainId: 1 };
const wallet = { address: owner };
let orders = [], submitted = 0, nextId = 0, writes = 0, currentWallet = wallet, failPost = false;
let serial = Promise.resolve();
const base = { id: 'b1', ownerAddress: owner, chainId: 1, timestamp: 1, status: 'pending', tradeSide: 'buy',
  sellToken: quote.address, buyToken: token.address, sellAmount: '0.01', buyAmount: '10', sellDecimals: 18, buyDecimals: 6 };
const buy = (changes = {}) => ({ ...base, ...changes });
const sell = (changes = {}) => ({ ...base, id: 's1', tradeSide: 'sell', sellToken: token.address, buyToken: quote.address,
  sellAmount: '10', buyAmount: '0.01', sellDecimals: 6, buyDecimals: 18, ...changes });
const packet = await load('src/automation/packet.ts');
const filled = buy({ status: 'fulfilled', executedBuyAmount: '10', bracket: { tpEnabled: true, isCompleted: false }, ocoGroupId: 'AA' });
const tp = sell({ status: 'open', parentOrderId: 'b1', ocoGroupId: 'AA' });
assert.equal(packet.openBuyCount([filled, tp], w), 0, 'a TP does not keep a filled buy slot occupied');
assert.equal(packet.openBuyCount([filled, tp, buy({ id: 'b2' }), buy({ id: 'b3', status: 'open' })], w), 2);
assert.equal(packet.openBuyCount([buy({ chainId: 56 }), buy({ ownerAddress: quote.address }), sell()], w), 0);
const history = packet.tradePacket([filled, tp, sell({ id: 's2', parentOrderId: 'b1', timestamp: 2, status: 'fulfilled', executedSellAmount: '3' })], w, 1);
assert.equal(history.openPositions[0].remainingTokenAmount, '7.0');
assert.equal(history.recentOrders.length, 1);
assert.equal(packet.tradePacket([filled], w, 0).recentOrders.length, 0);
assert.equal(packet.tradePacket([filled, sell({ timestamp: 2, status: 'fulfilled', executedSellAmount: '10' })], w, 2).openPositions.length, 0);
for (const extras of [{}, { takeProfitPrice: 3 }, { stopLossPrice: 1 }, { takeProfitPrice: 3, stopLossPrice: 1 }]) {
  assert.equal(packet.parseDecision(JSON.stringify({ reason: 'x', orders: [{ side: 'buy', price: 2, amount: '10', amountUnit: 'usd', ...extras }] })).orders.length, 1);
}
assert.throws(() => packet.parseDecision('{"reason":"x","orders":[{"side":"buy","price":-1,"amount":"2","amountUnit":"usd"}]}'));
assert.throws(() => packet.parseDecision('{"reason":"x","orders":[],"cancel":["b1"]}'));

const native = { getWallet: () => currentWallet, isHealthy: () => true, subscribe: () => () => {} };
const storage = { getOrders: () => orders, getAccountingOrders: current => current || orders,
  addOrders: added => { orders.push(...added); }, flush: async () => { writes++; } };
const placement = await load('src/services/orderPlacement.ts', {
  nativeStore: { nativeStore: native }, storageService: { storageService: storage },
  executionEngine: { exclusive: fn => { const work = serial.then(fn); serial = work.catch(() => {}); return work; } },
  tradingQuote: { assertTradingPair: () => {}, tradingQuoteUsdPrice: async () => 2000 },
  chains: { getTradingQuoteToken: () => quote },
  web3Service: { web3Service: { getTokenBalanceWei: async (_owner, address) => address === quote.address ? 1000000000000000000n : 1000000000n,
    ensureAllowance: async () => {}, getSigner: () => ({ address: owner }) } },
  cowProtocol: { cowProtocol: { getExplorerUrl: id => `test:${id}`, submitLimitOrder: async params => {
    await params.onPrepared(`uid-${++nextId}`); assert(writes > 0, 'local order saved before posting'); submitted++;
    if (failPost) throw new Error('network timeout');
  } } },
  ocoUtils: { getNextOcoTag: () => `group-${nextId}`, recordAllocatedOcoTag: () => {} },
});
assert.equal(placement.reservedAmount([filled, tp, sell({ id: 'sl', parentOrderId: 'b1', ocoGroupId: 'AA' })], owner, 1, token.address, 6), 10000000n);
for (const extras of [{}, { takeProfitPrice: 3 }, { stopLossPrice: 1 }, { takeProfitPrice: 3, stopLossPrice: 1 }]) {
  orders = [];
  const [order] = await placement.placeOrder({ wallet, token, chainId: 1 }, { side: 'buy', price: 2, amount: '10', amountUnit: 'usd', ...extras });
  assert.equal(order.sellAmount, '0.005'); assert.equal(order.buyAmount, '5.0');
  assert.equal(!!order.bracket?.tpEnabled, extras.takeProfitPrice !== undefined);
  assert.equal(!!order.bracket?.slEnabled, extras.stopLossPrice !== undefined);
  assert.equal(!!order.bracket, Object.keys(extras).length > 0);
}
orders = []; const command = { side: 'buy', price: 2, amount: '10', amountUnit: 'usd' };
failPost = true; const before = submitted;
await assert.rejects(placement.placeOrder({ wallet, token, chainId: 1, requestId: 'same' }, command), /timeout/);
failPost = false;
await placement.placeOrder({ wallet, token, chainId: 1, requestId: 'same' }, command);
assert.equal(submitted, before + 1, 'uncertain order retained, same intent never submitted twice');
orders = []; const beforeStop = submitted;
await placement.placeOrder({ wallet, token, chainId: 1 }, { side: 'sell', price: 1, amount: '5', amountUnit: 'token', sellKind: 'stop' });
assert.equal(submitted, beforeStop, 'conditional stop waits for main engine'); assert.equal(orders[0].isConditional, true);
orders = [];
await placement.placeOrder({ wallet, token, chainId: 1 }, { side: 'sell', price: 3, amount: '5', amountUnit: 'token', stopLossPrice: 1 });
assert.equal(orders.length, 2); assert.equal(orders[0].connectedOrderId, orders[1].id); assert.equal(orders[1].connectedOrderId, orders[0].id);
currentWallet = { address: quote.address };
await assert.rejects(placement.placeOrder({ wallet, token, chainId: 1 }, command), /wallet/); currentWallet = wallet;

const local = new Map(); globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value),
  removeItem: key => local.delete(key), key: index => [...local.keys()][index], get length() { return local.size; } };
globalThis.window = { dispatchEvent: () => {}, addEventListener: () => {} };
let stored = { [`${owner}:haven_defi_terminal_module_runs_v1`]: 'large old run', [`${owner}:haven_defi_terminal_orders`]: 'old orders',
  haven_defi_terminal_rpc_api_keys_v1: 'preserve', customSetting: 'preserve' };
const calls = [];
const realStore = (await load('src/services/nativeStore.ts', { '@tauri-apps/api/core': { isTauri: () => true, invoke: async (name, args) => {
  calls.push(name); if (name === 'vault_open') return { wallet, data: { ...stored }, notice: null };
  if (name === 'vault_save') { await new Promise(resolve => setImmediate(resolve)); stored = { ...args.data }; return; }
  throw new Error('Unexpected native call: ' + name);
} } })).nativeStore;
await realStore.initialize();
assert.equal(stored[`${owner}:haven_defi_terminal_module_runs_v1`], undefined);
assert.equal(stored[`${owner}:haven_defi_terminal_orders`], undefined);
assert.equal(stored.haven_defi_terminal_rpc_api_keys_v1, 'preserve');
realStore.setItem('test-value', 'written'); await realStore.flush(); assert.equal(stored['test-value'], 'written');
assert(calls.every(name => ['vault_open', 'vault_save'].includes(name)), 'no wallet mutation commands');

let reply, modelCalls = 0, placed = 0;
const pendingModel = () => new Promise(resolve => { reply = resolve; modelCalls++; });
const runner = (await load('src/automation/runner.ts', {
  '@tauri-apps/api/core': { invoke: pendingModel }, nativeStore: { nativeStore: native }, storageService: { storageService: storage },
  releaseFeatures: { getStrategiesEnabled: () => true }, chains: { getTradingQuoteToken: () => quote },
  tradingQuote: { assertTradingPair: () => {} },
  web3Service: { web3Service: { getTokenBalanceWei: async () => 100000000000000000000n } },
  systemLogService: { systemLogService: { logWarning: () => {} } },
  chartCapture: { captureWorkspace: async () => ({ image: 'data:image/png;base64,TEST', capturedAt: Date.now(), interval: '15m', orders: orders.slice() }) },
  orderPlacement: { reservedAmount: () => 0n, placeOrder: async (ctx, cmd) => {
    ctx.checkCurrent(); placed++; orders.push(buy({ id: `runner-${placed}`, timestamp: Date.now(), automationRequestId: ctx.requestId }));
    assert.equal(cmd.amount, '7');
  } },
})).automation;
const settings = { prompt: 'my instructions', model: 'test', intervalSeconds: 60, tradeIntervalSeconds: 0, maxOpenBuys: 1,
  amountMode: 'fixed', amount: '7', amountUnit: 'usd', historyCount: 2 };
const key = `${owner}:1:${token.address}`;
const settle = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error('Test did not settle'); };
orders = []; runner.start(w, settings); await settle(() => modelCalls === 1);
runner.stop(key); reply(JSON.stringify({ reason: 'buy', orders: [command] })); await settle(() => !runner.status(key).busy);
assert.equal(placed, 0, 'stopped model reply cannot place an order');
orders = [filled, tp]; runner.start(w, settings); await settle(() => modelCalls === 2);
reply(JSON.stringify({ reason: 'buy twice', orders: [command, command] })); await settle(() => !runner.status(key).busy);
assert.equal(placed, 1, 'filled buy frees slot; second command checks the newly placed buy');
runner.stopAll();
const priorWrites = writes; orders = [];
runner.start(w, settings); await settle(() => modelCalls === 3); reply('{"reason":"wait","orders":[]}'); await settle(() => !runner.status(key).busy);
assert.equal(writes, priorWrites, 'no-trade cycle does not persist a packet, response or run'); runner.stopAll();
assert.equal(local.size, 0, 'runner never stores model packets or transcripts');
console.log('PASS: counts, positions, response validation, optional TP/SL, shared placement, OCO reservation, uncertain submission, wallet isolation, cleanup, durable flush, stop during inference, live limits, disposable cycles.');
