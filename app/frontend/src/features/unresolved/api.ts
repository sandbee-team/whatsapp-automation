import { unresolvedActionHeadersSchema, type UnresolvedActionHeaders } from '@wp/contracts';
import type { PgJobStatus } from '@wp/domain';
import { apiFetch } from '../../lib/api-client.js';

/**
 * features/unresolved/api.ts (P12 U6a) - the client side of `POST
 * /v1/messages/:id/unresolved/retry` and `.../discard`
 * (`unresolved.routes.ts`). Both routes return the same `{ id, status }`
 * envelope shape as `sendSuccess(reply, requestId, { id: result.publicId,
 * status: result.status }, 200)`; `@wp/contracts` exports no dedicated
 * OUTPUT schema for either route (only `unresolvedActionHeadersSchema` for
 * the request), so `UnresolvedActionResult` is hand-typed here the same
 * way `features/messages/api.ts`'s `warning?` extension is - never a
 * fabricated schema import.
 *
 * NO LIST ROUTE: there is no `GET` route for unresolved sends anywhere in
 * `unresolved.routes.ts` (grepped - only the two POST actions exist) and
 * P12's step 8/9 table adds none. `fetchUnresolvedSends` below is the ONE
 * clearly-named function `useUnresolvedSends.ts` calls for the list source;
 * it returns an honest "unavailable" result rather than fabricating rows or
 * silently returning an always-empty list indistinguishable from "really
 * zero" - same honesty precedent as `Composer.tsx`'s account-picker gap and
 * `instances-screen.tsx`'s empty state doc comment.
 */

export interface UnresolvedActionResult {
  id: string;
  status: PgJobStatus;
}

/** Builds the mandatory `Idempotency-Key` header from a caller-supplied key - validated client-side too. */
function idempotencyHeaders(idempotencyKey: string): Record<string, string> {
  const parsed: UnresolvedActionHeaders = unresolvedActionHeadersSchema.parse({
    'idempotency-key': idempotencyKey,
  });
  return { 'Idempotency-Key': parsed['idempotency-key'] };
}

export function retryUnresolved(
  jobPublicId: string,
  idempotencyKey: string,
): Promise<UnresolvedActionResult> {
  return apiFetch<UnresolvedActionResult>(
    `/v1/messages/${encodeURIComponent(jobPublicId)}/unresolved/retry`,
    { method: 'POST', headers: idempotencyHeaders(idempotencyKey) },
  );
}

export function discardUnresolved(
  jobPublicId: string,
  idempotencyKey: string,
): Promise<UnresolvedActionResult> {
  return apiFetch<UnresolvedActionResult>(
    `/v1/messages/${encodeURIComponent(jobPublicId)}/unresolved/discard`,
    { method: 'POST', headers: idempotencyHeaders(idempotencyKey) },
  );
}

/**
 * A single unresolved row - message public id and creation timestamp ONLY.
 * NEVER a phone number, JID, or message body/preview:
 * `unresolved-repo.ts#UnresolvedJobRow` (the only server-side shape this
 * could ever come from) itself carries no such field - `message_job_id`,
 * `message_job_created_at`, `instance_id`, `status`, nothing recipient- or
 * content-shaped. There is nothing to mask here (no phone/JID field exists
 * to run through `@wp/domain`'s `maskPhoneE164`), so none is imported.
 */
export interface UnresolvedSendRow {
  jobPublicId: string;
  createdAt: string;
  instanceId: string;
}

export type UnresolvedSendsSource = 'unavailable';

export interface UnresolvedSendsResult {
  /** Always `'unavailable'` today - see the NO LIST ROUTE doc above. Never fabricated data. */
  source: UnresolvedSendsSource;
  rows: UnresolvedSendRow[];
}

/**
 * The list source `useUnresolvedSends.ts` calls. No `GET` route exists for
 * this data yet (see module doc), so this resolves immediately to an
 * honest "unavailable" result with zero rows - never a fake/mocked row,
 * never an optimistic entry for an action that was never confirmed by a
 * fetch.
 */
export function fetchUnresolvedSends(instanceId: string): Promise<UnresolvedSendsResult> {
  // `instanceId` is part of the future real call's signature (a per-
  // instance list would need it as a query/path param) but unused until a
  // `GET` route exists - referenced here only to satisfy
  // `noUnusedParameters`/`no-unused-vars`, never silently dropped from the
  // signature.
  void instanceId;
  return Promise.resolve({ source: 'unavailable', rows: [] });
}
