/**
 * auth/cidr.ts (P28 Unit U2, step 3) - the IPv4 CIDR allow-list matcher,
 * MOVED here byte-for-byte from
 * `app/backend/src/modules/internal/service-token.ts` (P19 Unit U5, step 8)
 * so it is a shared `@wp/server-kit/auth` primitive rather than a
 * backend-local one. `app/backend`'s own file is now a thin re-export shim -
 * see that file's own header.
 */

interface ParsedCidr {
  family: 4 | 6;
  bytes: number[];
  prefixLength: number;
}

function parseIpv4ToBytes(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return undefined;
  return bytes;
}

/** Parses a single "a.b.c.d/nn" CIDR entry - IPv4 only (the narrowest thing that covers this repo's deploy targets; see module header). Returns undefined for anything malformed, which the caller treats as "this entry never matches". */
function parseCidr(entry: string): ParsedCidr | undefined {
  const trimmed = entry.trim();
  if (!trimmed) return undefined;
  const [address, prefixRaw] = trimmed.split('/');
  if (!address) return undefined;
  const bytes = parseIpv4ToBytes(address);
  if (!bytes) return undefined;
  const prefixLength = prefixRaw === undefined ? 32 : Number(prefixRaw);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) return undefined;
  return { family: 4, bytes, prefixLength };
}

function ipv4ToUint32(bytes: number[]): number {
  return (
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)
  );
}

function matchesCidr(addressBytes: number[], cidr: ParsedCidr): boolean {
  if (cidr.prefixLength === 0) return true;
  const mask = cidr.prefixLength === 32 ? 0xffffffff : ~(0xffffffff >>> cidr.prefixLength);
  return (ipv4ToUint32(addressBytes) & mask) === (ipv4ToUint32(cidr.bytes) & mask);
}

/**
 * True when `remoteAddress` (an IPv4 dotted-quad, e.g. `req.ip`) matches at
 * least one entry of `allowedCidrs` (comma-separated `a.b.c.d/nn` list).
 * Fail-closed: an empty/unset allow-list, or an address that is not a
 * plain IPv4 literal, never matches - there is no implicit allow-all.
 * `platform/http/ip-rules.ts`'s `classifyIpv4`/`classifyIpv6`/
 * `classifyResolvedAddress` classify an address's KIND (loopback, private,
 * etc) but expose no CIDR-membership primitive, so this function does not
 * reuse them - it implements the narrowest thing that does (plain IPv4
 * dotted-quad CIDR arithmetic, matching this repo's current deploy
 * targets; a v6 allow-list is not needed today).
 */
export function isIpAllowed(remoteAddress: string, allowedCidrs: string): boolean {
  const entries = allowedCidrs
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return false;

  const addressBytes = parseIpv4ToBytes(remoteAddress);
  if (!addressBytes) return false;

  for (const entry of entries) {
    const cidr = parseCidr(entry);
    if (cidr && matchesCidr(addressBytes, cidr)) {
      return true;
    }
  }
  return false;
}
