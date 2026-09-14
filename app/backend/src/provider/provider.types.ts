/**
 * provider.types.ts (P11 Unit U2, step 4; P34 Unit B widens `WaMessagePayload`
 * for the real media pipeline, ADR 0052 accepted scope) - the
 * `MessageTransport` half of the provider-boundary interface (blueprint
 * "Provider adapter boundary"). `ChannelLink`/`LinkChallenge` (the OTHER
 * half) already live in `provider/baileys/adapter-types.ts` (P08) - this
 * file adds the sending side, kept in its own module because a Cloud API
 * channel has no persistent socket and a Baileys session has no webhook
 * registration, so the two halves evolve independently.
 *
 * HARD RULE, lint/review-enforced: no Baileys type or import may appear in
 * this file, not even in a type position. `MessageTransport` is the seam a
 * v2 Cloud API adapter drops in behind without the engine caring which
 * provider is live - importing a Baileys type here would leak the
 * implementation through the boundary this file exists to draw.
 *
 * `send()` follows the blueprint's exact contract: it RESOLVES on success
 * with a `SendOutcome` carrying the provider message id (persisted to
 * `send_attempts.provider_msg_id` / `message_wa_ids.wa_msg_id`), and
 * REJECTS with a `TransportSendError` on failure - never a resolved
 * error-shaped value - so callers can `instanceof` it rather than duck-type
 * a discriminated union. `class` is one of exactly the seven
 * `SendErrorClass` values; `@wp/domain`'s `classify()` branches on those
 * same seven strings (`RETRY_CLASS_BY_CATEGORY`'s keys), so a typo here
 * silently falls through to the fail-safe `PAUSE_INSTANCE` default rather
 * than failing loudly - keep this list byte-for-byte in sync with that
 * table.
 *
 * Deliberately absent from this interface, permanently (core invariant 6,
 * no provider-evasion mechanisms): number rotation, proxy/connection
 * masking, device identity forgery, forced automatic resumption after a
 * restriction, and any per-send pacing override. There is nowhere on this
 * interface for such a method to live.
 *
 * MEDIA (P34, ADR 0052 accepted scope item 5): `image`/`document` carry a
 * `Readable` STREAM, never a `Buffer` and never a URL - `dispatch.ts` resolves
 * `mediaId -> objectStore.getStream(storageKey)` at DISPATCH time (never at
 * enqueue) and hands the open stream straight through here. `fileName`/
 * `mimeType` are the STORED asset's own values (never caller-supplied - see
 * `packages/contracts/src/messages.ts`'s per-kind `.strict()` schemas).
 */

import type { Readable } from 'node:stream';

/** Opaque outbound message payload - never a Baileys `AnyMessageContent` or any other provider-specific shape. */
export type WaMessagePayload =
  | { readonly to: string; readonly kind: 'text'; readonly text: string }
  | {
      readonly to: string;
      readonly kind: 'image';
      readonly stream: Readable;
      readonly caption?: string;
    }
  | {
      readonly to: string;
      readonly kind: 'document';
      readonly stream: Readable;
      readonly mimeType: string;
      readonly fileName: string;
      readonly caption?: string;
    };

/**
 * `kinds` subsumes the three REMOVED booleans `text`/`media`/`templates`
 * (Consequences, ADR 0052): `kinds.includes('text')` replaces `text`,
 * `kinds` containing `'image'`/`'document'` replaces the false `media`
 * claim, and `templates` (Cloud-API approved templates, never built here -
 * ADR 0013) has no replacement at all, it is simply gone. `groups`,
 * `maxMediaBytes` and `requiresOptIn` are unchanged.
 */
export interface TransportCapabilities {
  readonly kinds: readonly WaMessagePayload['kind'][];
  readonly groups: boolean;
  readonly maxMediaBytes: number;
  readonly requiresOptIn: boolean;
}

/**
 * The blueprint's original seven categories, plus `group_forbidden` (P16
 * Unit C, scope delta § Groups): a `@g.us`-target provider rejection whose
 * reason is authorisation-shaped (not-admin / announce-mode / not-
 * participant) - terminal per-job, like `invalid_recipient`, and carrying
 * NOTHING into the instance-level hard-restriction health signal (the
 * classifier, not the health evaluator, owns this carve-out - see
 * `provider/baileys/disconnect-map.ts#classifyGroupForbidden`). MUST stay
 * byte-for-byte identical to `@wp/domain`'s `RETRY_CLASS_BY_CATEGORY` keys -
 * see module doc comment.
 */
export type SendErrorClass =
  | 'transient'
  | 'not_connected'
  | 'invalid_recipient'
  | 'invalid_payload'
  | 'rate_limited'
  | 'restricted'
  | 'unknown'
  | 'group_forbidden';

/** Resolved shape of a successful `send()` call. */
export interface SendOutcome {
  /** The provider's own message id (`send_attempts.provider_msg_id` / `message_wa_ids.wa_msg_id`). */
  readonly providerMsgId: string;
  /** Provider-reported send timestamp in epoch ms, when the provider supplies one. */
  readonly sentAt?: number;
}

/**
 * Rejection shape for a failed `send()` call (blueprint: "rejects with
 * `{class: SendErrorClass, retryAfterMs?}`"). A named `Error` subclass so
 * callers can `instanceof TransportSendError` rather than duck-type an
 * unknown rejection reason - any rejection from `send()` that is NOT this
 * class is a transport bug, not a provider-classified failure.
 */
export class TransportSendError extends Error {
  readonly class: SendErrorClass;
  readonly retryAfterMs?: number;

  constructor(sendErrorClass: SendErrorClass, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'TransportSendError';
    this.class = sendErrorClass;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The sending half of the provider boundary. `isReady` performs NO network
 * I/O (it is called on the hot claim path; an I/O round trip there would be
 * a per-job cost) - it reports locally-known socket/session state only.
 */
export interface MessageTransport {
  readonly kind: string;
  readonly capabilities: TransportCapabilities;
  /** Resolves with `SendOutcome` on success; rejects with `TransportSendError` on failure. Never resolves an error-shaped value. */
  send(instanceId: string, msg: WaMessagePayload): Promise<SendOutcome>;
  /** No network I/O - locally-known state only. */
  isReady(instanceId: string): boolean;
}
