// Reports what is inside the data file and how much room each part takes. Read-only.
const fs = require('fs');
const path = 'C:\\Users\\rusco\\AppData\\Local\\com.antigravity.haven-defi-terminal\\haven-data.json';

const raw = fs.readFileSync(path, 'utf8');
const data = JSON.parse(raw);
const total = Buffer.byteLength(raw);

console.log(`file: ${(total / 1024 / 1024).toFixed(2)} MB, ${Object.keys(data).length} keys\n`);

const rows = Object.entries(data).map(([key, value]) => {
  const bytes = Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
  let detail = '';
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) detail = `${parsed.length} entries`;
    else if (parsed && typeof parsed === 'object') detail = `${Object.keys(parsed).length} keys`;
  } catch { detail = `${String(value).length} chars`; }
  return { key, bytes, detail };
}).sort((a, b) => b.bytes - a.bytes);

for (const row of rows) {
  const mb = row.bytes / 1024 / 1024;
  const pct = (row.bytes / total * 100).toFixed(1);
  console.log(`${mb >= 0.01 ? mb.toFixed(2) + ' MB' : (row.bytes / 1024).toFixed(1) + ' KB'}\t${pct}%\t${row.key}\t(${row.detail})`);
}

// The largest single key, broken down one level.
const biggest = rows[0];
if (biggest && biggest.bytes / total > 0.3) {
  console.log(`\nbreaking down the largest: ${biggest.key}`);
  try {
    const parsed = typeof data[biggest.key] === 'string' ? JSON.parse(data[biggest.key]) : data[biggest.key];
    const items = Array.isArray(parsed) ? parsed.map((v, i) => [String(i), v])
      : (parsed && typeof parsed === 'object' ? Object.entries(parsed) : []);
    const inner = items.map(([k, v]) => ({ k, bytes: Buffer.byteLength(JSON.stringify(v)) })).sort((a, b) => b.bytes - a.bytes);
    for (const row of inner.slice(0, 12)) console.log(`  ${(row.bytes / 1024).toFixed(1)} KB\t${row.k}`);
    if (inner.length > 12) console.log(`  … and ${inner.length - 12} more`);
  } catch (error) { console.log('  could not break it down:', error.message); }
}
