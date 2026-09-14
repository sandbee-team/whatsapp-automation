import type { z } from 'zod';
import {
  createWebhookEndpointInputSchema,
  createWebhookEndpointOutputSchema,
  listWebhookEndpointsOutputSchema,
  patchWebhookEndpointOutputSchema,
  deleteWebhookEndpointOutputSchema,
  testWebhookEndpointOutputSchema,
} from '@wp/contracts';
import { apiFetch } from '../../lib/api-client.js';

/**
 * features/webhooks/api.ts (P15 U6, step 9; U6b, step 10) - the client side
 * of the full `webhooksContract` (`create`/`list`/`patch`/`delete`/`test`).
 * Every response type is inferred FROM the imported `@wp/contracts` schemas
 * (never hand-typed), same idiom as `features/instances/api.ts`.
 *
 * `patch`/`remove`/`testSend` were carried as a follow-up in U6 because the
 * shared `lib/api-client.ts#apiFetch` only supported `GET`/`POST` at the
 * time; U6b widened `RequestOptions['method']` to include `PATCH`/`DELETE`
 * (`GET`/`POST`/`PATCH`/`DELETE` covers every route this contract defines),
 * so all five routes are wired here now.
 *
 * `create`'s response carries `secret` in the clear ONCE (contract doc
 * comment: "secrets shown once") - callers must hand the whole result to
 * `secret-once-dialog.tsx` and never persist `secret` beyond that render.
 */
export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointInputSchema>;
export type CreateWebhookEndpointResult = z.infer<typeof createWebhookEndpointOutputSchema>['data'];
export type WebhookEndpointSummary = z.infer<
  typeof listWebhookEndpointsOutputSchema
>['data']['items'][number];
export type PatchWebhookEndpointResult = z.infer<typeof patchWebhookEndpointOutputSchema>['data'];
export type DeleteWebhookEndpointResult = z.infer<typeof deleteWebhookEndpointOutputSchema>['data'];
export type TestWebhookEndpointResult = z.infer<typeof testWebhookEndpointOutputSchema>['data'];

export function createWebhookEndpoint(
  input: CreateWebhookEndpointInput,
): Promise<CreateWebhookEndpointResult> {
  return apiFetch<CreateWebhookEndpointResult>('/v1/webhooks/endpoints', {
    method: 'POST',
    body: createWebhookEndpointInputSchema.parse(input),
  });
}

export function listWebhookEndpoints(): Promise<WebhookEndpointSummary[]> {
  return apiFetch<{ items: WebhookEndpointSummary[] }>('/v1/webhooks/endpoints').then(
    (result) => result.items,
  );
}

/** `PATCH /v1/webhooks/endpoints/{id}` - re-enable path passes `{ enabled: true }`. */
export function patchWebhookEndpoint(
  id: string,
  patch: { enabled?: boolean; url?: string; events?: WebhookEndpointSummary['events'] },
): Promise<PatchWebhookEndpointResult> {
  return apiFetch<PatchWebhookEndpointResult>(`/v1/webhooks/endpoints/${id}`, {
    method: 'PATCH',
    body: patch,
  });
}

/** `DELETE /v1/webhooks/endpoints/{id}` - permanently removes the endpoint. */
export function deleteWebhookEndpoint(id: string): Promise<DeleteWebhookEndpointResult> {
  return apiFetch<DeleteWebhookEndpointResult>(`/v1/webhooks/endpoints/${id}`, {
    method: 'DELETE',
  });
}

/**
 * `POST /v1/webhooks/endpoints/{id}/test` - fires one synthetic delivery
 * through the same sign+dispatch path a real event uses. Returns the actual
 * `webhook_deliveries` row id/status, never a fabricated "ok" - the caller
 * states the delivery as queued/attempted, never as instant/guaranteed.
 */
export function testWebhookEndpoint(id: string): Promise<TestWebhookEndpointResult> {
  return apiFetch<TestWebhookEndpointResult>(`/v1/webhooks/endpoints/${id}/test`, {
    method: 'POST',
  });
}
