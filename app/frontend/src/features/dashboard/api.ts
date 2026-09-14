import type { z } from 'zod';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { dashboardSummaryDataSchema } from '@wp/contracts';
import { dashboardKeys } from './keys.js';
import { apiFetch } from '../../lib/api-client.js';

/**
 * features/dashboard/api.ts (P05 U5, phase step 9; P17 U5 wires the real
 * route; P26b C1 fix round MINOR-13) - `GET /v1/dashboard/summary`. The
 * response type is INFERRED from `@wp/contracts`' `dashboardSummaryDataSchema`
 * (never hand-typed), same idiom as every sibling `api.ts`
 * (`features/wallet/api.ts`, `features/groups/api.ts`) - a hand-typed
 * interface can drift from the contract with no signal. `staleTime` is a
 * short 15s window - real data can go stale between pushes, but a
 * push-driven invalidation should not be fighting an `Infinity` staleTime
 * that would otherwise serve the cached value forever.
 */
export type DashboardSummary = z.infer<typeof dashboardSummaryDataSchema>;

const SUMMARY_STALE_TIME_MS = 15_000;

function getDashboardSummary(): Promise<DashboardSummary> {
  return apiFetch<DashboardSummary>('/v1/dashboard/summary');
}

export function useDashboardSummary(): UseQueryResult<DashboardSummary> {
  return useQuery({
    queryKey: dashboardKeys.summary(),
    queryFn: getDashboardSummary,
    staleTime: SUMMARY_STALE_TIME_MS,
  });
}
