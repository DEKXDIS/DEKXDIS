// Builds a strategy module into an installable .dekxdis-module file.
//
//   node scripts/build-module.mjs --dir strategy-modules/llm-grid \
//     --key <private.pem> --key-id <publisherKeyId>
//
// The module's index.ts is bundled (no external imports allowed), wrapped so it defines
// dekxdisModule, then signed. The program accepts only packages signed by the publisher key
// compiled into it.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundleEntrypoint, writeImmutable } from '../module-sdk/build.mjs';
import { parseStrictJson } from '../module-sdk/strict-json.mjs';
import { signPayload, verifyEnvelope } from '../module-sdk/package.mjs';
import { validateManifest } from '../module-sdk/manifest.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args.dir || !args.key || !args['key-id'] || !args['public-key']) {
  throw new Error('Required: --dir <module folder> --key <private.pem> --key-id <id> --public-key <public.pem>');
}

const root = resolve(args.dir);
const manifest = validateManifest(parseStrictJson(await readFile(resolve(root, 'manifest.json'))));
const entrypointSource = await bundleEntrypoint(resolve(root, 'index.ts'), manifest.hostApiVersion === 2 ? 'decide' : 'handle');
let resources = {};
try { resources = parseStrictJson(await readFile(resolve(root, 'resources.json'))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const signed = signPayload({ manifest, entrypointSource, resources },
  { publisherKeyId: args['key-id'], privateKey: await readFile(resolve(args.key)), validateManifest });

const output = resolve(args.out ?? resolve(root, 'dist', `${manifest.moduleId}-${manifest.moduleVersion}.dekxdis-module`));
if (!output.endsWith('.dekxdis-module')) throw new Error('Output must use .dekxdis-module extension');
await writeImmutable(output, signed.bytes);

// Read the artifact back the way the program will, with the published public key.
const verified = verifyEnvelope(await readFile(output),
  { trustedKeys: { [args['key-id']]: await readFile(resolve(args['public-key'])) }, validateManifest });

console.log(JSON.stringify({
  output, moduleId: verified.payload.manifest.moduleId, moduleVersion: verified.payload.manifest.moduleVersion,
  hostApiVersion: verified.payload.manifest.hostApiVersion,
  packageHash: verified.packageHash, byteLength: verified.byteLength,
}, null, 2));
