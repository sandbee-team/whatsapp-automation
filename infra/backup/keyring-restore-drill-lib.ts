import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { KEK_PURPOSES, type JsonCodec, type KekPurpose } from '@wp/server-kit/crypto';

/** Per-phase timings in ms, each measured from the injected clock, plus the exact sum. */
export type KeyRingDrillPhases = {
  provisionMs: number;
  sealMs: number;
  destroyMs: number;
  restoreMs: number;
  verifyMs: number;
  totalMs: number;
};

/** Ring shape summary - counts and purpose names only, never key material. */
export type KeyRingDrillRingSummary = {
  purposes: string[];
  keyCount: number;
  retiredCount: number;
  activeKekIdsByPurpose: Record<string, string>;
};

/** Sealed-record summary - sizes and the wrapping kekId only, never plaintext or key bytes. */
export type KeyRingDrillRecordSummary = {
  plaintextBytes: number;
  sealedBytes: number;
  kekId: string;
};

/**
 * The three key-ring locations, named BY DESCRIPTION only (never a path) -
 * `assertNoSecretLeak` below additionally guards that no absolute path or
 * key material ever reaches an evidence surface even if a future edit tried
 * to add one.
 */
export const COPY_DESCRIPTIONS = [
  'host secret store (running copy)',
  "founder's offline encrypted copy",
  'sealed second offline copy',
] as const;

/** The result of one full restore-drill run. Contains no key material anywhere. */
export type KeyRingDrillResult = {
  verdict: 'PASS' | 'FAIL';
  startedAtIso: string;
  finishedAtIso: string;
  phases: KeyRingDrillPhases;
  ring: KeyRingDrillRingSummary;
  record: KeyRingDrillRecordSummary;
  destroyedProven: boolean;
  plaintextIdentical: boolean;
  copies: readonly string[];
  problems: string[];
};

/** Options for `runKeyRingRestoreDrill`. */
export type KeyRingDrillOptions = {
  /** Scratch working directory - a fresh temp dir for the real run, injected for tests. */
  scratchDir: string;
  /** Injected clock (ms) - every phase is timed by calling this before/after. */
  now: () => number;
  /** Sink for human-readable progress lines - each is redaction-checked before emission. */
  out: (line: string) => void;
  /** Where to write the evidence JSON; the CLI defaults this, tests may override or omit. */
  evidenceJsonPath?: string;
  /** Test hook: flips one byte of the offline copy before restore, to prove an honest FAIL. */
  corruptOfflineCopy?: boolean;
  /** Test-only: attaches generated secrets to the result under `__testOnlyMaterials`. */
  exposeMaterialsForTest?: boolean;
};

/** A generated key-ring key, before it is written into the ring JSON file. */
export type ProvisionedKey = {
  kekId: string;
  purpose: KekPurpose;
  materialB64: string;
  retired: boolean;
};

/** AES-256-GCM parameters for the offline-copy "age-like" encryption stand-in. */
export const OFFLINE_CIPHER_ALGORITHM = 'aes-256-gcm';
export const OFFLINE_CIPHER_IV_BYTES = 12;
export const SCRYPT_KEY_BYTES = 32;
export const SCRYPT_SALT_BYTES = 16;

/**
 * Derives a symmetric key from `passphrase` via scrypt, mirroring (in spirit,
 * not in wire format) how `age`'s passphrase mode derives its key - the
 * production tool is `age`; this is a drill stand-in, documented as such in
 * the runbook.
 */
export function deriveOfflineCopyKey(passphrase: Buffer, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, SCRYPT_KEY_BYTES);
}

/**
 * Compares two buffers of possibly-different length in constant time for
 * equal-length inputs, false immediately for mismatched lengths (mismatched
 * length itself carries no secret information here - only the CONTENTS of
 * equal-length buffers must be compared without a timing side channel).
 */
export function safeBuffersEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Generates a fresh random 32-byte key, base64-encoded, for one ring entry. */
export function generateMaterialB64(): string {
  return randomBytes(32).toString('base64');
}

/**
 * Throws if `text` contains any of `materials` (base64 key bytes), the
 * passphrase (base64 or hex), or the scratch directory path. This is the
 * ONE redaction gate every `out()` line and the evidence JSON pass through
 * before they leave the drill - callers never format a secret-bearing
 * string first and check it after the fact.
 */
export function assertNoSecretLeak(
  text: string,
  guard: { materials: string[]; passphraseB64: string; passphraseHex: string; scratchDir: string },
): void {
  const offenders: string[] = [];
  for (const material of guard.materials) {
    if (text.includes(material)) {
      offenders.push('a generated key material value');
    }
  }
  if (text.includes(guard.passphraseB64)) {
    offenders.push('the offline-copy passphrase (base64)');
  }
  if (text.includes(guard.passphraseHex)) {
    offenders.push('the offline-copy passphrase (hex)');
  }
  if (text.includes(guard.scratchDir)) {
    offenders.push('the scratch directory path');
  }
  if (offenders.length > 0) {
    throw new Error(
      `assertNoSecretLeak: refusing to emit text - it contains: ${offenders.join(', ')}`,
    );
  }
}

/** JSON codec mirroring Baileys' own Buffer wire format, without importing baileys. */
export const bufferJsonCodec: JsonCodec = {
  replacer: (_key, value) =>
    Buffer.isBuffer(value) ? { type: 'Buffer', data: [...value.values()] } : value,
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

/**
 * A synthetic auth-credential-shaped record - same buffer field shapes
 * (noise key pair, signed identity key, signed pre-key, registration id, adv
 * secret key) as `initAuthCreds()` from `baileys`, built without importing
 * that package (infra never imports the runtime WhatsApp transport).
 */
export function makeCredentialShapedRecord(): Record<string, unknown> {
  return {
    noiseKey: { private: randomBytes(32), public: randomBytes(32) },
    signedIdentityKey: { private: randomBytes(32), public: randomBytes(32) },
    signedPreKey: {
      keyPair: { private: randomBytes(32), public: randomBytes(32) },
      signature: randomBytes(64),
      keyId: 1,
    },
    registrationId: 12345,
    advSecretKey: randomBytes(32).toString('base64'),
  };
}

/** Builds the production-shaped ring: one active key per purpose, plus one retired `session` key. */
export function provisionRing(): { ring: unknown; keys: ProvisionedKey[] } {
  const keys: ProvisionedKey[] = KEK_PURPOSES.map((purpose) => ({
    kekId: `${purpose}-active-1`,
    purpose,
    materialB64: generateMaterialB64(),
    retired: false,
  }));
  const retiredSession: ProvisionedKey = {
    kekId: 'session-retired-0',
    purpose: 'session',
    materialB64: generateMaterialB64(),
    retired: true,
  };
  keys.push(retiredSession);

  const active: Record<string, string> = {};
  for (const purpose of KEK_PURPOSES) {
    const activeKey = keys.find((k) => k.purpose === purpose && !k.retired);
    if (activeKey) {
      active[purpose] = activeKey.kekId;
    }
  }

  const ringKeys: Record<string, unknown> = {};
  for (const key of keys) {
    ringKeys[key.kekId] = {
      purpose: key.purpose,
      material: key.materialB64,
      created_at: '2026-09-08T00:00:00.000Z',
      ...(key.retired ? { retired: true } : {}),
    };
  }

  return { ring: { version: 1, active, keys: ringKeys }, keys };
}

/** Encrypts `plaintext` under a passphrase-derived key, producing an "age-like" offline-copy stand-in. */
export function encryptOfflineCopy(plaintext: Buffer, passphrase: Buffer): Buffer {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const iv = randomBytes(OFFLINE_CIPHER_IV_BYTES);
  const key = deriveOfflineCopyKey(passphrase, salt);
  const cipher = createCipheriv(OFFLINE_CIPHER_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, ciphertext]);
}

/** Reverses `encryptOfflineCopy`. Throws on any tamper (wrong tag) or wrong passphrase. */
export function decryptOfflineCopy(blob: Buffer, passphrase: Buffer): Buffer {
  const salt = blob.subarray(0, SCRYPT_SALT_BYTES);
  const iv = blob.subarray(SCRYPT_SALT_BYTES, SCRYPT_SALT_BYTES + OFFLINE_CIPHER_IV_BYTES);
  const authTag = blob.subarray(
    SCRYPT_SALT_BYTES + OFFLINE_CIPHER_IV_BYTES,
    SCRYPT_SALT_BYTES + OFFLINE_CIPHER_IV_BYTES + 16,
  );
  const ciphertext = blob.subarray(SCRYPT_SALT_BYTES + OFFLINE_CIPHER_IV_BYTES + 16);
  const key = deriveOfflineCopyKey(passphrase, salt);
  const decipher = createDecipheriv(OFFLINE_CIPHER_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
