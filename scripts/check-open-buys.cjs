// Reproduces the filter that decides which orders a module run is told about, then applies the
// strategy's own rules to them. The question: with four open buy orders on the chart, what does the
// strategy see, and is it offered a cancel?
const text = v => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const count = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

const scope = {
  moduleId: 'haven.llm-grid', moduleVersion: '3.3.1',
  packageHash: 'aaaa'.repeat(16), runId: 'run-current', priorPackages: [],
  chainId: 56, owner: '0xabc', token: '0xtoken',
};

// Four open buy orders, as the chart shows them. `stamp` is the identity they were placed with.
function chart(stamp) {
  return [1, 2, 3, 4].map(n => ({
    id: `buy${n}`, parentOrderId: undefined, status: 'open', orderCategory: 'limit', limitPrice: 100 - n,
    moduleId: stamp.moduleId, moduleVersion: stamp.moduleVersion, moduleHash: stamp.hash,
    moduleRunId: stamp.runId, buyToken: '0xToken', ownerAddress: '0xABC', chainId: 56,
  }));
}

function belongsTo(order, orders) {
  // Matches the program: an order is this strategy's own work on this token, whenever it was placed.
  // A manual trade carries no module identity, so it is never included.
  const known = [{ moduleVersion: scope.moduleVersion, packageHash: scope.packageHash }, ...scope.priorPackages]
    .some(p => p.moduleVersion === order.moduleVersion && p.packageHash === order.moduleHash);
  if (order.moduleId === scope.moduleId && known &&
      order.buyToken.toLowerCase() === scope.token.toLowerCase()) return true;
  const parent = orders.find(c => c.id === (order.parentOrderId || order.previousOrderId));
  return !!parent && belongsTo(parent, orders);
}

for (const [label, stamp] of [
  ['placed by this run, this version', { moduleId: 'haven.llm-grid', moduleVersion: '3.3.1', hash: scope.packageHash, runId: 'run-current' }],
  ['placed by an earlier run', { moduleId: 'haven.llm-grid', moduleVersion: '3.3.1', hash: scope.packageHash, runId: 'run-old' }],
  ['placed by an earlier module version', { moduleId: 'haven.llm-grid', moduleVersion: '2.1.1', hash: 'bbbb'.repeat(16), runId: 'run-current' }],
]) {
  const orders = chart(stamp);
  const visible = orders.filter(order => belongsTo(order, orders));
  const resting = visible.filter(row => !text(row.parentOrderId) && (text(row.status) === 'pending' || text(row.status) === 'open'));
  const levels = resting.length;
  const room = 4 - levels;
  const canCancel = room <= 0;
  console.log(`\n${label}`);
  console.log(`  orders the strategy is shown : ${visible.length} of 4`);
  console.log(`  levels it counts             : ${levels}`);
  console.log(`  cancelling offered           : ${canCancel ? 'YES' : 'no  ← "unavailable while there is room to buy"'}`);
}
