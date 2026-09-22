// What the pruning does to a run's saved effects over a day of one-minute cycles.
// Mirrors the rule in hostEngine.ts: keep the most recent KEEP_ANSWERED finished requests, drop
// anything older, and drop an interrupted dispatch once it stops needing review.
const KEEP_ANSWERED = 32;
const AMBIGUOUS_MS = 24 * 60 * 60 * 1000;

function simulate(cycles, bytesPerCycle) {
  const effects = {};
  let now = 1_700_000_000_000;
  for (let cycle = 0; cycle < cycles; cycle++) {
    now += 60_000;
    // one cycle: orders.observe, chart, model  (the answered ones)
    for (const kind of ['orders', 'chart', 'model']) {
      const id = `${kind}:${cycle}`;
      effects[id] = { request: { id, capability: kind }, status: 'applied', createdAt: now, completedAt: now, bytes: bytesPerCycle };
    }
    // the prune that runs after each handled event
    const finished = Object.values(effects).filter(e => e.status === 'applied' || e.status === 'ambiguous');
    const stale = finished.filter(e => e.status === 'ambiguous' && now - e.createdAt > AMBIGUOUS_MS);
    const rest = finished.filter(e => !stale.includes(e)).sort((a, b) => b.completedAt - a.completedAt);
    for (const e of [...stale, ...rest.slice(KEEP_ANSWERED)]) delete effects[e.request.id];
  }
  return Object.keys(effects).length;
}

const perCycleKB = 5.8 + 6.6 + 0.7;   // the measured averages: order read, model call, chart
console.log(`one cycle stores about ${perCycleKB.toFixed(1)} KB of answers\n`);
console.log('cycles   kept      old size      new size');
for (const cycles of [60, 240, 1440, 14400]) {
  const kept = simulate(cycles, perCycleKB * 1024);
  const beforeKB = cycles * perCycleKB;
  const afterKB = kept * perCycleKB;
  const show = kb => kb > 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${kb.toFixed(1)} KB`;
  console.log(`${String(cycles).padStart(6)}   ${String(kept).padStart(4)}   ${show(beforeKB).padStart(11)}   ${show(afterKB).padStart(10)}`);
}
