import type { z } from 'zod';
import { useInfiniteQuery, type UseInfiniteQueryResult } from '@tanstack/react-query';
import {
  groupSummarySchema,
  listGroupsResponseSchema,
  requestGroupSyncResponseSchema,
  requestGroupLeaveResponseSchema,
} from '@wp/contracts';
import { apiFetch, apiFetchRaw } from '../../lib/api-client.js';
import { groupKeys } from './keys.js';

/**
 * features/groups/api.ts (P24 groups-messaging, Unit U5) - the client side
 * of the tenant group surface. Every response type is inferred FROM the
 * imported `@wp/contracts` schemas (never hand-typed), same idiom as
 * `features/broadcasts/api.ts`. `listGroups`/`useGroupList` follow the
 * SAME keyset `useInfiniteQuery` idiom as `broadcast-list.tsx`'s own list
 * query - a realtime invalidation of `groupKeys.list(instanceId)` re-runs
 * every already-fetched page in place rather than appending, so a refetch is
 * never a duplicate-row hazard (same reasoning as `broadcast-list.tsx`'s doc
 * comment).
 */
export type GroupSummary = z.infer<typeof groupSummarySchema>;
export type ListGroupsResponse = z.infer<typeof listGroupsResponseSchema>;
export type RequestGroupSyncResponse = z.infer<typeof requestGroupSyncResponseSchema>;
export type RequestGroupLeaveResponse = z.infer<typeof requestGroupLeaveResponseSchema>;

/** `GET /v1/instances/{id}/groups` - re-parses the response so a drifted server payload throws instead of rendering. */
export async function listGroups(
  instanceId: string,
  cursor: string | undefined,
  limit = 25,
): Promise<ListGroupsResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);

  const response = await apiFetchRaw(`/v1/instances/${instanceId}/groups?${params.toString()}`, {
    accept: 'application/json',
  });
  const json = (await response.json()) as { data: unknown };
  return listGroupsResponseSchema.parse(json.data);
}

export function useGroupList(instanceId: string): UseInfiniteQueryResult<{
  pages: ListGroupsResponse[];
}> {
  return useInfiniteQuery({
    queryKey: groupKeys.list(instanceId),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      listGroups(instanceId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: instanceId.trim().length > 0,
  });
}

/**
 * `POST /v1/instances/{id}/groups/sync` - mints a fresh idempotency key per
 * attempt, same idiom as `broadcast-detail.tsx#runAction`. A 429
 * `RATE_LIMITED` refusal surfaces as `ApiError` with `code: 'RATE_LIMITED'`;
 * the exact retry time is a `Retry-After` HTTP header (a transport-layer
 * concern outside `apiFetch`'s JSON envelope, see `@wp/contracts`'s own doc
 * comment on `requestGroupSyncResponseSchema`) - the caller already knows
 * the list's own `sync.nextSyncAfter` from the last successful list fetch
 * and renders the rate-limited copy from that value rather than parsing the
 * header here.
 */
export async function requestGroupSync(
  instanceId: string,
  idempotencyKey: string,
): Promise<RequestGroupSyncResponse> {
  const result = await apiFetch<unknown>(`/v1/instances/${instanceId}/groups/sync`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
  });
  return requestGroupSyncResponseSchema.parse(result);
}

/** `PATCH /v1/groups/{id}/send-enabled` - a 422 `GROUP_NOT_SENDABLE` surfaces as `ApiError` with `details` shaped by `groupNotSendableDetailsSchema`. */
export async function setGroupSendEnabled(
  id: string,
  sendEnabled: boolean,
  idempotencyKey: string,
): Promise<GroupSummary> {
  const result = await apiFetch<unknown>(`/v1/groups/${id}/send-enabled`, {
    method: 'PATCH',
    body: { sendEnabled },
    headers: { 'idempotency-key': idempotencyKey },
  });
  return groupSummarySchema.parse(result);
}

/** `POST /v1/groups/{id}/leave` - always allowed, idempotent. */
export async function requestGroupLeave(
  id: string,
  idempotencyKey: string,
): Promise<RequestGroupLeaveResponse> {
  const result = await apiFetch<unknown>(`/v1/groups/${id}/leave`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
  });
  return requestGroupLeaveResponseSchema.parse(result);
}
