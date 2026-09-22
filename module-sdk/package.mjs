import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { parseStrictJson } from './strict-json.mjs';

export const PACKAGE_LIMITS = Object.freeze({ envelopeBytes: 2 * 1024 * 1024, payloadBytes: 1024 * 1024, sourceBytes: 512 * 1024, depth: 32 });
const DOMAIN = Buffer.from('HAVEN-MODULE\0', 'utf8');
const KEY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const u32 = value => { const result = Buffer.alloc(4); result.writeUInt32BE(value); return result; };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function signingBytes(formatVersion, publisherKeyId, payload) {
  if (formatVersion !== 1) throw new Error('Unsupported package format version');
  if (typeof publisherKeyId !== 'string' || !KEY_ID.test(publisherKeyId)) throw new Error('Invalid publisher key ID');
  const keyId = Buffer.from(publisherKeyId, 'utf8');
  return Buffer.concat([DOMAIN, u32(formatVersion), u32(keyId.length), keyId, u32(payload.length), payload]);
}

export function exactKeys(object, expected, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(object).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
}

function base64(value, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`${label} must be canonical base64`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error(`${label} must be canonical base64`);
  return decoded;
}

export function decodePayload(bytes, validateManifest) {
  const payload = parseStrictJson(bytes, { maxBytes: PACKAGE_LIMITS.payloadBytes, maxDepth: PACKAGE_LIMITS.depth });
  exactKeys(payload, ['manifest', 'entrypointSource', 'resources'], 'Payload');
  if (typeof payload.entrypointSource !== 'string' || !payload.entrypointSource.trim() || payload.entrypointSource.includes('\0') || Buffer.byteLength(payload.entrypointSource) > PACKAGE_LIMITS.sourceBytes) throw new Error('Entrypoint source is invalid or exceeds source limit');
  if (!payload.resources || typeof payload.resources !== 'object' || Array.isArray(payload.resources)) throw new Error('Resources must be a declarative JSON object');
  if (Object.keys(payload.resources).length > 32 || Object.keys(payload.resources).some(key => !/^[a-zA-Z0-9._-]{1,96}$/.test(key))) throw new Error('Resources require at most 32 bounded identifiers');
  if (Buffer.byteLength(JSON.stringify(payload.resources)) > 32 * 1024) throw new Error('Declarative resources exceed 32 KiB');
  validateManifest?.(payload.manifest);
  return payload;
}

/** No keys are generated here. The caller must supply a publisher-controlled PKCS8 key. */
export function signPayload(payloadInput, { publisherKeyId, privateKey, validateManifest }) {
  const payloadBytes = Buffer.isBuffer(payloadInput) ? payloadInput : Buffer.from(JSON.stringify(payloadInput), 'utf8');
  decodePayload(payloadBytes, validateManifest);
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Publisher private key must be Ed25519');
  const envelope = { formatVersion: 1, publisherKeyId, base64Payload: payloadBytes.toString('base64'), signature: sign(null, signingBytes(1, publisherKeyId, payloadBytes), key).toString('base64') };
  const bytes = Buffer.from(JSON.stringify(envelope) + '\n', 'utf8');
  if (bytes.length > PACKAGE_LIMITS.envelopeBytes) throw new Error('Package exceeds envelope limit');
  return { bytes, envelope, packageHash: sha256(payloadBytes), assetHash: sha256(bytes) };
}

/** Trust roots come from the caller, never from a package-supplied public key. */
export function verifyEnvelope(input, { trustedKeys, validateManifest } = {}) {
  const bytes = Buffer.from(input);
  const envelope = parseStrictJson(bytes, { maxBytes: PACKAGE_LIMITS.envelopeBytes, maxDepth: PACKAGE_LIMITS.depth });
  exactKeys(envelope, ['formatVersion', 'publisherKeyId', 'base64Payload', 'signature'], 'Envelope');
  const payloadBytes = base64(envelope.base64Payload, 'Payload');
  if (payloadBytes.length > PACKAGE_LIMITS.payloadBytes) throw new Error('Payload exceeds byte limit');
  const signedBytes = signingBytes(envelope.formatVersion, envelope.publisherKeyId, payloadBytes);
  if (!trustedKeys || !Object.hasOwn(trustedKeys, envelope.publisherKeyId)) throw new Error(`Untrusted publisher key: ${envelope.publisherKeyId}`);
  const key = createPublicKey(trustedKeys[envelope.publisherKeyId]);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Publisher public key must be Ed25519');
  const signature = base64(envelope.signature, 'Signature');
  if (signature.length !== 64 || !verify(null, signedBytes, key, signature)) throw new Error('Invalid module signature');
  return { envelope, payload: decodePayload(payloadBytes, validateManifest), packageHash: sha256(payloadBytes), assetHash: sha256(bytes), byteLength: bytes.length };
}
