import type { z } from 'zod';
import { adminQueueSummarySchema } from '@wp/contracts';
import { adminFetch } from '../../lib/api-client.js';

/** features/queue/api.ts (P28 Unit U6, step 9) - `GET /admin/v1/queue/summary`. */
export type AdminQueueSummary = z.infer<typeof adminQueueSummarySchema>;

export function getQueueSummary(): Promise<AdminQueueSummary> {
  return adminFetch<AdminQueueSummary>('/admin/v1/queue/summary');
}
