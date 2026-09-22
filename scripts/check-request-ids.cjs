// Checks every request id the strategy builds against the program's rule:
// starts alphanumeric, then A-Za-z0-9 . _ - : and no more than 120 characters in total.
const fs = require('fs');
const src = fs.readFileSync('strategy-modules/llm-grid/index.ts', 'utf8');

const pattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const kinds = [...src.matchAll(/id: `([a-z]+):\$\{cycle\}`/g)].map(match => match[1]);
console.log('request kinds built from the event id:', kinds.join(', '));

// The event ids the program itself produces, including the longest forms.
const events = [
  'start',
  'timer:0:1730000000000',
  'timer:15:1730000000000',
  'candle-close:1:1730000000000',
  'price:0:1730000000000',
  'recovery:1730000000000',
  'ui:123e4567-e89b-12d3-a456-426614174000',
  'scheduled:timer:0:1730000000000',
];

let bad = 0;
for (const event of events) {
  for (const kind of kinds) {
    const id = `${kind}:${event}`;
    if (!pattern.test(id)) { console.log('REJECTED:', id, `${id.length} chars`); bad++; }
  }
}
console.log(bad ? `${bad} ids would be rejected` : 'every id is legal and inside the length limit');
