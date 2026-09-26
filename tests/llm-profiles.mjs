// Offline checks: no real keys, wallet files, model requests or trades.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
globalThis.__llmMocks = {};
async function load(entry, replacements = {}) {
  Object.assign(globalThis.__llmMocks, replacements);
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{ name: 'offline-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const key = Object.keys(replacements).find(key => args.path === key || args.path.endsWith('/' + key));
        if (key) return { path: key, namespace: 'mock' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: Object.keys(replacements[args.path])
        .map(name => `export const ${name} = globalThis.__llmMocks[${JSON.stringify(args.path)}][${JSON.stringify(name)}];`).join('\n') }));
    } }] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const local = new Map();
globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value),
  removeItem: key => local.delete(key), key: i => [...local.keys()][i], get length() { return local.size; } };
globalThis.window = { dispatchEvent() {}, addEventListener() {} };
const prefix = 'dekxdis_automation_settings_v1:';
local.set(prefix + 'token-a', JSON.stringify({ model: 'old-a', prompt: 'Keep my prompt', intervalSeconds: 35 }));
local.set(prefix + 'token-b', JSON.stringify({ model: 'old-b', prompt: 'Different strategy' }));
local.set(prefix + 'assigned', JSON.stringify({ llmProfileId: 'chosen', model: 'do-not-migrate', prompt: 'Chosen' }));
local.set(prefix + 'broken', '{broken');
let listedModels;
const profiles = await load('src/automation/llmProfiles.ts', { '@tauri-apps/api/core': { invoke: async (name, args) => {
  assert.equal(name, 'automation_profiles_list'); listedModels = args.legacyModels;
  return { profiles: [{ id: 'profile-a' }, { id: 'profile-b' }], credentials: [], defaultProfileId: 'profile-b', legacyModels: { 'old-a': 'profile-a', 'old-b': 'profile-b' } };
} } });
await profiles.llmProfiles.list();
assert.deepEqual(listedModels.sort(), ['old-a', 'old-b']);
assert.deepEqual(JSON.parse(local.get(prefix + 'token-a')), { llmProfileId: 'profile-a', prompt: 'Keep my prompt', intervalSeconds: 35 });
assert.equal(JSON.parse(local.get(prefix + 'token-b')).llmProfileId, 'profile-b');
assert.equal(JSON.parse(local.get(prefix + 'assigned')).llmProfileId, 'chosen');
assert.equal(local.get(prefix + 'broken'), '{broken');
await profiles.llmProfiles.list(); assert.deepEqual(listedModels, [], 'migration is idempotent');
assert.deepEqual(profiles.profileAssignments('profile-a'), ['token-a']);
const form = await load('src/automation/settings.ts');
form.saveProfileSelection('token-a', 'profile-b');
assert.equal(form.readSettings('token-a').prompt, 'Keep my prompt');
assert.equal(form.readSettings('token-a').intervalSeconds, 35);
assert.equal(form.readSettings('assigned').llmProfileId, 'chosen');
assert.equal(form.readSettings('new-token').llmProfileId, '', 'new tokens have no silently persisted model assignment');
console.log('PASS: distinct legacy model migration, retained prompts, explicit assignments and defaults.');

const owner = '0x1111111111111111111111111111111111111111';
const tokenA = { address: '0x2222222222222222222222222222222222222222', chainId: 1, decimals: 18, symbol: 'A', name: 'A' };
const tokenB = { ...tokenA, address: '0x3333333333333333333333333333333333333333', symbol: 'B' };
const wallet = { address: owner };
const quote = { address: '0x4444444444444444444444444444444444444444', decimals: 18, symbol: 'WETH' };
const requests = [], opens = [], closes = [], placed = [];
let delayedOpen;
const settle = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error('Test did not settle'); };
const runner = (await load('src/automation/runner.ts', {
  '@tauri-apps/api/core': { invoke: async (name, args) => {
    if (name === 'automation_session_open') {
      opens.push(args);
      if (delayedOpen) await new Promise(resolve => { delayedOpen = resolve; });
      return { profileId: args.profileId, name: args.profileId, model: args.profileId + '-model' };
    }
    if (name === 'automation_session_close') { closes.push(args.sessionId); return; }
    assert.equal(name, 'automation_decide');
    return new Promise(resolve => requests.push({ args, resolve }));
  } },
  nativeStore: { nativeStore: { isHealthy: () => true, getWallet: () => wallet, subscribe() {} } },
  storageService: { storageService: { getOrders: () => [], getAccountingOrders: () => [] } },
  releaseFeatures: { getStrategiesEnabled: () => true }, tradingQuote: { assertTradingPair() {} },
  chains: { getTradingQuoteToken: () => quote },
  web3Service: { web3Service: { getTokenBalanceWei: async () => 10n ** 18n } },
  systemLogService: { systemLogService: { logWarning() {}, logInfo() {} } },
  chartCapture: { captureWorkspace: async () => ({ image: 'fixture', orders: [], capturedAt: Date.now() }) },
  packet: { openBuyCount: () => 0, workspaceOrders: () => [], tradePacket: () => ({ openOrders: [] }),
    RESPONSE_FORMAT: 'JSON', parseDecision: text => ({ cancelOrderIds: [], ...JSON.parse(text) }) },
  allowance: { tradingAllowance: () => ({}), assertBuyAllowance() {} }, executionEngine: { executionEngine: {} },
  orderPlacement: { reservedAmount: () => 0n, placeOrder: async context => { context.checkCurrent(); placed.push(context.token.symbol); } },
})).automation;
const keyA = form.workspaceKey(owner, 1, tokenA.address), keyB = form.workspaceKey(owner, 1, tokenB.address);
const a = { ...form.defaultSettings, llmProfileId: 'profile-a', prompt: 'A instructions' };
const b = { ...form.defaultSettings, llmProfileId: 'profile-b', prompt: 'B instructions' };
const decision = JSON.stringify({ reason: 'test', orders: [{ side: 'buy' }] });
try {
  await runner.start({ owner, token: tokenA, chainId: 1 }, a);
  await runner.start({ owner, token: tokenB, chainId: 1 }, b);
  await settle(() => requests.length === 2);
  assert.notEqual(opens[0].sessionId, opens[1].sessionId);
  assert.equal(opens[0].profileId, 'profile-a'); assert.equal(opens[1].profileId, 'profile-b');
  a.llmProfileId = 'changed';
  assert.equal(requests[0].args.packet.settings.llmProfileId, 'profile-a', 'active settings are copied');
  assert.equal(requests[0].args.sessionId, opens[0].sessionId);
  assert.equal(requests[1].args.sessionId, opens[1].sessionId);
  assert.match(requests[0].args.instructions, /^A instructions/); assert.match(requests[1].args.instructions, /^B instructions/);
  assert.deepEqual(Object.keys(requests[0].args).sort(), ['image', 'instructions', 'packet', 'sessionId'], 'no keys or connection settings are passed through the strategy request');
  runner.stop(keyA);
  assert.equal(runner.status(keyB).running, true);
  await assert.rejects(runner.start({ owner, token: tokenA, chainId: 1 }, b), /previous request/);
  requests[0].resolve(decision); requests[1].resolve(decision);
  await settle(() => !runner.status(keyA).busy && !runner.status(keyB).busy);
  assert.deepEqual(placed, ['B'], 'late replies for A are discarded while B continues');
  await runner.start({ owner, token: tokenA, chainId: 1 }, b);
  await settle(() => requests.length === 3);
  assert.equal(opens[2].profileId, 'profile-b'); assert.notEqual(opens[2].sessionId, opens[0].sessionId);
  runner.stop(keyA); requests[2].resolve(decision); await settle(() => !runner.status(keyA).busy);
  assert.deepEqual(placed, ['B']);
  delayedOpen = true;
  const opening = runner.start({ owner, token: tokenA, chainId: 1 }, b);
  await settle(() => typeof delayedOpen === 'function'); runner.stop(keyA); delayedOpen(); await opening;
  assert.equal(runner.status(keyA).running, false); assert.equal(runner.status(keyA).busy, false);
  assert.equal(requests.length, 3, 'Stop during profile opening never starts a model request');
  assert(closes.includes(opens[3].sessionId));
} finally { runner.stopAll(); }
console.log('PASS: independent token profiles, run snapshots, profile switching and Stop during pending requests.');
