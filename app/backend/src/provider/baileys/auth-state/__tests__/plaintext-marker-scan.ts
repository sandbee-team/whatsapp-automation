import type { initAuthCreds } from 'baileys';

/**
 * __tests__/plaintext-marker-scan.ts (P07 Unit U6, step 9) - the marker-scan
 * helper shared by `no-plaintext.integration.test.ts` (split out purely to
 * stay under the repo's `max-lines` guard, same reasoning as `pg-repo.ts`/
 * `pg-repo-keys.ts`'s own split). See that test file's header for the full
 * haystack-construction description.
 */

export interface Marker {
  name: string;
  buffer: Buffer;
}

export interface StringMarker {
  name: string;
  value: string;
  wordBoundary?: boolean;
}

/**
 * Columns excluded ONLY from the decimal word-boundary `registrationId`
 * check (never from the Buffer-marker checks, which is the actual
 * secret-leak proof and runs unconditionally against every column):
 *  - `instance_id`/`client_id` (UUIDs) and `kek_id` (a short key-ring label
 *    like "k1") are themselves random-looking identifiers, not secrets.
 *  - `ciphertext`/`iv`/`auth_tag`/`dek_wrapped`/`dek_iv`/`dek_tag` are AEAD
 *    ciphertext/random IV/tag bytes BY DESIGN - high-entropy random data, in
 *    which a short (1-5 digit, since Baileys' `registrationId` is a
 *    `Uint16 & 16383`) decimal substring collides by pure chance often
 *    enough to make the assertion non-deterministic.
 *  - `session_epoch`/`enc_version`/`cred_version`/`owner_fence` are small
 *    integer counters (schema defaults/fixtures start them at 0 or 1 - see
 *    migration 0020), not secrets: `String(registrationId)` can EQUAL one of
 *    these small counters outright (not just collide as a substring), so
 *    the word-boundary check must skip them the same way it skips the
 *    ciphertext columns above.
 * Proven empirically while hardening this suite: a fresh random
 * `initAuthCreds()` false-positived `registrationId` matches inside
 * `instance_id`, `ciphertext`, AND `dek_wrapped` across repeated runs before
 * this exclusion was added, and later (2026-09-14) matched
 * `whatsapp_session_credentials.session_epoch` (value `0`) the same way.
 */
export const IDENTIFIER_COLUMNS = new Set([
  'instance_id',
  'client_id',
  'kek_id',
  'ciphertext',
  'iv',
  'auth_tag',
  'dek_wrapped',
  'dek_iv',
  'dek_tag',
  'session_epoch',
  'enc_version',
  'cred_version',
  'owner_fence',
]);

/** Renders one Buffer marker in every encoding a leaked value could plausibly appear in. */
function markerNeedles(buffer: Buffer): string[] {
  return [buffer.toString('base64'), buffer.toString('hex'), buffer.toString('latin1')];
}

/** Builds the marker set from a real `initAuthCreds()` object plus the seeded pre-key/session values. */
export function buildMarkers(
  creds: ReturnType<typeof initAuthCreds>,
  preKeyPublic: Uint8Array,
  preKeyPrivate: Uint8Array,
  sessionValue: Uint8Array,
): Marker[] {
  return [
    { name: 'creds.noiseKey.private', buffer: Buffer.from(creds.noiseKey.private) },
    { name: 'creds.noiseKey.public', buffer: Buffer.from(creds.noiseKey.public) },
    {
      name: 'creds.signedIdentityKey.private',
      buffer: Buffer.from(creds.signedIdentityKey.private),
    },
    { name: 'creds.signedIdentityKey.public', buffer: Buffer.from(creds.signedIdentityKey.public) },
    { name: 'seeded pre-key public', buffer: Buffer.from(preKeyPublic) },
    { name: 'seeded pre-key private', buffer: Buffer.from(preKeyPrivate) },
    { name: 'seeded session value', buffer: Buffer.from(sessionValue) },
  ];
}

/**
 * Scans `haystack` (a string OR a Buffer, rendered in base64/hex/latin1) for
 * every buffer-shaped marker's needle renderings, PLUS string markers
 * searched as literal substrings (`advSecretKey`'s base64 string itself, and
 * `registrationId`'s decimal string with word-boundary guards so e.g. "17"
 * cannot false-positive inside an unrelated "170...").
 *
 * `opts.checkWordBoundaryMarkers` (default `true`) lets a caller skip ONLY
 * the word-boundary decimal markers for a haystack it knows is random-
 * identifier- or ciphertext-shaped (see `IDENTIFIER_COLUMNS`'s own comment) -
 * it never weakens the Buffer-marker checks, which always run.
 *
 * Returns the name of the FIRST marker found, or `null` if none matched -
 * this is the single load-bearing scan helper both the real haystacks and the
 * negative-control test exercise, so a bug in this helper is caught by the
 * negative control itself.
 */
export function findMarker(
  haystackLabel: string,
  haystack: string | Buffer,
  markers: Marker[],
  stringMarkers: StringMarker[],
  opts: { checkWordBoundaryMarkers?: boolean } = {},
): string | null {
  const checkWordBoundaryMarkers = opts.checkWordBoundaryMarkers ?? true;
  const asBuffer = Buffer.isBuffer(haystack) ? haystack : null;
  const renderings: string[] = asBuffer
    ? [asBuffer.toString('base64'), asBuffer.toString('hex'), asBuffer.toString('latin1')]
    : [haystack as string];

  for (const marker of markers) {
    const needles = markerNeedles(marker.buffer);
    for (const needle of needles) {
      if (needle.length === 0) continue;
      for (const rendering of renderings) {
        if (rendering.includes(needle)) {
          return `${marker.name} (in ${haystackLabel})`;
        }
      }
    }
  }

  for (const sm of stringMarkers) {
    if (sm.value.length === 0) continue;
    if (sm.wordBoundary && !checkWordBoundaryMarkers) {
      continue;
    }
    for (const rendering of renderings) {
      if (sm.wordBoundary) {
        const pattern = new RegExp(`(?<![0-9])${sm.value}(?![0-9])`);
        if (pattern.test(rendering)) {
          return `${sm.name} (in ${haystackLabel})`;
        }
      } else if (rendering.includes(sm.value)) {
        return `${sm.name} (in ${haystackLabel})`;
      }
    }
  }

  return null;
}
