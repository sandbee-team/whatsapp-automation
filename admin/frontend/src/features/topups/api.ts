import type { z } from 'zod';
import { adminTopupItemSchema } from '@wp/contracts';
import { adminFetch, adminMutate } from '../../lib/api-client.js';
import type { MutationResult } from '../clients/api.js';

/**
 * features/topups/api.ts (P28 Unit U6, step 9) - `/admin/v1/topups/*`. The
 * response is re-parsed with `adminTopupItemSchema` (`.strict()`) so a
 * server payload that grew an `externalRef` field would FAIL to parse rather
 * than silently render it - the schema itself is the enforcement, not just
 * the component's own field list.
 */
export type AdminTopupItem = z.infer<typeof adminTopupItemSchema>;

export interface TopupsListPage {
  items: AdminTopupItem[];
  nextCursor: string | null;
}

export type TopupStatus = 'pending' | 'approved' | 'rejected';

/**
 * Each item is parsed with `adminTopupItemSchema.strict()` individually and
 * with `.strip()` semantics applied via `omit`-free re-parse: a row carrying
 * an unplanned field (e.g. a drifted/malicious `externalRef`) is dropped
 * from the page entirely rather than failing the WHOLE list - one bad row
 * must never blank the screen for every other pending top-up.
 */
export async function listTopups(status: TopupStatus, cursor?: string): Promise<TopupsListPage> {
  const params = new URLSearchParams();
  params.set('limit', '50');
  params.set('status', status);
  if (cursor) params.set('cursor', cursor);
  const page = await adminFetch<{ items: unknown[]; nextCursor: string | null }>(
    `/admin/v1/topups?${params.toString()}`,
  );
  const items: AdminTopupItem[] = [];
  for (const item of page.items) {
    const result = adminTopupItemSchema.safeParse(item);
    if (result.success) items.push(result.data);
  }
  return { items, nextCursor: page.nextCursor };
}

export function approveTopup(
  id: string,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(`/admin/v1/topups/${id}/approve`, { reason }, { idempotencyKey });
}

export function rejectTopup(
  id: string,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(`/admin/v1/topups/${id}/reject`, { reason }, { idempotencyKey });
}
