/**
 * xxhash32.ts (P09 Unit U2 step 4) - a minimal, pure-TS xxHash32
 * implementation (standard xxHash32 constants; no dependency, no
 * `Math.random`, no wall clock - the phase pins xxhash32 specifically so the
 * connect-offset decorrelates from the repo's existing FNV-1a reconnect
 * stagger in `packages/domain/src/instance/reconnect-policy.ts`, which is
 * NOT reused here on purpose).
 *
 * All arithmetic is kept inside 32-bit bounds via `Math.imul` (32x32->32
 * multiply, matching C's `uint32_t` overflow) and `>>> 0` (unsigned
 * coercion) at each step, mirroring the reference algorithm exactly.
 */

const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

function rotl32(x: number, r: number): number {
  return ((x << r) | (x >>> (32 - r))) >>> 0;
}

function round(acc: number, input: number): number {
  acc = (acc + Math.imul(input, PRIME32_2)) >>> 0;
  acc = rotl32(acc, 13);
  acc = Math.imul(acc, PRIME32_1) >>> 0;
  return acc;
}

/** Computes the standard xxHash32 digest of a UTF-8 string, given a seed (default 0). */
export function xxhash32(input: string, seed = 0): number {
  const bytes = Buffer.from(input, 'utf8');
  const len = bytes.length;
  let offset = 0;
  let h32: number;

  if (len >= 16) {
    let v1 = (seed + PRIME32_1 + PRIME32_2) >>> 0;
    let v2 = (seed + PRIME32_2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - PRIME32_1) >>> 0;

    const limit = len - 16;
    while (offset <= limit) {
      v1 = round(v1, bytes.readUInt32LE(offset));
      offset += 4;
      v2 = round(v2, bytes.readUInt32LE(offset));
      offset += 4;
      v3 = round(v3, bytes.readUInt32LE(offset));
      offset += 4;
      v4 = round(v4, bytes.readUInt32LE(offset));
      offset += 4;
    }

    h32 = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
  } else {
    h32 = (seed + PRIME32_5) >>> 0;
  }

  h32 = (h32 + len) >>> 0;

  const remainingLimit = len - 4;
  while (offset <= remainingLimit) {
    h32 = (h32 + Math.imul(bytes.readUInt32LE(offset), PRIME32_3)) >>> 0;
    h32 = rotl32(h32, 17);
    h32 = Math.imul(h32, PRIME32_4) >>> 0;
    offset += 4;
  }

  while (offset < len) {
    h32 = (h32 + Math.imul(bytes.readUInt8(offset), PRIME32_5)) >>> 0;
    h32 = rotl32(h32, 11);
    h32 = Math.imul(h32, PRIME32_1) >>> 0;
    offset += 1;
  }

  h32 = h32 ^ (h32 >>> 15);
  h32 = Math.imul(h32, PRIME32_2) >>> 0;
  h32 = h32 ^ (h32 >>> 13);
  h32 = Math.imul(h32, PRIME32_3) >>> 0;
  h32 = h32 ^ (h32 >>> 16);

  return h32 >>> 0;
}
