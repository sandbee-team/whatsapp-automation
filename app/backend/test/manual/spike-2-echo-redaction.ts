import { createHash } from 'node:crypto';
import type { WAMessage, WAMessageKey } from 'baileys';
import type { ContentHashFields } from '@wp/domain';

/**
 * spike-2-echo-redaction.ts (P12 step 10, split from spike-2-echo.ts for
 * max-lines discipline - same "session-worker-discovery-wiring.ts" sibling-
 * module idiom `.claude/rules/core-invariants.md` documents) - every PURE
 * redaction/derivation helper the SPIKE-2 runner needs, plus the exhaustive
 * Baileys event-name list. No socket, no I/O, no console/file writes here -
 * see `spike-2-echo.ts` for orchestration.
 *
 * REDACTION POLICY (binding for every caller): no phone numbers, no JIDs'
 * user part, no message bodies, no QR/pairing payloads ever cross into a
 * returned value here. A JID becomes `{ serverPart, userHash }` (sha256 of
 * the lowercased user part, truncated to 12 hex chars - the same recipe
 * `identity/routes-shared.ts:200` uses for an identifier hash); text becomes
 * `{ present, byteLength, sha256 }`. See ADR 0035 §8 for why `serverPart`
 * and `addressingMode` specifically must be captured verbatim (never
 * redacted) - they are not PII and they are the load-bearing observation
 * that decides whether LID resolution has to be built.
 */

/** Every Baileys `7.0.0-rc14` event name, enumerated by reading `BaileysEventMap` in `baileys/lib/Types/Events.d.ts` directly (not guessed, not a subset). Subscribing to all of them is the point: discovering which path (or none) the echo takes requires missing nothing. */
export const ALL_BAILEYS_EVENTS = [
  'connection.update',
  'creds.update',
  'messaging-history.set',
  'messaging-history.status',
  'chats.upsert',
  'chats.update',
  'lid-mapping.update',
  'chats.delete',
  'presence.update',
  'contacts.upsert',
  'contacts.update',
  'messages.delete',
  'messages.update',
  'messages.media-update',
  'messages.upsert',
  'messages.reaction',
  'message-receipt.update',
  'groups.upsert',
  'groups.update',
  'group-participants.update',
  'group.join-request',
  'group.member-tag.update',
  'blocklist.set',
  'blocklist.update',
  'call',
  'labels.edit',
  'labels.association',
  'newsletter.reaction',
  'newsletter.view',
  'newsletter-participants.update',
  'newsletter-settings.update',
  'message-capping.update',
  'chats.lock',
  'settings.update',
] as const;

/** sha256(lower(userPart)) truncated to 12 hex chars - same recipe `identity/routes-shared.ts:200` uses for an identifier hash. Never the number itself. */
export function hashUserPart(userPart: string): string {
  return createHash('sha256').update(userPart.toLowerCase(), 'utf8').digest('hex').slice(0, 12);
}

/** Splits a raw JID into `{ serverPart, userHash }` for redacted logging. Never returns the user part itself. `serverPart` (`s.whatsapp.net`/`c.us`/`lid`/`g.us`) is deliberately NOT redacted - ADR 0035 §8 needs it verbatim. */
export function redactJid(
  rawJid: string | null | undefined,
): { serverPart: string; userHash: string } | null {
  if (rawJid === null || rawJid === undefined || rawJid.length === 0) return null;
  const at = rawJid.indexOf('@');
  const userPart = at === -1 ? rawJid : rawJid.slice(0, at);
  const serverPart = at === -1 ? '(no-@)' : rawJid.slice(at + 1);
  return { serverPart, userHash: hashUserPart(userPart) };
}

/** `{ present, byteLength, sha256 }` for a text value - never the text itself. */
export function redactText(text: string | null | undefined): {
  present: boolean;
  byteLength: number;
  sha256: string | null;
} {
  if (text === null || text === undefined) return { present: false, byteLength: 0, sha256: null };
  const bytes = Buffer.byteLength(text, 'utf8');
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  return { present: true, byteLength: bytes, sha256: digest };
}

/** Shape-only dump of a raw message key - server part + userHash for each JID-shaped field, booleans for everything else. Never logs `message.conversation`/`extendedTextMessage.text` verbatim. `addressingMode` is logged verbatim (ADR 0035 §8: not PII, load-bearing). */
export function redactKey(key: WAMessageKey): Record<string, unknown> {
  return {
    remoteJid: redactJid(key.remoteJid ?? undefined),
    fromMe: key.fromMe ?? null,
    idPresent: typeof key.id === 'string' && key.id.length > 0,
    remoteJidAlt: redactJid(key.remoteJidAlt),
    participantAlt: key.participantAlt !== undefined,
    addressingMode: key.addressingMode ?? null,
  };
}

/** Unwraps `deviceSentMessage`, then reads `conversation ?? extendedTextMessage.text` for text and checks the five media-field names for `kind`, per ADR 0035 §1. */
export function deriveKindAndText(message: WAMessage['message']): {
  kind: 'text' | 'media';
  text: string | undefined;
} {
  const wrapped = message?.deviceSentMessage?.message ?? message;
  const mediaField =
    wrapped?.imageMessage ??
    wrapped?.videoMessage ??
    wrapped?.audioMessage ??
    wrapped?.documentMessage ??
    wrapped?.stickerMessage;
  const kind: 'text' | 'media' = mediaField !== undefined && mediaField !== null ? 'media' : 'text';
  const text = wrapped?.conversation ?? wrapped?.extendedTextMessage?.text ?? undefined;
  return { kind, text: text ?? undefined };
}

/**
 * Builds the echo-side `ContentHashFields` per ADR 0035 §3 call site 2:
 * unwrap `deviceSentMessage`, take the JID from `destinationJid ??
 * key.remoteJid`, derive kind/text. Returns `undefined` if there is not
 * enough to hash (no JID at all) - the runner must record that as a
 * captured fact, never guess a JID.
 */
export function echoContentHashFields(wa: WAMessage): ContentHashFields | undefined {
  const destinationJid = wa.message?.deviceSentMessage?.destinationJid;
  const jid = destinationJid ?? wa.key.remoteJid ?? undefined;
  if (jid === undefined) return undefined;
  const { kind, text } = deriveKindAndText(wa.message ?? undefined);
  return { jid, kind, text };
}

/** Recursively describes an unknown payload's SHAPE (key names, value types, array lengths) without ever emitting a string/number leaf value that could carry PII. */
export function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 3) return '(truncated)';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return {
      arrayLength: value.length,
      item: value[0] !== undefined ? shapeOf(value[0], depth + 1) : null,
    };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shapeOf(v, depth + 1);
    }
    return out;
  }
  return typeof value;
}
