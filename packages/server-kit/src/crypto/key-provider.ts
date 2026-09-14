import type { KekPurpose } from './purposes.js';

/**
 * A single key-encryption-key, resolved from the ring. `material` carries the
 * raw key bytes and must never be enumerable/serialisable - every entry is
 * built via `makeKekEntry` below, which hides `material` behind a
 * non-enumerable property and a `toJSON` that omits it, so `JSON.stringify`,
 * `console.log`, and `util.inspect` never echo the key.
 */
export type KekEntry = {
  readonly kekId: string;
  readonly purpose: KekPurpose;
  readonly material: Buffer;
  readonly retired: boolean;
};

/**
 * Builds a `KekEntry` whose `material` is non-enumerable (kept out of
 * `Object.keys`, `for...in`, and object spreads) and whose `toJSON` omits it
 * entirely, so `JSON.stringify(entry)` never contains key bytes. `[k]`
 * (util.inspect.custom) mirrors the same redaction for `console.log` /
 * `util.inspect`.
 */
export function makeKekEntry(input: {
  kekId: string;
  purpose: KekPurpose;
  material: Buffer;
  retired: boolean;
}): KekEntry {
  const entry = {
    kekId: input.kekId,
    purpose: input.purpose,
    retired: input.retired,
  } as KekEntry;

  Object.defineProperty(entry, 'material', {
    value: input.material,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  Object.defineProperty(entry, 'toJSON', {
    value: () => ({ kekId: input.kekId, purpose: input.purpose, retired: input.retired }),
    enumerable: false,
  });

  const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');
  Object.defineProperty(entry, inspectSymbol, {
    value: () => ({ kekId: input.kekId, purpose: input.purpose, retired: input.retired }),
    enumerable: false,
  });

  return Object.freeze(entry);
}

/**
 * The key-ring abstraction every KEK consumer (envelope seal/open, rotation)
 * depends on. `FileKeyProvider` is the v1 implementation, reading a JSON ring
 * off disk; the documented future swap is an OpenBao/Vault transit-engine
 * provider behind this same interface - callers never depend on the file
 * format directly.
 *
 * `getActive` is the seal path: it never returns a `retired` key. `get` is
 * the open path: it returns a key by id regardless of `retired`, because
 * older ciphertext must still be openable after its KEK rotates out.
 */
export interface KeyProvider {
  /** Seal path. Throws `CRYPTO_KEY_UNAVAILABLE` if `purpose` isn't mounted. */
  getActive(purpose: KekPurpose): KekEntry;
  /**
   * Open path. Throws `CRYPTO_KEY_UNAVAILABLE` if `kekId` is unknown or its
   * purpose isn't mounted, `CRYPTO_PURPOSE_MISMATCH` if `kekId` exists but
   * belongs to a different purpose than requested.
   */
  get(kekId: string, purpose: KekPurpose): KekEntry;
}
