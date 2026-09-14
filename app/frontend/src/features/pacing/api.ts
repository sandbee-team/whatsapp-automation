import {
  ackFanoutInputSchema,
  type AckFanoutInput,
  type AckFanoutOutput,
  type PendingFanoutAcksOutput,
} from '@wp/contracts';
import { apiFetch } from '../../lib/api-client.js';

/**
 * features/pacing/api.ts (P14 Unit U7, step 3) - the client side of `GET
 * /v1/pacing/fanout-acks/pending` and `POST /v1/pacing/fanout-acks`
 * (`app/backend/src/modules/pacing/routes/ack-fanout.routes.ts`). Counts
 * only, per that contract's own doc - `PendingFanoutItem` carries no field a
 * caller could even populate with message body content (the server-side
 * `pendingFanoutAckItemSchema` declares `sampleBody` as `z.never()`).
 */

export interface PendingFanoutItem {
  localDate: string;
  fingerprintHex: string;
  recipientCount: number;
}

export function fetchPendingFanoutAcks(): Promise<PendingFanoutItem[]> {
  return apiFetch<PendingFanoutAcksOutput['data']>('/v1/pacing/fanout-acks/pending').then(
    (data) => data.items,
  );
}

export function ackFanoutItem(item: PendingFanoutItem): Promise<boolean> {
  const input: AckFanoutInput = ackFanoutInputSchema.parse({
    localDate: item.localDate,
    fingerprint: item.fingerprintHex,
  });
  return apiFetch<AckFanoutOutput['data']>('/v1/pacing/fanout-acks', {
    method: 'POST',
    body: input,
  }).then((data) => data.acked);
}
