import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from './envelope.js';

/**
 * pacing.ts (P14 Unit U7, step 8) - the duplicate-fan-out ack surface
 * contracts: `POST /v1/pacing/fanout-acks` (a staff member confirms an
 * exact-duplicate message really is intended for N recipients) and
 * `GET /v1/pacing/fanout-acks/pending` (what is currently held on
 * NEEDS_HUMAN_ACK, waiting for that confirmation).
 *
 * PII/copy discipline (binding, task instruction verbatim): the pending list
 * returns COUNTS only - `recipientCount`, never `sampleBody` or any message
 * text. The panel shows "this exact message is going to N recipients", never
 * the message itself, so this contract has no field a caller could even
 * populate with body content.
 *
 * `fingerprint` travels as a hex string on the wire (the server-side value
 * is a `bytea` SHA-256 digest, `modules/pacing/content/fingerprint.ts`'s
 * `computeFingerprint`) - `.strict()` on both bodies, matching
 * `createMessageInputSchema`'s own fix (P14 Unit U4) against a client
 * smuggling an extra field through.
 */

const localDateSchema = z.iso.date();
const fingerprintHexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, 'fingerprint must be a 64-character lowercase hex SHA-256 digest');

export const ackFanoutInputSchema = z
  .object({
    localDate: localDateSchema,
    fingerprint: fingerprintHexSchema,
  })
  .strict();
export type AckFanoutInput = z.infer<typeof ackFanoutInputSchema>;

export const ackFanoutOutputSchema = successEnvelope(
  z.object({
    localDate: localDateSchema,
    fingerprint: fingerprintHexSchema,
    acked: z.boolean(),
  }),
);
export type AckFanoutOutput = z.infer<typeof ackFanoutOutputSchema>;

export const ackFanoutContract = oc
  .route({ method: 'POST', path: '/v1/pacing/fanout-acks' })
  .input(ackFanoutInputSchema)
  .output(ackFanoutOutputSchema);

/**
 * `sampleBody` is declared `z.never().optional()` (never `z.undefined()`,
 * so a caller cannot even satisfy this schema by explicitly passing
 * `undefined` for a key named after the thing this endpoint must never
 * carry) purely to make the "no message body in this response" contract
 * mechanically checkable at the type layer, not just a doc comment.
 */
export const pendingFanoutAckItemSchema = z.object({
  localDate: localDateSchema,
  fingerprintHex: fingerprintHexSchema,
  recipientCount: z.number().int().nonnegative(),
  sampleBody: z.never().optional(),
});

export const pendingFanoutAcksOutputSchema = successEnvelope(
  z.object({
    items: z.array(pendingFanoutAckItemSchema),
  }),
);
export type PendingFanoutAcksOutput = z.infer<typeof pendingFanoutAcksOutputSchema>;

export const pendingFanoutAcksContract = oc
  .route({ method: 'GET', path: '/v1/pacing/fanout-acks/pending' })
  .output(pendingFanoutAcksOutputSchema);

export const pacingContract = {
  ackFanout: ackFanoutContract,
  pendingFanoutAcks: pendingFanoutAcksContract,
} as const;
