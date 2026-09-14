/**
 * The at-rest shape of an envelope-sealed value (data-security design §4.2).
 * Field names are snake_case because they mirror the future DB column names
 * this blob will be split across (a later phase's migration) - `seal()`/
 * `open()` in `envelope.ts` produce/consume exactly this shape, and nothing
 * else invents a different layout.
 */
export type SealedBlob = {
  /** Record layer ciphertext (plaintext encrypted under the per-record DEK). */
  ciphertext: Buffer;
  /** Record layer IV - fresh 12 random bytes on every `seal()` call. */
  iv: Buffer;
  /** Record layer GCM auth tag (16 bytes). */
  auth_tag: Buffer;
  /** The per-record DEK, wrapped (encrypted) under the active KEK. */
  dek_wrapped: Buffer;
  /** Wrap layer IV - fresh 12 random bytes on every `seal()` call. */
  dek_iv: Buffer;
  /** Wrap layer GCM auth tag (16 bytes). */
  dek_tag: Buffer;
  /** The KEK id the DEK was wrapped under - `open()` looks this key up by id. */
  kek_id: string;
  /** The encryption-scheme version in force when this blob was sealed. */
  enc_version: number;
};
