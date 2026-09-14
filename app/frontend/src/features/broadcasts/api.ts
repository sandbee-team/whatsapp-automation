import type { z } from 'zod';
import { useQuery, useQueries, type UseQueryResult } from '@tanstack/react-query';
import {
  broadcastDetailSchema,
  broadcastSummarySchema,
  createBroadcastInputSchema,
  cancelBroadcastInputSchema,
  broadcastPreflightSchema,
  listBroadcastsOutputSchema,
} from '@wp/contracts';
import { apiFetch, apiFetchRaw } from '../../lib/api-client.js';
import { broadcastKeys } from './keys.js';
import { fetchInstanceCard } from '../instances/api.js';
import { useQueueStatus } from '../wallet/api.js';

/**
 * features/broadcasts/api.ts (P23a Unit U3, step 2) - the client side of the
 * broadcast/campaign surface plus pre-flight. Every response type is
 * inferred FROM the imported `@wp/contracts` schemas (never hand-typed),
 * same idiom as `features/wallet/api.ts`/`features/contacts/api.ts`. The
 * backend pre-flight route is built in parallel against the SAME frozen
 * contract this file binds to - `preflightBroadcast` re-parses the response
 * with `broadcastPreflightSchema` so a drifted server payload throws instead
 * of silently rendering.
 */
export type BroadcastDetail = z.infer<typeof broadcastDetailSchema>;
export type BroadcastSummary = z.infer<typeof broadcastSummarySchema>;
export type CreateBroadcastInput = z.infer<typeof createBroadcastInputSchema>;
export type CancelBroadcastInput = z.infer<typeof cancelBroadcastInputSchema>;
export type BroadcastPreflight = z.infer<typeof broadcastPreflightSchema>;

export interface BroadcastsListPage {
  items: BroadcastSummary[];
  nextCursor?: string;
}

/**
 * `GET /v1/broadcasts` - same keyset-list idiom as `features/contacts/api.ts`'s
 * `listContacts`: the envelope's `data` is `{ items: [...] }` (never a bare
 * array - see `listBroadcastsOutputSchema`'s own doc comment), and the
 * keyset `nextCursor` travels on `meta`. The full envelope is re-parsed with
 * `listBroadcastsOutputSchema` so a drifted server payload throws instead of
 * silently rendering a bogus row (this is the exact shape mismatch that
 * crashed the `/broadcasts` screen for every tenant - see the schema's doc
 * comment history).
 */
export async function listBroadcasts(cursor?: string, limit = 25): Promise<BroadcastsListPage> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);

  const response = await apiFetchRaw(`/v1/broadcasts?${params.toString()}`, {
    accept: 'application/json',
  });
  const json = listBroadcastsOutputSchema.parse(await response.json());
  return { items: json.data.items, nextCursor: json.meta.nextCursor };
}

export function getBroadcast(id: string): Promise<BroadcastDetail> {
  return apiFetch<BroadcastDetail>(`/v1/broadcasts/${id}`);
}

export interface UseBroadcastOptions {
  refetchIntervalMs?: number;
}

export function useBroadcast(
  id: string,
  options: UseBroadcastOptions = {},
): UseQueryResult<BroadcastDetail> {
  return useQuery({
    queryKey: broadcastKeys.detail(id),
    queryFn: () => getBroadcast(id),
    refetchInterval: options.refetchIntervalMs,
  });
}

export function createBroadcast(
  input: CreateBroadcastInput,
  idempotencyKey: string,
): Promise<BroadcastDetail> {
  return apiFetch<BroadcastDetail>('/v1/broadcasts', {
    method: 'POST',
    body: createBroadcastInputSchema.parse(input),
    headers: { 'idempotency-key': idempotencyKey },
  });
}

/** `POST /v1/broadcasts/{id}/preflight` - re-parses the response so a drifted server payload throws instead of rendering. */
export async function preflightBroadcast(id: string): Promise<BroadcastPreflight> {
  const result = await apiFetch<unknown>(`/v1/broadcasts/${id}/preflight`, { method: 'POST' });
  return broadcastPreflightSchema.parse(result);
}

export function startBroadcast(id: string, idempotencyKey: string): Promise<BroadcastDetail> {
  return apiFetch<BroadcastDetail>(`/v1/broadcasts/${id}/start`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function pauseBroadcast(id: string, idempotencyKey: string): Promise<BroadcastDetail> {
  return apiFetch<BroadcastDetail>(`/v1/broadcasts/${id}/pause`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function resumeBroadcast(id: string, idempotencyKey: string): Promise<BroadcastDetail> {
  return apiFetch<BroadcastDetail>(`/v1/broadcasts/${id}/resume`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function cancelBroadcast(
  id: string,
  idempotencyKey: string,
  reason?: string,
): Promise<BroadcastDetail> {
  return apiFetch<BroadcastDetail>(`/v1/broadcasts/${id}/cancel`, {
    method: 'POST',
    body: cancelBroadcastInputSchema.parse({ reason }),
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export interface InstanceOption {
  instanceId: string;
  label: string;
  warmupTier: number;
  effDailyCap: number;
  todaySent: number;
}

/**
 * The tenant's instances, sourced from `useQueueStatus()` (there is NO
 * `GET /v1/instances` list route yet - documented P11 gap) with each label
 * resolved per id via `fetchInstanceCard` (`useQueries`). A label falls back
 * to the raw id while its card is still loading.
 */
export function useInstanceOptions(): {
  data: InstanceOption[];
  isLoading: boolean;
} {
  const queueStatus = useQueueStatus();
  const instanceIds = queueStatus.data?.instances.map((instance) => instance.instanceId) ?? [];

  const cardQueries = useQueries({
    queries: instanceIds.map((instanceId) => ({
      queryKey: ['broadcasts', 'instance-card', instanceId] as const,
      queryFn: () => fetchInstanceCard(instanceId),
    })),
  });

  const data: InstanceOption[] = instanceIds.map((instanceId, index) => {
    const card = cardQueries[index]?.data;
    return {
      instanceId,
      label: card?.label ?? instanceId,
      warmupTier: card?.warmupTier ?? 0,
      effDailyCap: card?.effDailyCap ?? 0,
      todaySent: card?.todaySent ?? 0,
    };
  });

  return {
    data,
    isLoading: queueStatus.isLoading || cardQueries.some((query) => query.isLoading),
  };
}
