import type { z } from 'zod';
import {
  adminClientListItemSchema,
  adminClientDetailSchema,
  adminSetClientPricingInputSchema,
  adminSetClientLimitsInputSchema,
} from '@wp/contracts';
import { adminFetch, adminMutate, adminReadWithReason } from '../../lib/api-client.js';

/**
 * features/clients/api.ts (P28 Unit U6, step 9) - `/admin/v1/clients/*`.
 * Every response type is inferred FROM the imported `@wp/contracts` schemas.
 */
export type AdminClientListItem = z.infer<typeof adminClientListItemSchema>;
export type AdminClientDetail = z.infer<typeof adminClientDetailSchema>;
export type SetClientPricingInput = z.infer<typeof adminSetClientPricingInputSchema>;
export type SetClientLimitsInput = z.infer<typeof adminSetClientLimitsInputSchema>;

export interface ClientsListPage {
  items: AdminClientListItem[];
  nextCursor: string | null;
}

export interface ListClientsFilters {
  status?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

export function listClients(filters: ListClientsFilters = {}): Promise<ClientsListPage> {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit ?? 50));
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.status) params.set('status', filters.status);
  if (filters.q) params.set('q', filters.q);
  return adminFetch<ClientsListPage>(`/admin/v1/clients?${params.toString()}`);
}

export function getClient(id: string, reason?: string): Promise<AdminClientDetail> {
  return adminReadWithReason<AdminClientDetail>(`/admin/v1/clients/${id}`, reason);
}

export interface MutationResult {
  ok: true;
  replayed: boolean;
}

export function suspendClient(
  id: string,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(`/admin/v1/clients/${id}/suspend`, { reason }, { idempotencyKey });
}

export function reactivateClient(
  id: string,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(`/admin/v1/clients/${id}/reactivate`, { reason }, { idempotencyKey });
}

export function setClientPlan(
  id: string,
  planKey: string,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  // `method: 'PUT'` is load-bearing: the admin-backend proxy registers this
  // route as PUT (mutations.routes.ts), and `adminMutate` defaults to POST -
  // omitting it sent every plan change to a method the proxy does not serve.
  return adminMutate(
    `/admin/v1/clients/${id}/plan`,
    { reason, planKey },
    { idempotencyKey, method: 'PUT' },
  );
}

export function setClientLimits(
  id: string,
  input: Omit<SetClientLimitsInput, 'reason'>,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(
    `/admin/v1/clients/${id}/limits`,
    { reason, ...input },
    { idempotencyKey, method: 'PUT' },
  );
}

export function setClientPricing(
  id: string,
  overrideItems: Record<string, number>,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(
    `/admin/v1/clients/${id}/pricing`,
    { reason, overrideItems },
    { idempotencyKey, method: 'PUT' },
  );
}
