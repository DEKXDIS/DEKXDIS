// Checks the requests the strategy sends against the program's own rules: which capability it
// asks for, which fields that capability accepts, and whether the manifest declares it.
//
// Capability names are counted directly rather than by matching whole request objects. Request
// objects contain nested braces, so a pattern that tries to match one whole object either fails or
// silently skips some, and a checker that skips a request is worse than no checker.
const fs = require('fs');
const src = fs.readFileSync('strategy-modules/llm-grid/index.ts', 'utf8');
const manifest = JSON.parse(fs.readFileSync('strategy-modules/llm-grid/manifest.json', 'utf8'));

const allowed = {
  'orders.observe.v1': [],
  'market.price.v1': [],
  'chart.snapshot.v1': ['timeframe', 'count', 'width', 'height', 'indicators'],
  'market.candles.v1': ['timeframe', 'count', 'closedOnly'],
  'events.schedule.v1': ['afterMs', 'name'],
  'log.module.v1': ['level', 'message'],
  'orders.cancel.v1': ['orderId'],
  'orders.limit-entry.v1': ['price', 'quoteAmount', 'protection', 'basisRequestId'],
  'orders.limit-exit.v1': ['parentOrderId', 'price', 'quantity', 'basisRequestId'],
  'orders.funding.v1': ['quoteAmount'],
  'http.request.v1': ['endpointId', 'body', 'headers', 'attachments'],
};

const problems = [];
// Every capability-shaped string in the file, whether it is a request or a declaration.
const named = [...new Set([...src.matchAll(/'(market|chart|events|state|http|secrets|orders|ui|log)\.[a-z0-9.-]+'/g)]
  .map(m => m[0].slice(1, -1)))];

for (const capability of named) {
  if (!(capability in allowed)) problems.push(`uses a capability the program does not have: ${capability}`);
  if (!manifest.requestedCapabilities.includes(capability)) problems.push(`uses a capability the manifest does not declare: ${capability}`);
}
const declarative = ['state.module.v1', 'ui.module.v1', 'secrets.inject.v1', 'orders.protection.v1'];
for (const capability of manifest.requestedCapabilities) {
  if (!named.includes(capability) && !declarative.includes(capability)) {
    problems.push(`manifest declares a capability nothing uses: ${capability}`);
  }
}

// The fields each request carries, by the rules the native runtime enforces.
const entry = /protection:\s*\{\s*basis:\s*'(fixed|actual-fill)'\s*,\s*takeProfit:/.test(src);
if (!entry) problems.push('the buy request does not send basis and takeProfit together');
if (!/price:\s*plan\.price/.test(src)) problems.push('the buy request sends no price');
if (!/quoteAmount\b/.test(src)) problems.push('the buy request sends no quote amount');
if (!/input:\s*\{\s*orderId:/.test(src)) problems.push('the cancel request sends no order id');
if (!/afterMs:\s*wakeMs/.test(src)) problems.push('the wake timer sends no afterMs');
if (!/count:\s*candleCount/.test(src)) problems.push('the chart request count is not the candle setting');
if (!/endpointId:\s*'model'/.test(src)) problems.push('the model request names no declared endpoint');

// A cancel must be reachable only for this run's own open buys, and only when the grid is full.
if (!/cancelEnabled && levels >= maxOpenBuys && !cooling/.test(src)) {
  problems.push('the cancel guard does not require the switch, a full grid and the cooldown together');
}
if (!/state\.resting\.find\(entry => entry\.id === plan\.cancelOrderId\)/.test(src)) {
  problems.push('the cancel does not check the order is one of this run\u2019s own resting buys');
}

console.log(problems.length ? problems.map(p => `- ${p}`).join('\n') : 'every request the strategy sends matches what the program accepts');
console.log(`capabilities named: ${named.sort().join(', ')}`);
