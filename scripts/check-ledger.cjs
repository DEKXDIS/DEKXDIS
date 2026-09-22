// The strategy's ledger, fed the order report exactly as the program produces it:
// a filled buy carrying a bracket, and its take-profit as a separate child order.
// Prints how many levels the strategy ends up believing are in use.
const text = value => (value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value));
const count = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; };

const rows = [];
for (const n of [1, 2, 3, 4]) {
  rows.push({
    id: `buy${n}`, parentOrderId: undefined, status: 'fulfilled', category: 'limit',
    limitPrice: 100 - n, takeProfitPrice: 102 - n, executedBuyAmount: '0.1', positionClosed: false,
  });
  rows.push({
    id: `tp${n}`, parentOrderId: `buy${n}`, status: 'open', category: 'take_profit', limitPrice: 102 - n,
  });
}

const held = {};
const selling = {};
const seen = {};

for (const row of rows) {
  const id = text(row.id);
  const status = text(row.status);
  const parent = text(row.parentOrderId);
  if (!parent) {
    if (status === 'fulfilled' && count(row.executedBuyAmount) > 0 && !held[id] && !Object.values(selling).some(e => e.from === id)) {
      held[id] = { quantity: count(row.executedBuyAmount), price: count(row.executionPrice) || count(row.limitPrice) };
    }
    if (row.positionClosed === true) delete held[id];
    continue;
  }
  if (status === 'fulfilled') { const c = selling[id]; if (c) delete held[c.from]; delete selling[id]; continue; }
  if (status === 'cancelled' || status === 'expired' || status === 'failed') {
    const c = selling[id]; if (c) { held[c.from] = { quantity: c.quantity, price: c.price }; delete selling[id]; } continue;
  }
  if (!selling[id] && held[parent]) { selling[id] = { ...held[parent], from: parent }; delete held[parent]; }
}

const resting = [];
const levels = resting.length + Object.keys(held).length + Object.keys(selling).length;
console.log('held   :', Object.keys(held).join(', ') || '(none)');
console.log('selling:', Object.keys(selling).join(', ') || '(none)');
console.log('levels :', levels, 'of 4  → buyingRoom', 4 - levels);
