// What the strategy tells the model about cancelling, given a full grid of positions whose take
// profits are working — the situation being run right now.
const text = v => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const count = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

const MAX = 4;
const CANCEL_ENABLED = true;
const COOLDOWN = 5;

const rows = [];
for (const n of [1, 2, 3, 4]) {
  rows.push({ id: `buy${n}`, parentOrderId: undefined, status: 'fulfilled', category: 'limit', limitPrice: 100 - n, executedBuyAmount: '0.1', positionClosed: false });
  rows.push({ id: `tp${n}`, parentOrderId: `buy${n}`, status: 'open', category: 'take_profit', limitPrice: 102 - n });
}

// the ledger, as the strategy builds it
const held = {}, selling = {};
for (const row of rows) {
  const id = text(row.id), status = text(row.status), parent = text(row.parentOrderId);
  if (!parent) { if (status === 'fulfilled' && count(row.executedBuyAmount) > 0) held[id] = { quantity: count(row.executedBuyAmount), price: count(row.limitPrice) }; continue; }
  if (status === 'fulfilled') { const c = selling[id]; if (c) delete held[c.from]; delete selling[id]; continue; }
  if (status === 'cancelled' || status === 'expired' || status === 'failed') { const c = selling[id]; if (c) { held[c.from] = { quantity: c.quantity, price: c.price }; delete selling[id]; } continue; }
  if (!selling[id] && held[parent]) { selling[id] = { ...held[parent], from: parent }; delete held[parent]; }
}

const resting = rows.filter(r => !text(r.parentOrderId) && (text(r.status) === 'pending' || text(r.status) === 'open'));
const levels = resting.length + Object.keys(held).length;
const room = MAX - levels;
const cooling = false;
const canCancel = CANCEL_ENABLED && room <= 0 && !cooling;

console.log('positions with a take profit working :', Object.keys(selling).length, '(not counted as levels)');
console.log('levels the strategy counts           :', levels, 'of', MAX);
console.log('room it tells the model              :', room);
console.log('cancelling offered to the model      :', canCancel ? 'YES' : 'NO');
console.log('\nthe line the model receives:');
console.log('  ' + (!CANCEL_ENABLED ? 'Canceling is OFF.'
  : canCancel ? 'Canceling is ON. You may cancel ONE of your open buys this cycle…'
  : room > 0 ? 'Canceling is unavailable while there is room to buy. Place your buy, or wait.'
  : `Canceling is ON but resting this cycle: ${COOLDOWN} cycles must pass between cancels.`));
