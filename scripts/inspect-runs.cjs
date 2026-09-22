// Breaks the module run history down: one line per run, and what inside it takes the room.
const fs = require('fs');
const path = 'C:\\Users\\rusco\\AppData\\Local\\com.antigravity.haven-defi-terminal\\haven-data.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
const key = Object.keys(data).find(k => k.includes('module_runs_v1'));
const runs = JSON.parse(data[key]);
const size = v => Buffer.byteLength(JSON.stringify(v));

console.log(`module_runs_v1: ${(size(runs) / 1024 / 1024).toFixed(2)} MB, ${Object.keys(runs).length} runs\n`);
console.log('status      runId                 modVer  events  effects   effects MB   updated');
const rows = Object.entries(runs).map(([id, run]) => ({
  id, run,
  status: run.status,
  version: run.moduleVersion,
  events: (run.events || []).length,
  effects: Object.keys(run.effects || {}).length,
  effectsBytes: size(run.effects || {}),
  eventTimes: (run.eventTimes || []).length,
  requestTimes: (run.requestTimes || []).length,
  scheduled: (run.scheduled || []).length,
  stateBytes: size(run.state ?? null),
  updatedAt: run.updatedAt,
})).sort((a, b) => b.effectsBytes - a.effectsBytes);

for (const r of rows) {
  console.log(
    `${String(r.status).padEnd(11)} ${r.id.slice(0, 20).padEnd(21)} ${String(r.version).padEnd(7)} ` +
    `${String(r.events).padStart(6)} ${String(r.effects).padStart(7)} ${(r.effectsBytes / 1024 / 1024).toFixed(2).padStart(10)} MB  ` +
    `${new Date(r.updatedAt || 0).toLocaleString()}`);
}

const biggest = rows[0];
if (biggest) {
  console.log(`\nwhat is inside the largest run's effects (${biggest.id}):`);
  const effects = Object.entries(biggest.run.effects);
  const byCapability = {};
  for (const [, effect] of effects) {
    const cap = effect?.request?.capability ?? 'unknown';
    byCapability[cap] = byCapability[cap] || { count: 0, bytes: 0 };
    byCapability[cap].count++;
    byCapability[cap].bytes += size(effect);
  }
  for (const [cap, v] of Object.entries(byCapability).sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${(v.bytes / 1024 / 1024).toFixed(2)} MB  ${String(v.count).padStart(6)} × ${cap}`);
  }
  const first = effects[0]?.[1];
  if (first) console.log(`\n  one effect looks like: ${['status', 'createdAt', 'completedAt'].map(f => `${f}=${first[f]}`).join(' ')}`);
}
