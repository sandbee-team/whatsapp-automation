import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { hashRecipient } from './phone-hash.js';

/**
 * phone-hash-edge.test.ts (P14 E3 edge pass; MOVED in P20 Unit U2 step 3 from
 * `modules/pacing/optout/hash-edge.test.ts`) - `hashRecipient` input edges
 * not covered by phone-hash.test.ts: empty-string input, a very long input,
 * and identical output across two SEPARATE `KeyProvider` instances
 * constructed from the same on-disk key ring (proves the pepper's stability
 * comes from the ring file, not from any in-process caching quirk of one
 * provider instance).
 */

function writeTempRing(ring: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-optout-hash-edge-ring-'));
  const path = join(dir, 'key-ring.json');
  writeFileSync(path, JSON.stringify(ring), 'utf8');
  return path;
}

function ringConfig(pepperByte: number): unknown {
  const sessionMaterial = Buffer.alloc(32, 0x01).toString('base64');
  const tsMaterial = Buffer.alloc(32, 0x02).toString('base64');
  const usMaterial = Buffer.alloc(32, 0x03).toString('base64');
  const pepperMaterial = Buffer.alloc(32, pepperByte).toString('base64');
  return {
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
  };
}

function makeProvider(ringPath: string): KeyProvider {
  return new FileKeyProvider({ ringPath, mountedPurposes: ['optout-pepper'] });
}

describe('hashRecipient edge cases', () => {
  it('hashes_an_empty_string_input_deterministically', () => {
    const ringPath = writeTempRing(ringConfig(0x09));
    const provider = makeProvider(ringPath);
    const first = hashRecipient(provider, '');
    const second = hashRecipient(provider, '');
    expect(first.length).toBe(32);
    expect(first.equals(second)).toBe(true);
  });

  it('hashes_a_very_long_input_deterministically', () => {
    const ringPath = writeTempRing(ringConfig(0x09));
    const provider = makeProvider(ringPath);
    const longValue = `+1${'5'.repeat(10_000)}`;
    const first = hashRecipient(provider, longValue);
    const second = hashRecipient(provider, longValue);
    expect(first.length).toBe(32);
    expect(first.equals(second)).toBe(true);
  });

  it('produces_identical_output_across_two_separate_provider_instances_over_the_same_ring', () => {
    const ringPath = writeTempRing(ringConfig(0x09));
    const providerA = makeProvider(ringPath);
    const providerB = makeProvider(ringPath);
    const a = hashRecipient(providerA, '+15550001111');
    const b = hashRecipient(providerB, '+15550001111');
    expect(a.equals(b)).toBe(true);
  });
});
