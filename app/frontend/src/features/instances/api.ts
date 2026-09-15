import type { z } from 'zod';
import {
  createInstanceInputSchema,
  createInstanceOutputSchema,
  linkInstanceInputSchema,
  linkInstanceOutputSchema,
  linkStatusOutputSchema,
  noFreeSlotDetailsSchema,
  onlineInstanceOutputSchema,
  parkInstanceOutputSchema,
  refreshLinkOutputSchema,
  deleteInstanceOutputSchema,
  instanceCardOutputSchema,
  healthWhyOutputSchema,
} from '@wp/contracts';
import { apiFetch, ApiError } from '../../lib/api-client.js';

/**
 * features/instances/api.ts (P08 U7; P17 U5 added `fetchInstanceCard` /
 * `fetchHealthWhy`; 2026-09-15 added `deleteInstance`) - the instance
 * link/park/delete routes plus the two P17 read routes (`GET
 * /v1/instances/:id/card`, `GET /v1/instances/:id/health/why`). Every
 * response type is inferred FROM the imported `@wp/contracts` schemas
 * (never hand-typed), so a contract change is a compile error here, not a
 * silent drift.
 */

export type CreateInstanceInput = z.infer<typeof createInstanceInputSchema>;
export type CreateInstanceResult = z.infer<typeof createInstanceOutputSchema>['data'];

export type LinkInstanceInput = z.infer<typeof linkInstanceInputSchema>;
export type LinkInstanceResult = z.infer<typeof linkInstanceOutputSchema>['data'];

export type RefreshLinkResult = z.infer<typeof refreshLinkOutputSchema>['data'];

export type LinkStatusResult = z.infer<typeof linkStatusOutputSchema>['data'];

export type OnlineInstanceResult = z.infer<typeof onlineInstanceOutputSchema>['data'];

export type ParkInstanceResult = z.infer<typeof parkInstanceOutputSchema>['data'];

export type NoFreeSlotDetails = z.infer<typeof noFreeSlotDetailsSchema>;

/**
 * Type guard for the `NO_FREE_SLOT` 409 shape (`{ holders: [...] }`) on an
 * `ApiError.details`. Callers use this to decide whether to render the
 * holders list rather than a generic error - never parse `error.message`.
 */
export function isNoFreeSlotError(error: unknown): error is ApiError & {
  details: NoFreeSlotDetails;
} {
  if (!(error instanceof ApiError) || error.code !== 'NO_FREE_SLOT') return false;
  const parsed = noFreeSlotDetailsSchema.safeParse(error.details);
  return parsed.success;
}

export function createInstance(label: string): Promise<CreateInstanceResult> {
  return apiFetch<CreateInstanceResult>('/v1/instances', {
    method: 'POST',
    body: { label } satisfies CreateInstanceInput,
  });
}

export function link(instanceId: string, input: LinkInstanceInput): Promise<LinkInstanceResult> {
  return apiFetch<LinkInstanceResult>(`/v1/instances/${instanceId}/link`, {
    method: 'POST',
    body: input,
  });
}

export function refreshLink(instanceId: string): Promise<RefreshLinkResult> {
  return apiFetch<RefreshLinkResult>(`/v1/instances/${instanceId}/link/refresh`, {
    method: 'POST',
  });
}

export function linkStatus(instanceId: string): Promise<LinkStatusResult> {
  return apiFetch<LinkStatusResult>(`/v1/instances/${instanceId}/link-status`);
}

export function online(instanceId: string): Promise<OnlineInstanceResult> {
  return apiFetch<OnlineInstanceResult>(`/v1/instances/${instanceId}/online`, { method: 'POST' });
}

export function park(instanceId: string): Promise<ParkInstanceResult> {
  return apiFetch<ParkInstanceResult>(`/v1/instances/${instanceId}/park`, { method: 'POST' });
}

export type DeleteInstanceResult = z.infer<typeof deleteInstanceOutputSchema>['data'];

/**
 * Soft-deletes an instance (2026-09-15 founder request) - frees its
 * `max_registered_instances` plan slot and removes it from every list read
 * (`GET /v1/queue-status`, the instance card). The backend guard 409s
 * `INVALID_STATE` for a still-`linked` instance; callers only ever offer
 * this action for an already-unlinked/parked one (see
 * `InstanceDetailHeader`'s own `canDelete` check) so a user should never hit
 * that guard through the UI.
 */
export function deleteInstance(instanceId: string): Promise<DeleteInstanceResult> {
  return apiFetch<DeleteInstanceResult>(`/v1/instances/${instanceId}`, { method: 'DELETE' });
}

export type InstanceCardResult = z.infer<typeof instanceCardOutputSchema>['data'];

export type HealthWhyResult = z.infer<typeof healthWhyOutputSchema>['data'];

export function fetchInstanceCard(instanceId: string): Promise<InstanceCardResult> {
  return apiFetch<InstanceCardResult>(`/v1/instances/${instanceId}/card`);
}

export function fetchHealthWhy(instanceId: string): Promise<HealthWhyResult> {
  return apiFetch<HealthWhyResult>(`/v1/instances/${instanceId}/health/why`);
}
