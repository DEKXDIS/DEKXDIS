// The largest stored effects, to see which kind actually costs the room.
const fs = require('fs');
const path = 'C:\\Users\\rusco\\AppData\\Local\\com.antigravity.haven-defi-terminal\\haven-data.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
const runs = JSON.parse(data[Object.keys(data).find(k => k.includes('module_runs_v1'))]);
const size = v => Buffer.byteLength(JSON.stringify(v ?? null));

const all = [];
for (const [runId, run] of Object.entries(runs)) {
  for (const [id, effect] of Object.entries(run.effects || {})) {
    all.push({ runId: runId.slice(0, 12), id, capability: effect?.request?.capability ?? '?', status: effect?.status, bytes: size(effect) });
  }
}
console.log(`${all.length} effects stored in total, ${(all.reduce((t, e) => t + e.bytes, 0) / 1024 / 1024).toFixed(2)} MB\n`);

console.log('largest:');
for (const e of [...all].sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
  console.log(`  ${(e.bytes / 1024).toFixed(1).padStart(7)} KB  ${e.capability.padEnd(22)} ${e.id}  [${e.status}]`);
}

const byCapability = {};
for (const e of all) {
  const row = byCapability[e.capability] || (byCapability[e.capability] = { count: 0, bytes: 0 });
  row.count++; row.bytes += e.bytes;
}
console.log('\ntotal by kind:');
for (const [capability, row] of Object.entries(byCapability).sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${(row.bytes / 1024 / 1024).toFixed(2).padStart(6)} MB  ${String(row.count).padStart(6)} × ${capability}  (avg ${(row.bytes / row.count / 1024).toFixed(1)} KB)`);
}

const applied = all.filter(e => e.status === 'applied');
console.log(`\nalready answered and kept anyway: ${applied.length} effects, ${(applied.reduce((t, e) => t + e.bytes, 0) / 1024 / 1024).toFixed(2)} MB`);
