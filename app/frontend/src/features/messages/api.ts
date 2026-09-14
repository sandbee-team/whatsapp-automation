import type { z } from 'zod';
import { createMessageInputSchema, createMessageOutputSchema } from '@wp/contracts';
import { apiFetch } from '../../lib/api-client.js';

/**
 * features/messages/api.ts (P11 U6a) - the send-path MVP's ONE client call,
 * `POST /v1/messages?instanceId=...` (route + query param confirmed in
 * `app/backend/src/modules/messages/messages.routes.ts` /
 * `messages.routes-support.ts#instanceIdFrom` - a flat contract with no
 * `instanceId` in the body, modelled as a required query string param, NOT
 * a route param). `createMessageResultSchema` below is intentionally wider
 * than `@wp/contracts`' own `createMessageOutputSchema` (which only
 * describes the 201 shape): the 202 `INSTANCE_OFFLINE` warning path is the
 * SAME success envelope with one extra optional field
 * (`messages.service.ts#CreateMessageServiceResult.warning`), never a
 * separate error path - `apiFetch` already treats any 2xx as success and
 * returns `data` unchanged, so this type only needs to add `warning?`.
 */

export type CreateMessageInput = z.infer<typeof createMessageInputSchema>;
export type CreateMessageResult = z.infer<typeof createMessageOutputSchema>['data'] & {
  /** Present only for a `202` response - the job WAS created and queued (never an error). */
  warning?: 'INSTANCE_OFFLINE';
};

export function createMessage(
  instanceId: string,
  input: CreateMessageInput,
  idempotencyKey: string,
): Promise<CreateMessageResult> {
  return apiFetch<CreateMessageResult>(
    `/v1/messages?instanceId=${encodeURIComponent(instanceId)}`,
    {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
    },
  );
}
