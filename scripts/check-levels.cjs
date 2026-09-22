// Reproduces the strategy's level count for the case described: four filled buys, each with a
// take-profit attached, and the strategy being told those take-profits are still open.
// Prints which of the three counters each order lands in.
const text = value => (value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value));
const count = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; };

function report(label, rows, maxOpenBuys) {
  // restingBuys: open or pending with no parent
  const resting = rows
    .filter(row => !text(row.parentOrderId) && (text(row.status) === 'pending' || text(row.status) === 'open'))
    .map(row => ({ id: text(row.id), price: count(row.limitPrice) }))
    .filter(entry => entry.id && entry.price > 0);
  const held = rows.filter(row => row.status === 'fulfilled' && !row.parentOrderId && row.positionClosed !== true);
  const selling = rows.filter(row => row.status === 'pending' &&
    (row.category === 'limit_sell' || row.category === 'take_profit' || row.category === 'stop_loss'));
  const levels = resting.length + held.length + selling.length;
  console.log(`\n== ${label}`);
  console.log('   resting buys :', resting.length);
  console.log('   held         :', held.length, held.map(r => r.id).join(', '));
  console.log('   selling      :', selling.length, selling.map(r => r.id + ' [' + r.category + ']').join(', '));
  console.log('   levels       :', levels, 'of', maxOpenBuys, '→ buyingRoom', maxOpenBuys - levels);
}

const buy = n => ({ id: `buy${n}`, parentOrderId: undefined, status: 'fulfilled', category: 'limit', limitPrice: 100 - n, executedBuyAmount: '0.1', positionClosed: false });
const tp = n => ({ id: `tp${n}`, parentOrderId: `buy${n}`, status: 'open', category: 'take_profit', limitPrice: 102 - n });

// Case A: the position is still open, so its take-profit sells for it. Correct to count as a level.
report('A: position held, take-profit working', [1, 2, 3, 4].flatMap(n => [buy(n), tp(n)]), 4);

// Case B: the take-profit already sold and the position is closed. Must not count.
const soldBuy = n => ({ ...buy(n), positionClosed: true });
report('B: position closed, take-profit filled', [1, 2, 3, 4].flatMap(n => [soldBuy(n), { ...tp(n), status: 'fulfilled' }]), 4);

// Case C: position closed, but the take-profit is still reported open.
report('C: position closed, take-profit still reported open', [1, 2, 3, 4].flatMap(n => [soldBuy(n), tp(n)]), 4);

// Case D: the take-profit came back with no parent link at all.
const orphanTp = n => ({ id: `tp${n}`, parentOrderId: undefined, status: 'open', category: 'take_profit', limitPrice: 102 - n });
report('D: take-profit with no parent link', [1, 2, 3, 4].flatMap(n => [soldBuy(n), orphanTp(n)]), 4);
