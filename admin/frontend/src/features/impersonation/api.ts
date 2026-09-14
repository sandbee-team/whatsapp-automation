import type { z } from 'zod';
import {
  adminImpersonationTokenDataSchema,
  adminGrantImpersonationInputSchema,
} from '@wp/contracts';
import { adminMutate } from '../../lib/api-client.js';
import type { MutationResult } from '../clients/api.js';

/**
 * features/impersonation/api.ts (P28 Unit U6, step 9) - grant/revoke/elevate
 * support-session mutations. `panelUrl` carries a short-lived bearer
 * credential in its URL fragment and is never rendered as text or logged
 * (design brief, C1 review round 2 MAJOR 2): callers open it via
 * `window.open(panelUrl, '_blank', 'noopener')` and it is nullable (a
 * replayed mint/elevate never re-emits the token).
 */
export type ImpersonationTokenData = z.infer<typeof adminImpersonationTokenDataSchema>;
export type GrantImpersonationInput = z.infer<typeof adminGrantImpersonationInputSchema>;

export function grantImpersonation(
  clientId: string,
  input: Omit<GrantImpersonationInput, 'reason'>,
  reason: string,
  idempotencyKey: string,
): Promise<ImpersonationTokenData> {
  return adminMutate(
    `/admin/v1/clients/${clientId}/impersonation`,
    { reason, ...input },
    { idempotencyKey },
  );
}

export function revokeImpersonation(
  grantId: string,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(`/admin/v1/impersonation/${grantId}/revoke`, { reason }, { idempotencyKey });
}

export function elevateImpersonation(
  grantId: string,
  reason: string,
  idempotencyKey: string,
): Promise<ImpersonationTokenData> {
  return adminMutate(`/admin/v1/impersonation/${grantId}/elevate`, { reason }, { idempotencyKey });
}
