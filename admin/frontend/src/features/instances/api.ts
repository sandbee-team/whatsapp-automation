import type { z } from 'zod';
import { adminInstanceItemSchema, adminPacingOverrideInputSchema } from '@wp/contracts';
import { adminFetch, adminMutate } from '../../lib/api-client.js';
import type { MutationResult } from '../clients/api.js';

/**
 * features/instances/api.ts (P28 Unit U6, step 9) - `/admin/v1/instances/*`.
 */
export type AdminInstanceItem = z.infer<typeof adminInstanceItemSchema>;
export type PacingOverrideInput = z.infer<typeof adminPacingOverrideInputSchema>;

export interface InstancesListPage {
  items: AdminInstanceItem[];
  nextCursor: string | null;
}

export interface ListInstancesFilters {
  healthState?: string;
  clientId?: string;
  cursor?: string;
  limit?: number;
}

export function listInstances(filters: ListInstancesFilters = {}): Promise<InstancesListPage> {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit ?? 50));
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.healthState) params.set('healthState', filters.healthState);
  if (filters.clientId) params.set('clientId', filters.clientId);
  return adminFetch<InstancesListPage>(`/admin/v1/instances?${params.toString()}`);
}

export function pauseInstance(
  id: string,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(`/admin/v1/instances/${id}/pause`, { reason }, { idempotencyKey });
}

export function resumeInstance(
  id: string,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(`/admin/v1/instances/${id}/resume`, { reason }, { idempotencyKey });
}

export function pacingOverride(
  id: string,
  patch: Record<string, number>,
  expiresAt: string,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(
    `/admin/v1/instances/${id}/pacing-override`,
    { reason, patch, expiresAt },
    { idempotencyKey },
  );
}
