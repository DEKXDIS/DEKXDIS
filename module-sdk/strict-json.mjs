/** Duplicate properties and excessive nesting are errors, including escaped duplicate keys. */
export function parseStrictJson(input, { maxBytes = 2 * 1024 * 1024, maxDepth = 32 } = {}) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.length > maxBytes) throw new Error('JSON exceeds byte limit');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let at = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[at] ?? '\0')) at++; };
  const fail = message => { throw new Error(`${message} at byte ${Buffer.byteLength(source.slice(0, at))}`); };
  const string = () => {
    const start = at++;
    while (at < source.length) {
      const next = source[at++];
      if (next === '\\') { at++; continue; }
      if (next === '"') {
        const value = JSON.parse(source.slice(start, at));
        // Rust/UTF-8 payloads cannot preserve lone UTF-16 surrogates.
        if (/[\uD800-\uDFFF]/u.test(value)) fail('Unpaired Unicode surrogate');
        return value;
      }
    }
    fail('Unterminated JSON string');
  };
  const value = depth => {
    if (depth > maxDepth) fail('JSON exceeds depth limit');
    whitespace();
    if (source[at] === '"') return string();
    if (source[at] === '{') {
      at++; whitespace();
      const object = Object.create(null);
      if (source[at] === '}') { at++; return object; }
      for (;;) {
        whitespace();
        if (source[at] !== '"') fail('Expected property name');
        const key = string();
        if (Object.hasOwn(object, key)) fail(`Duplicate JSON property ${key}`);
        whitespace();
        if (source[at++] !== ':') fail('Expected colon');
        object[key] = value(depth + 1);
        whitespace();
        const separator = source[at++];
        if (separator === '}') return object;
        if (separator !== ',') fail('Expected comma or closing brace');
      }
    }
    if (source[at] === '[') {
      at++; whitespace();
      const array = [];
      if (source[at] === ']') { at++; return array; }
      for (;;) {
        array.push(value(depth + 1)); whitespace();
        const separator = source[at++];
        if (separator === ']') return array;
        if (separator !== ',') fail('Expected comma or closing bracket');
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(literal, at)) { at += literal.length; return result; }
    }
    const match = source.slice(at).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) fail('Expected JSON value');
    at += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) fail('Non-finite JSON number');
    return number;
  };
  const result = value(0);
  whitespace();
  if (at !== source.length) fail('Unexpected trailing input');
  return result;
}
