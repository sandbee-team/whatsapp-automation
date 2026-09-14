import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { CryptoError } from '../errors/app-error.js';
import { keyRingSchema } from './key-ring-schema.js';
import { makeKekEntry, type KekEntry, type KeyProvider } from './key-provider.js';
import type { KekPurpose } from './purposes.js';

/** Placeholder kekId for ring-level errors that have no single offending key. */
const RING_ERROR_ID = 'ring';

export type FileKeyProviderOptions = {
  /** Path to the JSON key-ring file. Read once, at construction ("at boot"). */
  ringPath: string;
  /**
   * Purposes this process is allowed to hold material for. Every key whose
   * purpose is not in this list is dropped before it enters memory - fail
   * closed (threat model row 4: an RCE in a process that never mounted
   * `session` cannot decrypt a session blob, because the key was never read).
   */
  mountedPurposes: readonly KekPurpose[];
};

/**
 * Reads a JSON key ring off disk once at construction, Zod-validates it, and
 * keeps only the purposes this process mounted. The documented future swap is
 * an OpenBao/Vault transit-engine `KeyProvider` behind the same interface;
 * `FileKeyProvider` is the v1/dev/on-disk implementation.
 */
export class FileKeyProvider implements KeyProvider {
  private readonly mounted: ReadonlySet<KekPurpose>;
  private readonly entries: ReadonlyMap<string, KekEntry>;
  private readonly active: ReadonlyMap<KekPurpose, string>;

  constructor(options: FileKeyProviderOptions) {
    this.mounted = new Set(options.mountedPurposes);

    let raw: unknown;
    try {
      const text = readFileSync(options.ringPath, 'utf8');
      raw = JSON.parse(text);
    } catch {
      throw new CryptoError('CRYPTO_KEY_RING_INVALID', RING_ERROR_ID);
    }

    const parsed = keyRingSchema.safeParse(raw);
    if (!parsed.success) {
      // Wrap, never rethrow the raw ZodError - a Zod issue can echo the
      // `received` value, which for `material` would leak key bytes.
      throw new CryptoError('CRYPTO_KEY_RING_INVALID', RING_ERROR_ID);
    }

    const entries = new Map<string, KekEntry>();
    for (const [kekId, record] of Object.entries(parsed.data.keys)) {
      if (!this.mounted.has(record.purpose)) {
        continue;
      }
      entries.set(
        kekId,
        makeKekEntry({
          kekId,
          purpose: record.purpose,
          material: Buffer.from(record.material, 'base64'),
          retired: record.retired ?? false,
        }),
      );
    }
    this.entries = entries;

    const active = new Map<KekPurpose, string>();
    for (const [purpose, kekId] of Object.entries(parsed.data.active)) {
      if (this.mounted.has(purpose as KekPurpose)) {
        active.set(purpose as KekPurpose, kekId);
      }
    }
    this.active = active;
  }

  getActive(purpose: KekPurpose): KekEntry {
    if (!this.mounted.has(purpose)) {
      throw new CryptoError('CRYPTO_KEY_UNAVAILABLE', RING_ERROR_ID);
    }
    const kekId = this.active.get(purpose);
    const entry = kekId ? this.entries.get(kekId) : undefined;
    if (!entry || entry.retired) {
      throw new CryptoError('CRYPTO_KEY_UNAVAILABLE', RING_ERROR_ID);
    }
    return entry;
  }

  get(kekId: string, purpose: KekPurpose): KekEntry {
    if (!this.mounted.has(purpose)) {
      throw new CryptoError('CRYPTO_KEY_UNAVAILABLE', kekId);
    }
    const entry = this.entries.get(kekId);
    if (!entry) {
      throw new CryptoError('CRYPTO_KEY_UNAVAILABLE', kekId);
    }
    if (entry.purpose !== purpose) {
      throw new CryptoError('CRYPTO_PURPOSE_MISMATCH', kekId);
    }
    return entry;
  }

  toJSON(): unknown {
    return { mountedPurposes: [...this.mounted] };
  }

  [inspect.custom](): unknown {
    return { mountedPurposes: [...this.mounted] };
  }
}
