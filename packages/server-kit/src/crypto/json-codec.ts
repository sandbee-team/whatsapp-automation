import { CryptoError } from '../errors/app-error.js';
import { open, seal } from './envelope.js';
import type { OpenParams, SealParams } from './envelope.js';
import type { SealedBlob } from './sealed-blob.js';

/** Placeholder kekId for a failure at the JSON boundary itself, before any key is ever touched. */
const BOUNDARY_KEK_ID = 'boundary';

/**
 * Codec-injected JSON (de)serialisation, supplied by the caller - e.g.
 * Baileys' own `BufferJSON.replacer`/`.reviver` for auth-state blobs. Keeping
 * this injected (rather than baked into `sealJson`/`openJson`) is what lets
 * `@wp/server-kit` never import Baileys at runtime: the package knows only
 * that *some* replacer/reviver pair exists, never that Buffers need special
 * `{type:'Buffer',data:[...]}` handling - that knowledge stays entirely in
 * the caller-supplied codec.
 */
export type JsonCodec = {
  replacer: (key: string, value: unknown) => unknown;
  reviver: (key: string, value: unknown) => unknown;
};

/**
 * The wire shape actually written by `sealJson`/read by `openJson`: `value`
 * is always nested one level down inside a fixed-shape envelope, never
 * `JSON.stringify`d at the top level on its own. This is what makes a bare
 * top-level STRING a legitimate, representable `value` (e.g. Baileys'
 * `SignalDataTypeMap['lid-mapping']`, a real `string`, not a serialised
 * artifact) while still making evolution-api's double-parse bug (a value
 * serialised twice before it ever reaches storage) unrepresentable: an
 * already-serialised string passed as `value` becomes `env.v` unchanged - it
 * comes back out of `openJson` as that same string, never silently
 * re-`JSON.parse`d a second time. The envelope key is namespaced so it can
 * never collide with a real Baileys/domain field name.
 */
interface JsonEnvelope {
  __wp_sealed_json_v: 1;
  v: unknown;
}

/**
 * The ONE serialisation boundary in the seal direction: wraps `value` in the
 * fixed `JsonEnvelope` shape, `JSON.stringify`s that with `codec.replacer`,
 * then seals the resulting UTF-8 bytes via `seal()`.
 */
export function sealJson(value: unknown, params: SealParams, codec: JsonCodec): SealedBlob {
  const envelope: JsonEnvelope = { __wp_sealed_json_v: 1, v: value };
  let json: string;
  try {
    json = JSON.stringify(envelope, codec.replacer);
  } catch {
    // `JSON.stringify` throws a raw `TypeError` for a circular structure or a
    // BigInt value - and that TypeError's own message enumerates the
    // offending property path/name(s) of `value`, which may itself be the
    // secret being sealed. Flattened to `CryptoError` (no `cause`, per
    // `CryptoError`'s contract) so nothing of `value`'s shape ever leaks into
    // a thrown error's message or stack.
    throw new CryptoError('CRYPTO_ENCRYPT_FAILED', BOUNDARY_KEK_ID);
  }
  return seal(Buffer.from(json, 'utf8'), params);
}

/**
 * The ONE deserialisation boundary in the open direction: `open()`s `blob`,
 * then `JSON.parse`s the resulting UTF-8 text with `codec.reviver` EXACTLY
 * once, and unwraps the `JsonEnvelope` - the returned value is `env.v`
 * itself, never a string waiting for a second `JSON.parse`. If the decrypted
 * JSON does not parse down to a well-formed `JsonEnvelope` (no
 * `__wp_sealed_json_v` marker), that can only mean the plaintext was not
 * produced by `sealJson` at all - e.g. a value double-stringified upstream
 * before it ever reached `sealJson`, or `seal()` called directly on raw JSON
 * text - detected here, never silently handed back for another parse -
 * throws `CryptoError('CRYPTO_DECRYPT_FAILED', blob.kek_id)`.
 */
export function openJson(blob: SealedBlob, params: OpenParams, codec: JsonCodec): unknown {
  const plaintext = open(blob, params);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'), codec.reviver);
  } catch {
    // `JSON.parse` throws a raw `SyntaxError` for non-JSON input - and that
    // SyntaxError's own message embeds a prefix of the DECRYPTED PLAINTEXT
    // (e.g. `Unexpected token 'S', "SECRET_SES"... is not valid JSON`).
    // Flattened to `CryptoError` (no `cause`, per `CryptoError`'s contract,
    // matching `envelope.ts`'s `open()`/`seal()`) so the plaintext never
    // escapes via a thrown error's message or stack.
    throw new CryptoError('CRYPTO_DECRYPT_FAILED', blob.kek_id);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { __wp_sealed_json_v?: unknown }).__wp_sealed_json_v !== 1
  ) {
    throw new CryptoError('CRYPTO_DECRYPT_FAILED', blob.kek_id);
  }
  return (parsed as JsonEnvelope).v;
}
