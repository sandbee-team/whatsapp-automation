/**
 * uuidv7.ts (P11 U6a) - a dependency-free UUIDv7 generator, isomorphic
 * (browser + Node): no `uuid` package exists anywhere in this monorepo's
 * lockfile (grepped, none found) and the backend's own job `public_id`
 * (`messages.repo.ts`) uses `randomUUID()` (v4), so this is a NEW, minimal
 * helper rather than a reused one - `@wp/utils` ("isomorphic helpers shared
 * by every workspace... safe to run in browser or Node") is its home.
 *
 * Layout per draft-ietf-uuidv6-uuidv7 (128 bits, big-endian):
 *   48 bits unix_ts_ms | 4 bits version (0111) | 12 bits rand_a |
 *   2 bits variant (10) | 62 bits rand_b
 * Uses `globalThis.crypto.getRandomValues` (available in every modern
 * browser and Node >=19) for the random bits - never `Math.random()`
 * (not cryptographically strong, and this ids a real client submission).
 */

/**
 * Minimal shape of the Web Crypto API this file needs - declared locally
 * rather than pulling in `lib: ["DOM"]` (this package's `tsconfig` is
 * `lib: ["ES2023"]` only, isomorphic by design; see this file's top doc
 * comment). Both a browser's and Node's `globalThis.crypto` satisfy it.
 */
interface MinimalCrypto {
  getRandomValues: (bytes: Uint8Array) => Uint8Array;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  (globalThis as unknown as { crypto: MinimalCrypto }).crypto.getRandomValues(bytes);
  return bytes;
}

function toHex(bytes: Uint8Array, start: number, end: number): string {
  let hex = '';
  for (let i = start; i < end; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Generates one uuidv7 string, e.g. `018f1e2a-... ` (36 chars, lowercase, hyphenated). */
export function uuidv7(now: () => number = Date.now): string {
  const timestampMs = now();
  const bytes = randomBytes(16);

  // Bytes 0-5: 48-bit big-endian millisecond timestamp.
  bytes[0] = Math.floor(timestampMs / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestampMs / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestampMs / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestampMs / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestampMs / 2 ** 8) & 0xff;
  bytes[5] = timestampMs & 0xff;

  // Byte 6: high nibble = version (0111 = 7), low nibble = top 4 bits of rand_a.
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  // Byte 8: top 2 bits = variant (10), remaining 6 bits are random (rand_b).
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  return [
    toHex(bytes, 0, 4),
    toHex(bytes, 4, 6),
    toHex(bytes, 6, 8),
    toHex(bytes, 8, 10),
    toHex(bytes, 10, 16),
  ].join('-');
}
