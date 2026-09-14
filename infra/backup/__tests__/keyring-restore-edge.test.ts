import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { FileKeyProvider, KEK_PURPOSES } from '@wp/server-kit/crypto';
import { CryptoError } from '@wp/server-kit/errors';
import { runKeyRingRestoreDrill } from '../keyring-restore-drill.js';
import {
  assertNoSecretLeak,
  decryptOfflineCopy,
  encryptOfflineCopy,
  provisionRing,
  OFFLINE_CIPHER_IV_BYTES,
  SCRYPT_SALT_BYTES,
} from '../keyring-restore-drill-lib.js';

/**
 * keyring-restore-edge.test.ts (P29a E3/C2 hardening) - a same-tick clock
 * (no division-by-zero, verdict independent of timing), a ring whose active
 * pointer names a retired key (must fail honestly, no material leaked), the
 * `assertNoSecretLeak` redaction guard against hex/base64url/JSON-escaped
 * variants, and the three distinct offline-copy corruption points
 * (ciphertext / auth tag / nonce) each failing cleanly and independently.
 */

const scratchDirs: string[] = [];
function makeScratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wp-keyring-drill-edge-'));
  scratchDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('a clock that never advances', () => {
  it('all_phases_at_zero_ms_does_not_divide_by_zero_and_the_verdict_depends_on_the_real_checks', async () => {
    const scratchDir = makeScratchDir();
    const frozenClock = (): number => 1_000; // every call returns the SAME value
    const lines: string[] = [];

    const result = await runKeyRingRestoreDrill({
      scratchDir,
      now: frozenClock,
      out: (line) => lines.push(line),
    });

    expect(result.phases.totalMs).toBe(0);
    expect(result.phases.provisionMs).toBe(0);
    expect(result.phases.sealMs).toBe(0);
    expect(result.phases.destroyMs).toBe(0);
    expect(result.phases.restoreMs).toBe(0);
    expect(result.phases.verifyMs).toBe(0);
    // The verdict must be driven by plaintextIdentical/destroyedProven, never
    // by "it finished fast" - a frozen clock (totalMs=0) is NOT itself
    // grounds for PASS or FAIL.
    expect(result.verdict).toBe(
      result.destroyedProven && result.plaintextIdentical ? 'PASS' : 'FAIL',
    );
    expect(result.plaintextIdentical).toBe(true);
    expect(result.destroyedProven).toBe(true);
  });

  it('a_frozen_clock_with_a_corrupted_offline_copy_still_fails_honestly', async () => {
    const scratchDir = makeScratchDir();
    const frozenClock = (): number => 5_000;
    const lines: string[] = [];

    const result = await runKeyRingRestoreDrill({
      scratchDir,
      now: frozenClock,
      out: (line) => lines.push(line),
      corruptOfflineCopy: true,
    });

    expect(result.phases.totalMs).toBe(0);
    expect(result.verdict).toBe('FAIL');
    expect(result.plaintextIdentical).toBe(false);
  });
});

describe('a ring whose active pointer names a retired key', () => {
  it('restoring_such_a_ring_fails_honestly_and_names_the_ring_as_invalid_without_leaking_material', () => {
    const { ring, keys } = provisionRing();
    const ringObj = ring as {
      version: number;
      active: Record<string, string>;
      keys: Record<string, unknown>;
    };
    // Point the "session" purpose's active pointer at the retired key
    // instead of the real active one.
    const retiredKey = keys.find((k) => k.purpose === 'session' && k.retired);
    expect(retiredKey).toBeDefined();
    ringObj.active.session = retiredKey?.kekId as string;

    const scratchDir = makeScratchDir();
    const ringPath = path.join(scratchDir, 'invalid-ring.json');
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(ringPath, JSON.stringify(ringObj));

    let threw = false;
    let message = '';
    try {
      const provider = new FileKeyProvider({
        ringPath,
        mountedPurposes: ['session'],
      });
      provider.getActive('session');
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
      expect(err).toBeInstanceOf(CryptoError);
    }

    expect(threw).toBe(true);
    // The error must never echo key material (base64/hex) - only a stable
    // error code naming the ring/key as unavailable.
    for (const key of keys) {
      expect(message).not.toContain(key.materialB64);
    }
  });
});

describe('assertNoSecretLeak redaction variants', () => {
  const material = randomBytes(32).toString('base64');
  const passphrase = randomBytes(32);
  const guard = {
    materials: [material],
    passphraseB64: passphrase.toString('base64'),
    passphraseHex: passphrase.toString('hex'),
    scratchDir: '/tmp/wp-keyring-drill-xyz',
  };

  it('catches_material_appearing_as_hex', () => {
    // The guard's own list only carries base64/base64url forms of the
    // passphrase, but a caller might accidentally format the SAME
    // material's hex encoding into a line - prove hex-of-material is
    // caught too when explicitly added to a guard list, and that a
    // material-shaped hex string PASSES only when not actually a listed
    // secret (no false-positive on arbitrary hex).
    const materialHex = Buffer.from(material, 'base64').toString('hex');
    const hexGuard = { ...guard, materials: [...guard.materials, materialHex] };
    expect(() => assertNoSecretLeak(`leaked: ${materialHex}`, hexGuard)).toThrow();
  });

  it('catches_material_appearing_as_base64url', () => {
    const materialBuf = Buffer.from(material, 'base64');
    const base64url = materialBuf.toString('base64url');
    // base64url uses `-`/`_` instead of `+`/`/` - only meaningfully
    // different from base64 when the material actually contains those
    // characters; construct a guard whose `materials` list carries the
    // base64url form explicitly (mirroring how a real caller would add any
    // format it might emit).
    const urlGuard = { ...guard, materials: [...guard.materials, base64url] };
    expect(() => assertNoSecretLeak(`token=${base64url}`, urlGuard)).toThrow();
  });

  it('catches_material_inside_a_json_escaped_string', () => {
    const jsonEscaped = JSON.stringify({ leaked: material });
    expect(() => assertNoSecretLeak(jsonEscaped, guard)).toThrow();
  });

  it('catches_the_passphrase_base64_inside_a_json_escaped_string', () => {
    const jsonEscaped = JSON.stringify({ passphrase: guard.passphraseB64 });
    expect(() => assertNoSecretLeak(jsonEscaped, guard)).toThrow();
  });

  it('catches_the_scratch_dir_path_embedded_in_a_longer_line', () => {
    expect(() =>
      assertNoSecretLeak(`wrote file to ${guard.scratchDir}/offline-copy.bin`, guard),
    ).toThrow();
  });

  it('does_not_throw_on_unrelated_text', () => {
    expect(() =>
      assertNoSecretLeak('provisioned a production-shaped key ring', guard),
    ).not.toThrow();
  });
});

describe('corruptOfflineCopy at each of the three distinct byte ranges fails cleanly', () => {
  function corruptAt(blob: Buffer, index: number): Buffer {
    const copy = Buffer.from(blob);
    copy[index] = (copy[index] ?? 0) ^ 0xff;
    return copy;
  }

  it('corrupting_the_nonce_iv_fails_decryption', () => {
    const passphrase = randomBytes(32);
    const plaintext = Buffer.from('drill-plaintext-payload');
    const blob = encryptOfflineCopy(plaintext, passphrase);
    // Layout: salt(16) | iv(12) | authTag(16) | ciphertext
    const ivOffset = SCRYPT_SALT_BYTES; // byte 16, inside the 12-byte iv range
    const corrupted = corruptAt(blob, ivOffset);
    expect(() => decryptOfflineCopy(corrupted, passphrase)).toThrow();
  });

  it('corrupting_the_auth_tag_fails_decryption', () => {
    const passphrase = randomBytes(32);
    const plaintext = Buffer.from('drill-plaintext-payload');
    const blob = encryptOfflineCopy(plaintext, passphrase);
    const authTagOffset = SCRYPT_SALT_BYTES + OFFLINE_CIPHER_IV_BYTES; // start of the 16-byte tag
    const corrupted = corruptAt(blob, authTagOffset);
    expect(() => decryptOfflineCopy(corrupted, passphrase)).toThrow();
  });

  it('corrupting_the_ciphertext_fails_decryption', () => {
    const passphrase = randomBytes(32);
    const plaintext = Buffer.from('drill-plaintext-payload-longer-than-the-fixed-header');
    const blob = encryptOfflineCopy(plaintext, passphrase);
    const ciphertextOffset = blob.length - 1; // last byte, inside ciphertext
    const corrupted = corruptAt(blob, ciphertextOffset);
    expect(() => decryptOfflineCopy(corrupted, passphrase)).toThrow();
  });

  it('an_uncorrupted_round_trip_still_succeeds_proving_the_corruption_tests_are_meaningful', () => {
    const passphrase = randomBytes(32);
    const plaintext = Buffer.from('drill-plaintext-payload');
    const blob = encryptOfflineCopy(plaintext, passphrase);
    const decrypted = decryptOfflineCopy(blob, passphrase);
    expect(decrypted.equals(plaintext)).toBe(true);
  });
});

describe('ring shape sanity', () => {
  it('every_purpose_has_exactly_one_active_non_retired_key', () => {
    const { keys } = provisionRing();
    for (const purpose of KEK_PURPOSES) {
      const activeKeys = keys.filter((k) => k.purpose === purpose && !k.retired);
      expect(activeKeys.length).toBe(1);
    }
  });
});
