import type { z } from 'zod';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  walletSummaryOutputSchema,
  createTopupRequestInputSchema,
  createTopupRequestOutputSchema,
  listTopupRequestsOutputSchema,
  queueStatusOutputSchema,
} from '@wp/contracts';
import { apiFetch } from '../../lib/api-client.js';
import { walletKeys } from './keys.js';

/**
 * features/wallet/api.ts (P19 Unit U5, step 7/9; P26b U5 additive) - `GET
 * /v1/wallet`, `POST /v1/wallet/topup-requests`, `GET
 * /v1/wallet/topup-requests` (the tenant's own request history, added for
 * the `/wallet` screen's history table) and `GET /v1/queue-status`. Every
 * response type is inferred FROM the imported `@wp/contracts` schemas
 * (never hand-typed), same idiom as `features/webhooks/api.ts`.
 */
export type WalletSummary = z.infer<typeof walletSummaryOutputSchema>['data'];
export type CreateTopupRequestInput = z.infer<typeof createTopupRequestInputSchema>;
export type CreateTopupRequestResult = z.infer<typeof createTopupRequestOutputSchema>['data'];
export type TopupRequestItem = z.infer<typeof listTopupRequestsOutputSchema>['data'][number];
export type QueueStatus = z.infer<typeof queueStatusOutputSchema>['data'];

const WALLET_SUMMARY_STALE_TIME_MS = 15_000;
const QUEUE_STATUS_STALE_TIME_MS = 15_000;

function getWalletSummary(): Promise<WalletSummary> {
  return apiFetch<WalletSummary>('/v1/wallet');
}

export function useWalletSummary(): UseQueryResult<WalletSummary> {
  return useQuery({
    queryKey: walletKeys.summary(),
    queryFn: getWalletSummary,
    staleTime: WALLET_SUMMARY_STALE_TIME_MS,
  });
}

export function createTopupRequest(
  input: CreateTopupRequestInput,
  idempotencyKey: string,
): Promise<CreateTopupRequestResult> {
  return apiFetch<CreateTopupRequestResult>('/v1/wallet/topup-requests', {
    method: 'POST',
    body: createTopupRequestInputSchema.parse(input),
    headers: { 'idempotency-key': idempotencyKey },
  });
}

function getQueueStatus(): Promise<QueueStatus> {
  return apiFetch<QueueStatus>('/v1/queue-status');
}

export function useQueueStatus(): UseQueryResult<QueueStatus> {
  return useQuery({
    queryKey: walletKeys.queueStatus(),
    queryFn: getQueueStatus,
    staleTime: QUEUE_STATUS_STALE_TIME_MS,
  });
}

/** `GET /v1/wallet/topup-requests` - the tenant's own top-up request history, newest first (server-ordered). */
function listTopupRequests(): Promise<TopupRequestItem[]> {
  return apiFetch<TopupRequestItem[]>('/v1/wallet/topup-requests');
}

export function useTopupRequests(): UseQueryResult<TopupRequestItem[]> {
  return useQuery({
    queryKey: walletKeys.topupRequests(),
    queryFn: listTopupRequests,
  });
}
