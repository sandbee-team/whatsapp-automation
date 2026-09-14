/**
 * content-hash.ts (P12 Unit U3, ADR 0035) - the pure canonicalisation half of
 * `content_hash` = sha256(contentHashInput(fields)). `@wp/domain` ships no
 * Node builtins and must run unchanged in a browser
 * (`delivery-event-id.ts`'s own header establishes the same split), so this
 * module owns only the canonical STRING; the caller applies sha256
 * (`app/backend/src/engine/queue/content-hash.ts#computeContentHash`).
 *
 * ADR 0035 is binding canon for this scheme - read it before changing
 * anything here. Summary: `content_hash` hashes the WIRE PROJECTION
 * (recipient JID, message kind, text) that crosses the transport boundary,
 * not the stored `message_jobs.payload` jsonb - that payload is an open,
 * tenant-controlled record whose other keys never reach WhatsApp and can
 * never be reconstructed from a `fromMe` echo.
 */

/** The two message kinds that reach the transport (`WaMessagePayload.kind` minus `template`, which v1 never sends). */
export type ContentHashKind = 'text' | 'media';

export interface ContentHashFields {
  /** Recipient JID in EITHER our stored form or the provider's echoed form - normalised internally. */
  readonly jid: string;
  readonly kind: ContentHashKind;
  /** The message text, or undefined/'' when the message carries none (media without a caption). */
  readonly text?: string | undefined;
}

/**
 * Canonicalises a WA JID for `contentHashInput`: lowercase, device suffix
 * (`:NN`) stripped, leading `+` stripped, `@c.us` folded to
 * `@s.whatsapp.net`. `@lid` is returned UNCHANGED - resolving a LID to a
 * phone JID needs Baileys' mapping store (I/O + state) and cannot live in
 * this pure module; see ADR 0035 §2 for the fail-safe consequence (an
 * `@lid`-addressed echo will not match and the job fails safe to
 * `blocked_needs_review`, never a guessed match).
 */
export function normalizeWaJidForHash(rawJid: string): string {
  const lowered = rawJid.toLowerCase();
  const atIndex = lowered.indexOf('@');
  const userPart = atIndex === -1 ? lowered : lowered.slice(0, atIndex);
  const serverPart = atIndex === -1 ? 's.whatsapp.net' : lowered.slice(atIndex + 1);

  const colonIndex = userPart.indexOf(':');
  const withoutDeviceSuffix = colonIndex === -1 ? userPart : userPart.slice(0, colonIndex);
  const user = withoutDeviceSuffix.startsWith('+')
    ? withoutDeviceSuffix.slice(1)
    : withoutDeviceSuffix;

  const server = serverPart === 'c.us' ? 's.whatsapp.net' : serverPart;

  return `${user}@${server}`;
}

/** UTF-8 byte length of `value` - browser-safe (`TextEncoder`, no Node `Buffer`). */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The canonical, length-prefixed string whose SHA-256 is
 * `send_attempts.content_hash` / `message_wa_ids.content_hash`:
 *
 *   v1|<utf8len(jid)>:<jid>|<kind>|<utf8len(text)>:<text>
 *
 * These are exactly the three fields that cross the transport boundary
 * (`WaMessagePayload`), which is the ONLY information both the dispatch path
 * and the `fromMe` echo can independently observe - the stored
 * `message_jobs.payload` jsonb is an open record whose other keys never reach
 * WhatsApp and can never be reconstructed from an echo (ADR 0035).
 *
 * `jid` and `text` are LENGTH-PREFIXED, not merely separator-joined: `text`
 * is arbitrary tenant UTF-8 and can contain any separator, so the
 * `delivery-event-id.ts` "`:` cannot appear in a UUID" argument does not
 * apply. A length-prefixed encoding is injective for any field content, so a
 * field-boundary collision is impossible.
 *
 * `text` is NFC-normalised so two byte-different UTF-8 encodings of the same
 * user-visible string hash equally. Pure: no clock, no randomness, no env
 * (`wp/domain-no-wallclock`, domain-determinism).
 */
export function contentHashInput(fields: ContentHashFields): string {
  const jid = normalizeWaJidForHash(fields.jid);
  const text = (fields.text ?? '').normalize('NFC');

  return `v1|${String(utf8ByteLength(jid))}:${jid}|${fields.kind}|${String(utf8ByteLength(text))}:${text}`;
}
