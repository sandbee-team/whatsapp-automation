import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { hashRecipient } from './phone-hash.js';

/**
 * phone-hash.test.ts (P14 Unit U3, step 2; MOVED in P20 Unit U2 step 3 from
 * `modules/pacing/optout/hash.test.ts`) - `hashRecipient` unit tests. Only
 * `@wp/server-kit/crypto` is imported (not the config singleton at
 * `@wp/server-kit`'s root), so this file does NOT need the
 * `stub-wp-server-kit-env.js` first-import guard - same as
 * `provider/baileys/auth-state/codec.test.ts`'s established precedent.
 */

/** Writes an ad-hoc key-ring JSON object to a fresh temp file, returns its path. */
function writeTempRing(ring: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-optout-hash-ring-'));
  const path = join(dir, 'key-ring.json');
  writeFileSync(path, JSON.stringify(ring), 'utf8');
  return path;
}

/** A minimal, valid key ring mounting every purpose, with `optout-pepper` set to `pepperByte`. */
function makeProvider(pepperByte: number): KeyProvider {
  const sessionMaterial = Buffer.alloc(32, 0x01).toString('base64');
  const tsMaterial = Buffer.alloc(32, 0x02).toString('base64');
  const usMaterial = Buffer.alloc(32, 0x03).toString('base64');
  const pepperMaterial = Buffer.alloc(32, pepperByte).toString('base64');

  const ringPath = writeTempRing({
    version: 1,
    active: {
      session: 'k1',
      'tenant-secrets': 'k2',
      'user-secrets': 'k3',
      'optout-pepper': 'k4',
      'api-key-pepper': 'k5',
    },
    keys: {
      k1: { purpose: 'session', material: sessionMaterial, created_at: '2026-01-01T00:00:00.000Z' },
      k2: {
        purpose: 'tenant-secrets',
        material: tsMaterial,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      k3: { purpose: 'user-secrets', material: usMaterial, created_at: '2026-01-01T00:00:00.000Z' },
      k4: {
        purpose: 'optout-pepper',
        material: pepperMaterial,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      k5: {
        purpose: 'api-key-pepper',
        material: usMaterial,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    },
  });

  return new FileKeyProvider({ ringPath, mountedPurposes: ['optout-pepper'] });
}

describe('hashRecipient', () => {
  it('is_stable_for_the_same_value_and_pepper', () => {
    const provider = makeProvider(0x09);
    const first = hashRecipient(provider, '+15550001111');
    const second = hashRecipient(provider, '+15550001111');
    expect(first.equals(second)).toBe(true);
  });

  it('produces_different_hashes_for_different_values', () => {
    const provider = makeProvider(0x09);
    const a = hashRecipient(provider, '+15550001111');
    const b = hashRecipient(provider, '+15550002222');
    expect(a.equals(b)).toBe(false);
  });

  it('produces_different_hashes_for_different_peppers', () => {
    const providerA = makeProvider(0x09);
    const providerB = makeProvider(0x0a);
    const a = hashRecipient(providerA, '+15550001111');
    const b = hashRecipient(providerB, '+15550001111');
    expect(a.equals(b)).toBe(false);
  });

  it('hashes_a_group_jid_the_same_way_as_an_e164_string', () => {
    const provider = makeProvider(0x09);
    const groupJid = '123456789-987654321@g.us';
    const first = hashRecipient(provider, groupJid);
    const second = hashRecipient(provider, groupJid);
    expect(first.equals(second)).toBe(true);
    expect(first.length).toBe(32); // HMAC-SHA256 output length
  });
});
