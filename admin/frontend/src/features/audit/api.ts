import type { z } from 'zod';
import { adminStaffAuditItemSchema } from '@wp/contracts';
import { adminFetch } from '../../lib/api-client.js';

/** features/audit/api.ts (P28 Unit U6, step 9) - `GET /admin/v1/audit`. */
export type AdminStaffAuditItem = z.infer<typeof adminStaffAuditItemSchema>;

export interface AuditListPage {
  items: AdminStaffAuditItem[];
  nextCursor: string | null;
}

export interface ListAuditFilters {
  clientId?: string;
  staffId?: string;
  action?: string;
  cursor?: string;
}

export function listAudit(filters: ListAuditFilters = {}): Promise<AuditListPage> {
  const params = new URLSearchParams();
  params.set('limit', '50');
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.clientId) params.set('clientId', filters.clientId);
  if (filters.staffId) params.set('staffId', filters.staffId);
  if (filters.action) params.set('action', filters.action);
  return adminFetch<AuditListPage>(`/admin/v1/audit?${params.toString()}`);
}
