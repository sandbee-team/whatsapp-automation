import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from '../envelope.js';

/**
 * app/dashboard.ts (P17 Unit U2, step 2) - `GET /v1/dashboard/summary`. The
 * output shape MUST match `app/frontend/src/features/dashboard/api.ts`'s
 * `DashboardSummary` interface verbatim: exactly `{connectedNumbers, queued,
 * sent}` (that P05 U5 stub already ships a typed zero-state pending this
 * route - see its own header comment). `.strict()` so no future field can
 * silently drift the two shapes apart without a contract-side signal.
 */

export const dashboardSummaryDataSchema = z
  .object({
    connectedNumbers: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
  })
  .strict();
export type DashboardSummaryData = z.infer<typeof dashboardSummaryDataSchema>;

export const dashboardSummaryOutputSchema = successEnvelope(dashboardSummaryDataSchema);
export type DashboardSummaryOutput = z.infer<typeof dashboardSummaryOutputSchema>;

export const dashboardSummaryContract = oc
  .route({ method: 'GET', path: '/v1/dashboard/summary' })
  .output(dashboardSummaryOutputSchema);

export const dashboardContract = {
  summary: dashboardSummaryContract,
} as const;
