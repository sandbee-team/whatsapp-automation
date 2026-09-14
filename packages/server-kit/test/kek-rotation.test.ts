import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FileKeyProvider } from '../src/crypto/file-key-provider.js';
import { open } from '../src/crypto/envelope.js';
import type { OpenParams, SealParams } from '../src/crypto/envelope.js';
import { sealJson } from '../src/crypto/json-codec.js';
import { rewrapDek } from '../src/crypto/rotate.js';
import { authStateCodec, makeAuthCreds } from './fixtures/auth-creds.js';

const FIXTURE_RING_PATH = fileURLToPath(new URL('./fixtures/key-ring.dev.json', import.meta.url));

/**
 * The fixture ring (`key-ring.dev.json`) already has `k1` RETIRED and `k2`
 * ACTIVE for `session` - the post-rotation state. To produce a blob "sealed
 * under k1" (the pre-rotation timeline this test rotates away from), this
 * builds a second ring where `k1` is ACTIVE, using the exact same
 * deterministic material the fixture ring's `k1` entry uses
 * (`Buffer.alloc(32, 0x01)`) - so `rewrapDek` against the real fixture ring
 * afterwards is unwrapping the very same key bytes, just via a `retired`
 * entry instead of an active one.
 */
function writeTempRing(ring: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-kek-rotation-ring-'));
  const path = join(dir, 'key-ring.json');
  writeFileSync(path, JSON.stringify(ring), 'utf8');
  return path;
}

function makeSealTimeProvider(): FileKeyProvider {
  const k1Material = Buffer.alloc(32, 0x01).toString('base64');
  const tsMaterial = Buffer.alloc(32, 0x03).toString('base64');
  const usMaterial = Buffer.alloc(32, 0x04).toString('base64');

  const ringPath = writeTempRing({
    version: 1,
    active: {
      session: 'k1',
      'tenant-secrets': 'k3',
      'user-secrets': 'k4',
      'optout-pepper': 'k5',
      'api-key-pepper': 'k6',
    },
    keys: {
      k1: { purpose: 'session', material: k1Material, created_at: '2026-01-01T00:00:00.000Z' },
      k3: {
        purpose: 'tenant-secrets',
        material: tsMaterial,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      k4: { purpose: 'user-secrets', material: usMaterial, created_at: '2026-01-01T00:00:00.000Z' },
      k5: {
        purpose: 'optout-pepper',
        material: usMaterial,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      k6: {
        purpose: 'api-key-pepper',
        material: usMaterial,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    },
  });
  return new FileKeyProvider({ ringPath, mountedPurposes: ['session'] });
}

/** The standard fixture ring: `k1` retired, `k2` active for `session` - post-rotation. */
function makeFixtureProvider(): FileKeyProvider {
  return new FileKeyProvider({ ringPath: FIXTURE_RING_PATH, mountedPurposes: ['session'] });
}

function sealParams(provider: FileKeyProvider): SealParams {
  return {
    provider,
    purpose: 'session',
    encVersion: 1,
    tableName: 'whatsapp_instances',
    columnName: 'session_blob',
    clientId: 'tenant-a',
    recordId: 'instance-1',
  };
}

function openParams(provider: FileKeyProvider): OpenParams {
  return {
    provider,
    purpose: 'session',
    tableName: 'whatsapp_instances',
    columnName: 'session_blob',
    clientId: 'tenant-a',
    recordId: 'instance-1',
  };
}

describe('kek rotation over a real baileys auth-creds blob', () => {
  it('kek_rotation_preserves_decryptability', () => {
    const creds = makeAuthCreds();

    // Pre-rotation timeline: seal while `k1` is active.
    const sealTimeProvider = makeSealTimeProvider();
    const blob = sealJson(creds, sealParams(sealTimeProvider), authStateCodec);
    expect(blob.kek_id).toBe('k1');

    const plaintextBefore = open(blob, openParams(sealTimeProvider));

    // Rotation: `k1` retires, `k2` becomes active - the standard fixture ring.
    const fixtureProvider = makeFixtureProvider();
    const rotated = rewrapDek(blob, 'k2', { provider: fixtureProvider, purpose: 'session' });

    expect(rotated.kek_id).toBe('k2');

    // Record layer is byte-identical - rotation only ever touches the
    // wrapped-DEK layer.
    expect(rotated.ciphertext.equals(blob.ciphertext)).toBe(true);
    expect(rotated.iv.equals(blob.iv)).toBe(true);
    expect(rotated.auth_tag.equals(blob.auth_tag)).toBe(true);

    // Only the wrapped-DEK layer changed.
    expect(rotated.dek_wrapped.equals(blob.dek_wrapped)).toBe(false);
    expect(rotated.dek_iv.equals(blob.dek_iv)).toBe(false);
    expect(rotated.dek_tag.equals(blob.dek_tag)).toBe(false);

    // The rotated blob opens to byte-identical plaintext, via a provider
    // that mounts `session` only (matches the real worker-only mount).
    const plaintextAfter = open(rotated, openParams(fixtureProvider));
    expect(plaintextAfter.equals(plaintextBefore)).toBe(true);
  });
});
