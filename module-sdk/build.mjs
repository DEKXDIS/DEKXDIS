import { readFile, mkdir, open } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { build, transform } from 'esbuild';
import { parseStrictJson } from './strict-json.mjs';
import { signPayload, verifyEnvelope } from './package.mjs';
import { validateManifest } from './manifest.mjs';

/** Bundle author-controlled local code; the resulting artifact has no module loader. */
export async function bundleEntrypoint(entryPath, expected = 'handle') {
  const entry = resolve(entryPath);
  const result = await build({ entryPoints: [entry], absWorkingDir: dirname(entry), bundle: true,
    write: false, platform: 'neutral', format: 'esm', target: 'es2020',
    charset: 'ascii', minify: true, sourcemap: false, legalComments: 'none', metafile: true,
    logLevel: 'silent', plugins: [{ name: 'self-contained', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.kind === 'entry-point') return;
        if (!args.path.startsWith('.') && !isAbsolute(args.path)) throw new Error(`Only bundled local imports are allowed: ${args.path}`);
      });
    } }] });
  for (const output of Object.values(result.metafile.outputs)) {
    if (output.imports.length) throw new Error('Entrypoint contains unresolved imports');
    if (!output.exports.includes(expected)) {
      throw new Error(expected === 'decide'
        ? 'Entrypoint must export decide(ctx)'
        : 'Entrypoint must export handle(event, context, state)');
    }
  }
  const source = (await transform(result.outputFiles[0].text, { format: 'iife', globalName: 'dekxdisModule', target: 'es2020', charset: 'ascii', minify: true, legalComments: 'none' })).code;
  // Nonliteral dynamic imports/require cannot be resolved by bundlers. Native isolation is authoritative.
  if (/\b(?:import|require)\s*\(/.test(source)) throw new Error('Dynamic imports and runtime require are unsupported');
  return source;
}

/** Versioned artifacts are write-once. A different result needs a new module version. */
export async function writeImmutable(path, bytes) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await readFile(path)).equals(Buffer.from(bytes))) throw new Error(`Refusing to overwrite a different immutable artifact: ${path}`);
    return;
  }
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

export async function buildModule({ directory, privateKeyPath, publisherKeyId, outputPath }) {
  if (!privateKeyPath || !publisherKeyId) throw new Error('Explicit --key and --key-id are required; no publisher identity is generated');
  const root = resolve(directory);
  const manifest = validateManifest(parseStrictJson(await readFile(resolve(root, 'manifest.json'))));
  const entrypointSource = await bundleEntrypoint(resolve(root, 'index.ts'), manifest.hostApiVersion === 2 ? 'decide' : 'handle');
  let resources = {};
  try { resources = parseStrictJson(await readFile(resolve(root, 'resources.json'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const signed = signPayload({ manifest, entrypointSource, resources }, { publisherKeyId, privateKey: await readFile(privateKeyPath), validateManifest });
  const output = resolve(outputPath ?? resolve(root, 'dist', `${manifest.moduleId}-${manifest.moduleVersion}.dekxdis-module`));
  if (!output.endsWith('.dekxdis-module')) throw new Error('Output must use .dekxdis-module extension');
  await writeImmutable(output, signed.bytes);
  return { output, moduleId: manifest.moduleId, moduleVersion: manifest.moduleVersion, packageHash: signed.packageHash, assetHash: signed.assetHash, byteLength: signed.bytes.length };
}

export async function verifyModuleFile({ packagePath, publicKeyPath, publisherKeyId }) {
  if (!publicKeyPath || !publisherKeyId) throw new Error('Explicit --public-key and --key-id are required');
  return verifyEnvelope(await readFile(packagePath), { trustedKeys: { [publisherKeyId]: await readFile(publicKeyPath) }, validateManifest });
}

/** The URL must be supplied by the publisher after the corresponding asset exists. */
export function catalogEntry(verified, downloadUrl) {
  const url = new URL(downloadUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.search || url.hash || !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+\.dekxdis-module$/.test(url.pathname) || /\/(?:latest|main|master)\//i.test(decodeURIComponent(url.pathname))) throw new Error('Catalog requires an exact versioned GitHub release asset URL');
  const { manifest } = verified.payload;
  const tag = decodeURIComponent(url.pathname.split('/')[5]);
  if (!tag.includes(manifest.moduleVersion)) throw new Error('Release tag must include the exact module version');
  return { moduleId: manifest.moduleId, moduleVersion: manifest.moduleVersion, name: manifest.name,
    description: manifest.description, minimumHostVersion: manifest.minimumHostVersion,
    requestedCapabilities: manifest.requestedCapabilities, supportedChains: manifest.supportedChains,
    configuration: manifest.configurationSchema.map(({ key, label, type, required }) => ({ key, label, type, required: !!required })),
    secretSlots: manifest.secretSlots, publisherKeyId: verified.envelope.publisherKeyId,
    packageHash: verified.packageHash, assetHash: verified.assetHash, byteLength: verified.byteLength, downloadUrl: url.href };
}

export function parseArguments(argv, required, optional = []) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith('--') || ![...required, ...optional].includes(key.slice(2)) || !value || value.startsWith('--') || Object.hasOwn(result, key.slice(2))) throw new Error(`Invalid or duplicate argument: ${key}`);
    result[key.slice(2)] = value;
  }
  for (const key of required) if (!result[key]) throw new Error(`Missing --${key}`);
  return result;
}
