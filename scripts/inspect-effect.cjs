// Prints one stored effect in full, with the size of each part, to see what is actually in there.
const fs = require('fs');
const path = 'C:\\Users\\rusco\\AppData\\Local\\com.antigravity.haven-defi-terminal\\haven-data.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
const runs = JSON.parse(data[Object.keys(data).find(k => k.includes('module_runs_v1'))]);
const size = v => Buffer.byteLength(JSON.stringify(v ?? null));

const biggest = Object.entries(runs).sort((a, b) => size(b[1].effects) - size(a[1].effects))[0];
const effects = Object.entries(biggest[1].effects);

for (const capability of ['orders.observe.v1', 'http.request.v1', 'chart.snapshot.v1']) {
  const entry = effects.find(([, e]) => e?.request?.capability === capability);
  if (!entry) continue;
  const [id, effect] = entry;
  console.log(`\n=== ${capability}   id=${id}`);
  console.log(`  whole effect : ${(size(effect) / 1024).toFixed(1)} KB`);
  console.log(`  request      : ${(size(effect.request) / 1024).toFixed(1)} KB`);
  console.log(`  result       : ${(size(effect.result) / 1024).toFixed(1)} KB`);
  console.log(`  status       : ${effect.status}`);

  const result = effect.result;
  if (result && typeof result === 'object') {
    console.log('  result keys  :', Object.keys(result).join(', '));
    for (const [k, v] of Object.entries(result)) {
      const bytes = size(v);
      if (bytes > 512) console.log(`    ${(bytes / 1024).toFixed(1)} KB  ${k}  (${Array.isArray(v) ? v.length + ' items' : typeof v})`);
    }
    if (Array.isArray(result.orders) && result.orders[0]) {
      const first = result.orders[0];
      console.log('  one order row:', Object.keys(first).join(', '));
      console.log('  row size     :', (size(first) / 1024).toFixed(2), 'KB');
    }
  }
}

console.log(`\nlargest single effect in this run: ${(Math.max(...effects.map(([, e]) => size(e))) / 1024).toFixed(1)} KB`);
