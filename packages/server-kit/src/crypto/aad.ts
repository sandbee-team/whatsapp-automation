import type { KekPurpose } from './purposes.js';

/**
 * The two AAD (additional authenticated data) formulas for the envelope
 * (blueprint §Encryption [R-10c], data-security design §4.2). This file is
 * the ONLY place either formula is written - `envelope.ts` calls these
 * functions and never re-implements the byte layout inline, so there is
 * exactly one source of truth every test asserts against.
 *
 * CRITICAL split: the two layers bind to different, deliberately disjoint
 * fields. `dekWrapAad` binds the wrapped-DEK layer to `kekId` (so a DEK
 * wrapped under one KEK can never be unwrapped as if it came from another).
 * `recordAad` binds the record layer to the record's identity/location
 * (table/column/tenant/record) but NEVER to `kekId` - that is what makes KEK
 * rotation safe: rotating a KEK rewraps the DEK (a `dekWrapAad` change) while
 * the record ciphertext and its `recordAad` are untouched. An earlier design
 * draft used one combined AAD for both layers; the blueprint supersedes that
 * - do not reintroduce a `kekId` (or anything rotation mutates) into
 * `recordAad`.
 *
 * Encoding: each UTF-8 field is length-prefixed (4-byte big-endian byte
 * length, then the UTF-8 bytes), concatenated in the fixed field order below.
 * This makes the encoding unambiguous - e.g. `("1", "k1")` and `("1k", "1")`
 * produce different byte sequences even though a naive `join('|')` would
 * collide if either field could contain the separator. Numbers are encoded
 * as their decimal string form before length-prefixing.
 */

const UINT32_BYTE_LENGTH = 4;

/** Length-prefixes one UTF-8 field: 4-byte BE length, then the UTF-8 bytes. */
function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const header = Buffer.alloc(UINT32_BYTE_LENGTH);
  header.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([header, bytes]);
}

export type DekWrapAadParams = {
  encVersion: number;
  kekId: string;
  purpose: KekPurpose;
};

/**
 * AAD for the wrapped-DEK layer: `enc_version || kek_id || purpose`,
 * length-prefixed field by field. Bound to `kekId` on purpose - this layer's
 * ciphertext (`dek_wrapped`) is only ever valid under the exact KEK that
 * wrapped it.
 */
export function dekWrapAad(params: DekWrapAadParams): Buffer {
  return Buffer.concat([
    lengthPrefixed(String(params.encVersion)),
    lengthPrefixed(params.kekId),
    lengthPrefixed(params.purpose),
  ]);
}

export type RecordAadParams = {
  encVersion: number;
  tableName: string;
  columnName: string;
  clientId: string;
  recordId: string;
};

/**
 * AAD for the record layer: `enc_version || table_name || column_name ||
 * client_id || record_id`, length-prefixed field by field. Deliberately
 * contains NO `kek_id` - KEK rotation must never change this AAD, or every
 * record sealed under the old KEK would fail to open the moment it rotates.
 * `client_id`/`record_id` binding is what makes a blob moved to another
 * tenant (or another row) fail its auth tag instead of silently decrypting.
 */
export function recordAad(params: RecordAadParams): Buffer {
  return Buffer.concat([
    lengthPrefixed(String(params.encVersion)),
    lengthPrefixed(params.tableName),
    lengthPrefixed(params.columnName),
    lengthPrefixed(params.clientId),
    lengthPrefixed(params.recordId),
  ]);
}
