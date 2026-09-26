import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['tests/llm-ui.fixture.tsx'], bundle: true, write: false, format: 'esm', platform: 'browser',
  plugins: [{ name: 'native-fixture', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'native-fixture', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const invoke = (name, args) => globalThis.__llmInvoke(name, args);' }));
  } }] });
const css = await readFile('tests/.llm-ui.css');
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM configuration fixture</title><link rel="stylesheet" href="/style.css"></head><body style="background:#080c18"><pre id="results" style="color:#a5f3fc;white-space:pre-wrap;margin:12px"></pre><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : req.url === '/style.css' ? 'text/css' : 'text/html');
  res.end(req.url === '/fixture.js' ? result.outputFiles[0].text : req.url === '/style.css' ? css : html);
}).listen(5188, '127.0.0.1', () => console.log('LLM fixture ready at http://127.0.0.1:5188'));
