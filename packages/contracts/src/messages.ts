import { oc } from '@orpc/contract';
import { JOB_PRIORITIES } from '@wp/domain';
import { z } from 'zod';
import { successEnvelope } from './envelope.js';

/**
 * messages.ts (P11 Unit U1) - contracts for the send-path MVP's message
 * creation route (`POST /v1/messages`, wired by U3 in `messages.routes.ts`
 * - not this unit's scope). Follows `instances.ts`'s idiom: plain zod
 * objects, `.strict()` where the payload shape is closed, `oc.route()` only
 * where the body/output pair is fully known here.
 *
 * `Idempotency-Key` is a MANDATORY header (queue-engineering skill:
 * "API level: client-supplied idempotency_key; duplicate POST returns the
 * original job, creates nothing") - modelled as its OWN schema
 * (`createMessageHeadersSchema`), not folded into the body input, so the
 * route can reject a missing/blank key before any DB call (`a_request_
 * without_an_idempotency_key_is_rejected_by_the_schema` - rejection happens
 * at the schema layer, never as a first-line-of-defence DB constraint).
 *
 * `payload` byte limit mirrors `db/migrations/0007`'s CHECK verbatim:
 *   CONSTRAINT mj_payload_size CHECK (octet_length(payload::text) <= 2048)
 * measured as UTF-8 BYTES of the JSON text (`JSON.stringify(payload)`), not
 * JS string length - a multi-byte emoji counts as its real byte length, not
 * 1 (or 2, as a surrogate pair) characters. The contract is the FIRST line
 * of defence, not the DB CHECK.
 *
 * `recipient` mirrors `db/migrations/0007`'s shape verbatim: EITHER a valid
 * E.164 phone number OR a `@g.us` group JID (never both required) -
 *   recipient_jid  text NOT NULL,
 *   recipient_e164 text,  -- NULLABLE: a group recipient has no E.164 number
 *   CONSTRAINT mj_recipient_shape CHECK
 *     (recipient_e164 IS NOT NULL OR recipient_jid LIKE '%@g.us')
 * E.164 pattern: `+` then 1-15 digits, first digit 1-9 (no leading zero).
 */

const E164_PATTERN = /^\+[1-9]\d{1,14}$/u;
const GROUP_JID_PATTERN = /^[^@]+@g\.us$/u;

/** A recipient is either an E.164 phone number or a `@g.us` group JID. */
export const recipientSchema = z
  .string()
  .refine((value) => E164_PATTERN.test(value) || GROUP_JID_PATTERN.test(value), {
    message: 'Must be a valid E.164 phone number (e.g. +919876543210) or a @g.us group JID',
  });

/**
 * The message kinds the API accepts (widened P34, ADR 0052 accepted scope:
 * "Two outbound kinds only: `image` and `document`" - video/audio/etc. stay
 * OUT until their own acceptance). `'media'` as a caller-facing kind is
 * PERMANENTLY gone: it was the 2026-09-14 go-live fail-close for a real
 * billing bug (the Baileys adapter sent a `'media'` job as plain text while
 * `resolvePriceKey` billed it at the media rate) and is replaced by the two
 * real kinds below, never resurrected as a catch-all.
 */
export const messageKindSchema = z.enum(['text', 'image', 'document']);
export type MessageKindContract = z.infer<typeof messageKindSchema>;

/**
 * Per-kind payload shapes (accepted scope item 4: "File name and MIME come
 * from the stored asset, never from the send request"). Each is `.strict()`
 * so a request smuggling its own `fileName`/`mimeType`/`mimetype` - fields
 * that belong to the STORED `media_assets` row, resolved server-side at
 * enqueue time (`messages.service.ts`) - is rejected by the schema itself,
 * never silently stripped or silently trusted.
 */
export const textPayloadSchema = z.object({ text: z.string().min(1).max(4096) }).strict();
export const imagePayloadSchema = z
  .object({ mediaId: z.uuid(), caption: z.string().min(0).max(1024).optional() })
  .strict();
export const documentPayloadSchema = z
  .object({ mediaId: z.uuid(), caption: z.string().min(0).max(1024).optional() })
  .strict();

export const messagePrioritySchema = z.enum(JOB_PRIORITIES);

/** Maximum payload size in bytes, mirroring `mj_payload_size` verbatim. */
export const MAX_PAYLOAD_BYTES = 2048;

/**
 * UTF-8 byte length of a string, computed by hand over UTF-16 code points -
 * this package ships no Node builtins (`Buffer.byteLength` is not an
 * option) and declares no DOM lib either (`TextEncoder` is untyped under
 * this package's `tsconfig` `lib: ["ES2023"]`, and adding DOM/Node globals
 * here would be the wrong fix for a package that must run unchanged in
 * EITHER environment). Standard UTF-8 encoding rule per code point:
 * 1 byte for U+0000-U+007F, 2 bytes for U+0080-U+07FF, 3 bytes for
 * U+0800-U+FFFF (excluding surrogate halves, counted individually below),
 * 4 bytes for a full surrogate pair (U+10000-U+10FFFF). A multi-byte emoji
 * is therefore counted at its real encoded byte length, never its JS
 * `.length` (UTF-16 code unit count).
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const codeUnit = text.codePointAt(i) as number;
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
      i += 1; // surrogate pair: codePointAt already consumed both halves
    }
  }
  return bytes;
}

/**
 * The `payload` field's byte envelope, applied to WHICHEVER kind-specific
 * shape parsed (text/image/document, all above) - kept as a standalone
 * assertion rather than folded into each branch so the 8,192-byte raise this
 * ADR reserves for the DB migration (0052 S1.1, NOT this dispatch's scope)
 * changes in exactly one place.
 */
function assertPayloadByteEnvelope(value: unknown, ctx: z.RefinementCtx): void {
  if (utf8ByteLength(JSON.stringify(value)) > MAX_PAYLOAD_BYTES) {
    ctx.addIssue({
      code: 'custom',
      message: `payload must not exceed ${String(MAX_PAYLOAD_BYTES)} bytes of JSON text (UTF-8)`,
    });
  }
}

// ---------------------------------------------------------------------
// POST /v1/messages
// ---------------------------------------------------------------------

/**
 * The mandatory `Idempotency-Key` header. Header names are lowercased by
 * every HTTP runtime this contract is validated against - the schema key is
 * lowercase to match. A blank/whitespace-only key is rejected the same as a
 * missing one: `.trim().min(1)` so `"   "` cannot masquerade as present.
 */
export const createMessageHeadersSchema = z.object({
  'idempotency-key': z.string().trim().min(1).max(255),
});
export type CreateMessageHeaders = z.infer<typeof createMessageHeadersSchema>;

/**
 * `.strict()` (P14 Unit U4 fix - this schema had documented itself as
 * `.strict()` in this module's own header since P11 but never actually was
 * one; zod's plain `z.object()` SILENTLY STRIPS unknown keys rather than
 * rejecting them, verified live against this exact schema before this
 * change). `.strict()` is the FIRST line of defence (module doc, verbatim)
 * against a client smuggling a pacing-exempt `origin`/`sendOrigin` field
 * (or any other field) through the body - `send_origin` is a server-only
 * parameter (`messages.service.ts`'s `CreateMessageServiceInput.sendOrigin`,
 * never read from this schema's output) and this closes the shape so no
 * client-supplied extra key can ever reach it silently.
 */
/**
 * `kind`-discriminated: `payload`'s shape is `textPayloadSchema` for
 * `'text'`, `imagePayloadSchema` for `'image'`, `documentPayloadSchema` for
 * `'document'` - a mismatched pair (e.g. `kind:'image'` with a `{ text }`
 * payload, or an image payload carrying `fileName`/`mimeType`) is rejected by
 * `.strict()` on the inner schema, never silently coerced. `z.discriminatedUnion`
 * on the OUTER object (not a `payload`-only union) so `recipient`/`priority`/
 * `scheduledAt` stay one shared shape across all three branches.
 */
export const createMessageInputSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('text'),
        recipient: recipientSchema,
        payload: textPayloadSchema,
        priority: messagePrioritySchema,
        scheduledAt: z.iso.datetime().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('image'),
        recipient: recipientSchema,
        payload: imagePayloadSchema,
        priority: messagePrioritySchema,
        scheduledAt: z.iso.datetime().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('document'),
        recipient: recipientSchema,
        payload: documentPayloadSchema,
        priority: messagePrioritySchema,
        scheduledAt: z.iso.datetime().optional(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    assertPayloadByteEnvelope(value.payload, ctx);
  });
export type CreateMessageInput = z.infer<typeof createMessageInputSchema>;

/**
 * Response envelope for a created message (blueprint, verbatim):
 * `201 { data: { id: public_id (uuidv7), status: "queued" } }`. `status` is
 * a single literal here (not the full `PgJobStatus` union) because a freshly
 * created job is always `queued` at the moment this response is built - a
 * job cannot be created directly into any other status.
 */
export const createMessageOutputSchema = successEnvelope(
  z.object({
    id: z.uuid(),
    status: z.literal('queued'),
  }),
);
export type CreateMessageOutput = z.infer<typeof createMessageOutputSchema>;

export const createMessageContract = oc
  .route({ method: 'POST', path: '/v1/messages' })
  .input(createMessageInputSchema)
  .output(createMessageOutputSchema);

// ---------------------------------------------------------------------
// POST /v1/messages/:id/unresolved/retry and .../discard (P12 Unit U5)
// ---------------------------------------------------------------------

/**
 * The human two-choice path out of `blocked_needs_review` (phase P12 step
 * 8). Same `Idempotency-Key`-as-its-own-header-schema idiom as
 * `createMessageHeadersSchema` above, for the same reason: the route must
 * reject a missing/blank key before any DB call, never fold it into a body
 * the route reads only after starting work. Reused verbatim for both
 * `retry` and `discard` - both actions share the identical mandatory-header
 * requirement, not two independently-drifting schemas.
 */
export const unresolvedActionHeadersSchema = createMessageHeadersSchema;
export type UnresolvedActionHeaders = CreateMessageHeaders;

/**
 * Both routes take no body - the `:id` (the job's `public_id`) is a
 * route-local path parameter, not part of this schema, matching how
 * `createMessageContract` above keeps `instanceId` OUT of its oRPC input
 * (a route-local zod schema owns it, see `messages.routes-support.ts`'s
 * `messageQuerySchema`). Not modelled as an `oc.route` path-param shape:
 * no existing contract in this package does that yet (verified - `oc.route`
 * is only ever given a fixed, literal `path` here), so this unit does not
 * introduce a new pattern with zero precedent.
 */
export const retryUnresolvedOutputSchema = successEnvelope(
  z.object({
    id: z.uuid(),
    status: z.literal('queued'),
  }),
);
export type RetryUnresolvedOutput = z.infer<typeof retryUnresolvedOutputSchema>;

export const discardUnresolvedOutputSchema = successEnvelope(
  z.object({
    id: z.uuid(),
    status: z.literal('cancelled'),
  }),
);
export type DiscardUnresolvedOutput = z.infer<typeof discardUnresolvedOutputSchema>;

export const retryUnresolvedContract = oc
  .route({ method: 'POST', path: '/v1/messages/{id}/unresolved/retry' })
  .output(retryUnresolvedOutputSchema);

export const discardUnresolvedContract = oc
  .route({ method: 'POST', path: '/v1/messages/{id}/unresolved/discard' })
  .output(discardUnresolvedOutputSchema);

export const messagesContract = {
  create: createMessageContract,
  retryUnresolved: retryUnresolvedContract,
  discardUnresolved: discardUnresolvedContract,
} as const;
