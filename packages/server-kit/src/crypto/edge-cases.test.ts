import { describe, expect, it } from 'vitest';
import { CryptoError } from '../errors/app-error.js';
import { FileKeyProvider } from './file-key-provider.js';
import { seal } from './envelope.js';
import type { SealParams } from './envelope.js';
import { openJson, sealJson } from './json-codec.js';
import type { JsonCodec } from './json-codec.js';
import { fileURLToPath } from 'node:url';

/**
 * `json-codec.ts` has no dedicated test file at the src level (only
 * `test/auth-state-round-trip.test.ts`, which is baileys-dependent and lives
 * outside `src/**`, per `.dependency-cruiser.cjs`'s
 * `server-kit-src-never-imports-baileys` rule). This file exercises
 * `sealJson`/`openJson` edge cases with a hand-rolled, baileys-free codec.
 */

const FIXTURE_RING_PATH = fileURLToPath(
  new URL('../../test/fixtures/key-ring.dev.json', import.meta.url),
);

function makeProvider(): FileKeyProvider {
  return new FileKeyProvider({
    ringPath: FIXTURE_RING_PATH,
    mountedPurposes: ['session'],
  });
}

function sealParams(overrides: Partial<SealParams> = {}): SealParams {
  return {
    provider: makeProvider(),
    purpose: 'session',
    encVersion: 1,
    tableName: 'whatsapp_instances',
    columnName: 'session_blob',
    clientId: 'tenant-a',
    recordId: 'instance-1',
    ...overrides,
  };
}

function openParams(overrides: Partial<SealParams> = {}) {
  const params = sealParams(overrides);
  return {
    provider: params.provider,
    purpose: params.purpose,
    tableName: params.tableName,
    columnName: params.columnName,
    clientId: params.clientId,
    recordId: params.recordId,
  };
}

/** A minimal Buffer-aware codec, mirroring BufferJSON's shape without any baileys import. */
const bufferCodec: JsonCodec = {
  replacer: (_key, value) => {
    if (Buffer.isBuffer(value)) {
      return { type: 'Buffer', data: [...value] };
    }
    return value;
  },
  reviver: (_key, value) => {
    if (
      value !== null &&
      typeof value === 'object' &&
      (value as { type?: unknown }).type === 'Buffer' &&
      Array.isArray((value as { data?: unknown }).data)
    ) {
      return Buffer.from((value as { data: number[] }).data);
    }
    return value;
  },
};

/** The identity codec: no Buffer special-casing at all (simulates "no replacer" upstream). */
const identityCodec: JsonCodec = {
  replacer: (_key, value) => value,
  reviver: (_key, value) => value,
};

describe('json-codec edge cases (baileys-free)', () => {
  it('nested_Buffer_deep_in_an_object_round_trips_via_the_injected_codec', () => {
    const value = {
      outer: { inner: { deep: Buffer.from('deep-secret', 'utf8') } },
      list: [Buffer.from('a'), Buffer.from('b')],
    };

    const blob = sealJson(value, sealParams(), bufferCodec);
    const opened = openJson(blob, openParams(), bufferCodec) as typeof value;

    expect(Buffer.isBuffer(opened.outer.inner.deep)).toBe(true);
    expect((opened.outer.inner.deep as Buffer).equals(value.outer.inner.deep)).toBe(true);
    expect(Buffer.isBuffer(opened.list[0])).toBe(true);
    expect(Buffer.isBuffer(opened.list[1])).toBe(true);
  });

  it('a_plain_Uint8Array_that_is_NOT_a_Buffer_is_not_treated_as_one_by_the_codec', () => {
    // Buffer.isBuffer(new Uint8Array(...)) is false - a codec keyed on
    // Buffer.isBuffer will serialise a bare Uint8Array as a plain numeric
    // object instead, which is a real, sharp edge worth pinning explicitly.
    const value = { bytes: new Uint8Array([1, 2, 3]) };
    const blob = sealJson(value, sealParams(), bufferCodec);
    const opened = openJson(blob, openParams(), bufferCodec) as {
      bytes: unknown;
    };

    expect(Buffer.isBuffer(opened.bytes)).toBe(false);
    expect(opened.bytes).toEqual({ 0: 1, 1: 2, 2: 3 });
  });

  it('null_values_survive_the_round_trip', () => {
    const value = { a: null, b: 'present' };
    const blob = sealJson(value, sealParams(), bufferCodec);
    const opened = openJson(blob, openParams(), bufferCodec);
    expect(opened).toEqual({ a: null, b: 'present' });
  });

  it('undefined_object_values_are_dropped_by_JSON_stringify_not_silently_corrupted', () => {
    // Standard JSON.stringify behavior: a key whose value is `undefined` is
    // omitted from the output entirely. Pinning this here (rather than
    // assuming it) because sealJson/openJson never special-case it.
    const value = { a: undefined, b: 'present' };
    const blob = sealJson(value, sealParams(), bufferCodec);
    const opened = openJson(blob, openParams(), bufferCodec);
    expect(opened).toEqual({ b: 'present' });
    expect(Object.prototype.hasOwnProperty.call(opened, 'a')).toBe(false);
  });

  it('a_BigInt_value_throws_CryptoError_CRYPTO_ENCRYPT_FAILED_never_a_raw_TypeError', () => {
    // `JSON.stringify` throws a TypeError for BigInt; sealJson wraps
    // `JSON.stringify` in a try/catch so this never escapes as a raw
    // TypeError (whose message would otherwise enumerate the offending
    // property name(s) of the secret value).
    const value = { big: BigInt(1) };
    let caught: unknown;
    try {
      sealJson(value, sealParams(), bufferCodec);
      throw new Error('expected sealJson to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_ENCRYPT_FAILED');
    expect(String(caught)).not.toContain('big');
    expect(String(caught) + ((caught as CryptoError).stack ?? '')).not.toContain('BigInt');
  });

  it('a_circular_structure_throws_CryptoError_CRYPTO_ENCRYPT_FAILED_never_a_raw_TypeError', () => {
    // `JSON.stringify` throws a TypeError ("Converting circular structure to
    // JSON") for a circular value; sealJson must flatten this to a
    // CryptoError the same way it does for BigInt, never leaking the raw
    // TypeError (whose message enumerates the property path of the secret
    // object, e.g. "--> starting at object with constructor 'Object' | property
    // 'secretField' -> object with constructor 'Object' --- property 'self'
    // closes the circle").
    const value: { secretField: string; self?: unknown } = {
      secretField: 'SECRET_VALUE',
    };
    value.self = value;

    let caught: unknown;
    try {
      sealJson(value, sealParams(), bufferCodec);
      throw new Error('expected sealJson to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_ENCRYPT_FAILED');
    expect(String(caught)).not.toContain('secretField');
    expect(String(caught) + ((caught as CryptoError).stack ?? '')).not.toContain('SECRET_VALUE');
  });

  it('a_bare_string_value_round_trips_as_itself_not_rejected_and_not_double_parsed', () => {
    // A bare top-level string is a legitimate `value` (e.g. Baileys'
    // `SignalDataTypeMap['lid-mapping']`, a real string, never a serialised
    // artifact) - `sealJson` must accept it, and `openJson` must hand back
    // that exact string, not throw and not silently re-parse it as JSON.
    const blob = sealJson('1234567890@lid', sealParams(), bufferCodec);
    const opened = openJson(blob, openParams(), bufferCodec);
    expect(opened).toBe('1234567890@lid');
  });

  it('sealJson_still_makes_an_already_serialised_string_unrepresentable_as_a_re_parseable_string', () => {
    // Passing an already-`JSON.stringify`d string as `value` no longer
    // throws at seal time (a bare string is now a legitimate value) - but
    // the envelope makes the ORIGINAL double-parse bug still impossible:
    // `openJson` hands back that exact pre-serialised string, never
    // silently `JSON.parse`s it a second time into the object it encodes.
    const preSerialised = JSON.stringify({ a: 1 }, bufferCodec.replacer);
    const blob = sealJson(preSerialised, sealParams(), bufferCodec);
    const opened = openJson(blob, openParams(), bufferCodec);
    expect(opened).toBe(preSerialised);
    expect(typeof opened).toBe('string');
  });

  it('openJson_on_a_blob_sealed_without_a_Buffer_aware_replacer_does_not_detect_mangled_Buffers', () => {
    // Documented limitation, not a bug to fix here: sealJson's own guard only
    // catches a STRING root value. If the upstream caller used a codec with
    // no Buffer special-casing (here: identityCodec) to seal an object that
    // contains a Buffer, JSON.stringify silently turns that Buffer into a
    // plain `{ "0": ..., "1": ... , "type": "Buffer", "data": [...] }`-less
    // object (Node's default Buffer.toJSON() shape is `{type:'Buffer',
    // data:[...]}` even WITHOUT a custom replacer) - openJson's per-field
    // `Buffer.isBuffer` assertions live in the CALLER (see
    // auth-state-round-trip.test.ts), not in openJson itself, so openJson
    // happily hands back a mangled plain object with no error.
    const value = { secret: Buffer.from('mangle-me', 'utf8') };
    const blob = sealJson(value, sealParams(), identityCodec);
    const opened = openJson(blob, openParams(), identityCodec) as {
      secret: unknown;
    };

    // Mangled: NOT detected by openJson itself - it comes back as Node's
    // default `Buffer.toJSON()` shape, not a real Buffer instance.
    expect(Buffer.isBuffer(opened.secret)).toBe(false);
    expect(opened.secret).toEqual({ type: 'Buffer', data: [...value.secret] });
  });

  it('openJson_on_a_blob_sealed_from_a_raw_seal_call_with_a_JSON_string_body_detects_the_double_stringify', () => {
    const doubleStringified = JSON.stringify(JSON.stringify({ a: 1 }));
    const rawBlob = seal(Buffer.from(doubleStringified, 'utf8'), sealParams());

    let caught: unknown;
    try {
      openJson(rawBlob, openParams(), bufferCodec);
      throw new Error('expected openJson to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });

  it('openJson_on_a_blob_whose_decrypted_plaintext_is_not_JSON_throws_CryptoError_never_leaking_the_plaintext', () => {
    // `JSON.parse` throws a raw SyntaxError whose message embeds a prefix of
    // the DECRYPTED PLAINTEXT (e.g. `Unexpected token 'S', "SECRET_SES"... is
    // not valid JSON`) - openJson must wrap this so the plaintext never
    // escapes via the error's message/stack.
    const rawBlob = seal(Buffer.from('SENTINEL_PLAINTEXT_NOT_JSON', 'utf8'), sealParams());

    let caught: unknown;
    try {
      openJson(rawBlob, openParams(), bufferCodec);
      throw new Error('expected openJson to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect((caught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
    expect(String(caught) + ((caught as CryptoError).stack ?? '')).not.toContain(
      'SENTINEL_PLAINTEXT',
    );
  });
});
