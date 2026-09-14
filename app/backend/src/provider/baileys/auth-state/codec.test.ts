import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { createAuthCodec } from './codec.js';
import type { AuthRecordRef } from './codec.js';

/** Writes an ad-hoc key-ring JSON object to a fresh temp file, returns its path. */
function writeTempRing(ring: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-auth-codec-ring-'));
  const path = join(dir, 'key-ring.json');
  writeFileSync(path, JSON.stringify(ring), 'utf8');
  return path;
}

/** A minimal, valid key ring mounting only the `session` purpose. */
function makeSessionRing(): string {
  const material = Buffer.alloc(32, 0x07).toString('base64');
  return writeTempRing({
    version: 1,
    active: {
      session: 'k1',
      'tenant-secrets': 'ts1',
      'user-secrets': 'us1',
      'optout-pepper': 'op1',
      'api-key-pepper': 'akp1',
    },
    keys: {
      k1: { purpose: 'session', material, created_at: '2026-01-01T00:00:00.000Z' },
      ts1: { purpose: 'tenant-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
      us1: { purpose: 'user-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
      op1: { purpose: 'optout-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
      akp1: { purpose: 'api-key-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
    },
  });
}

function makeProvider(): FileKeyProvider {
  return new FileKeyProvider({ ringPath: makeSessionRing(), mountedPurposes: ['session'] });
}

const REF: AuthRecordRef = {
  table: 'whatsapp_instances',
  column: 'auth_state',
  clientId: 'tenant-a',
  recordId: 'record-1',
};

describe('createAuthCodec', () => {
  it('seals_and_opens_a_round_trip_including_buffer_and_uint8array_values', () => {
    const codec = createAuthCodec({ provider: makeProvider(), encVersion: 1 });

    const buf = Buffer.from('some auth key material', 'utf8');
    const arr = new Uint8Array([1, 2, 3, 4, 5]);
    const value = {
      keyId: 'abc',
      keyPair: { public: buf, private: buf },
      raw: arr,
      nested: { deeper: [buf, arr] },
    };

    const blob = codec.sealAuthValue(value, REF);
    const opened = codec.openAuthValue(blob, REF) as typeof value;

    expect(opened.keyId).toBe(value.keyId);
    expect(Buffer.isBuffer(opened.keyPair.public)).toBe(true);
    expect((opened.keyPair.public as Buffer).equals(buf)).toBe(true);
    expect(Buffer.isBuffer(opened.keyPair.private)).toBe(true);
    expect((opened.keyPair.private as Buffer).equals(buf)).toBe(true);
    expect(Buffer.isBuffer(opened.raw)).toBe(true);
    expect((opened.raw as unknown as Buffer).equals(Buffer.from(arr))).toBe(true);
    expect(Buffer.isBuffer((opened.nested.deeper as unknown[])[0])).toBe(true);
  });

  it('encode_decode_round_trips_a_sealed_blob_into_one_opaque_buffer', () => {
    const codec = createAuthCodec({ provider: makeProvider(), encVersion: 1 });
    const blob = codec.sealAuthValue({ a: 1 }, REF);

    const encoded = codec.encodeSealedBlob(blob);
    expect(Buffer.isBuffer(encoded)).toBe(true);

    const decoded = codec.decodeSealedBlob(encoded);
    expect(decoded).toEqual(blob);

    const opened = codec.openAuthValue(decoded, REF);
    expect(opened).toEqual({ a: 1 });
  });
});
