import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuthenticationCreds } from 'baileys';
import { CryptoError } from '../src/errors/app-error.js';
import { FileKeyProvider } from '../src/crypto/file-key-provider.js';
import { seal } from '../src/crypto/envelope.js';
import type { OpenParams, SealParams } from '../src/crypto/envelope.js';
import { openJson, sealJson } from '../src/crypto/json-codec.js';
import { authStateCodec, makeAuthCreds } from './fixtures/auth-creds.js';

const FIXTURE_RING_PATH = fileURLToPath(new URL('./fixtures/key-ring.dev.json', import.meta.url));

/** A `FileKeyProvider` over the fixture ring, mounted `session` only (the real worker mount). */
function makeProvider(): FileKeyProvider {
  return new FileKeyProvider({ ringPath: FIXTURE_RING_PATH, mountedPurposes: ['session'] });
}

/** Baseline seal params for a `whatsapp_instances.session_blob` record. */
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

/** Baseline open params mirroring `sealParams` (minus `encVersion`). */
function openParams(overrides: Partial<OpenParams> = {}): OpenParams {
  return {
    provider: makeProvider(),
    purpose: 'session',
    tableName: 'whatsapp_instances',
    columnName: 'session_blob',
    clientId: 'tenant-a',
    recordId: 'instance-1',
    ...overrides,
  };
}

describe('the sealJson/openJson boundary with a real baileys auth-creds object', () => {
  it('auth_state_round_trip_preserves_buffers', () => {
    const creds = makeAuthCreds();

    const blob = sealJson(creds, sealParams(), authStateCodec);
    const opened = openJson(blob, openParams(), authStateCodec) as AuthenticationCreds;

    expect(opened).toEqual(creds);

    // The double-parse bug class: a `{ type: 'Buffer', data: [...] }` plain
    // object passes a loose `toEqual`, then fails inside libsignal at send
    // time - assert per-field with `Buffer.isBuffer`, not just deep-equal.
    expect(Buffer.isBuffer(opened.noiseKey.private)).toBe(true);
    expect(Buffer.isBuffer(opened.noiseKey.public)).toBe(true);
    expect(Buffer.isBuffer(opened.signedIdentityKey.private)).toBe(true);
    expect(Buffer.isBuffer(opened.signedIdentityKey.public)).toBe(true);
    expect(Buffer.isBuffer(opened.signedPreKey.keyPair.private)).toBe(true);
    expect(Buffer.isBuffer(opened.signedPreKey.keyPair.public)).toBe(true);
    expect(Buffer.isBuffer(opened.signedPreKey.signature)).toBe(true);
  });

  it('a_double_parse_is_unrepresentable', () => {
    const creds = makeAuthCreds();

    // `openJson` hands back the object itself - never text waiting for a
    // second `JSON.parse`.
    const blob = sealJson(creds, sealParams(), authStateCodec);
    const opened = openJson(blob, openParams(), authStateCodec);
    expect(typeof opened).not.toBe('string');

    // Passing an already-serialised string into `sealJson` no longer throws
    // at seal time (a bare string is a legitimate `value` in its own right -
    // e.g. Baileys' `SignalDataTypeMap['lid-mapping']`) - but the envelope
    // still makes the double-serialise bug unrepresentable end to end:
    // `openJson` hands back that exact pre-serialised string, never silently
    // re-`JSON.parse`s it into the object it encodes.
    const preSerialised = JSON.stringify(creds, authStateCodec.replacer);
    const preSerialisedBlob = sealJson(preSerialised, sealParams(), authStateCodec);
    const preSerialisedOpened = openJson(preSerialisedBlob, openParams(), authStateCodec);
    expect(preSerialisedOpened).toBe(preSerialised);
    expect(typeof preSerialisedOpened).toBe('string');

    // Simulate a value that was double-stringified upstream before it ever
    // reached this boundary, bypassing `sealJson`'s own guard by calling the
    // lower-level `seal()` directly - `openJson` must still detect it: the
    // decrypted JSON parses down to a string, not the original object.
    const doubleStringified = JSON.stringify(preSerialised);
    const rawBlob = seal(Buffer.from(doubleStringified, 'utf8'), sealParams());
    let openCaught: unknown;
    try {
      openJson(rawBlob, openParams(), authStateCodec);
      throw new Error('expected openJson to throw');
    } catch (err) {
      openCaught = err;
    }
    expect(openCaught).toBeInstanceOf(CryptoError);
    expect((openCaught as CryptoError).code).toBe('CRYPTO_DECRYPT_FAILED');
  });
});
