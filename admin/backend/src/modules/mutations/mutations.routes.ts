import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  suspendClientInputSchema,
  reactivateClientInputSchema,
  setClientLimitsInputSchema,
  setClientPricingInputSchema,
  setClientPlanInputSchema,
  creditClientWalletInputSchema,
  adjustClientWalletInputSchema,
  freezeClientWalletInputSchema,
  unfreezeClientWalletInputSchema,
  approveTopupInputSchema,
  rejectTopupInputSchema,
  pauseInstanceInputSchema,
  resumeInstanceInputSchema,
  pacingOverrideInputSchema,
  cancelCampaignInputSchema,
  revokeImpersonationInputSchema,
} from '@wp/contracts';
import { registerMutationProxy } from './mutation-proxy.js';
import {
  registerImpersonationMutations,
  type ImpersonationMutationDeps,
} from './impersonation.routes.js';

/**
 * modules/mutations/mutations.routes.ts (P28 Unit U4, step 8) - every admin
 * mutation, as DECLARATIONS. There is no per-route handler code here on
 * purpose: `mutation-proxy.ts` owns the whole pipeline (authenticate, RBAC,
 * validate, idempotency key, `callInternal`), so a new mutation cannot
 * accidentally skip a step by hand-rolling its own handler.
 *
 * Each input schema is IMPORTED from `internalContract`, never re-declared:
 * app-backend validates the same body against the same schema, so the two
 * sides cannot drift, and `reason` (mandatory in every one of them) is
 * enforced identically at both ends.
 *
 * THE OUTPUT SCHEMA. `internalContract`'s exported `*OutputSchema` values
 * are full success ENVELOPES (`{data, meta}`), while `callInternal` already
 * unwraps `data` before validating - so passing an envelope schema here
 * would reject every real response. These declarations therefore validate
 * the unwrapped result with the shape every internal mutation actually
 * returns: `{ replayed: boolean }` plus whatever else that route reports,
 * passed through. `replayed` is the part the admin panel needs (it is how
 * a retried action is shown as "already applied" rather than as a second
 * change), and it is asserted present rather than assumed.
 */

/**
 * The unwrapped internal mutation result. `replayed` is REQUIRED - it is
 * the load-bearing field (see the module header) - and `.passthrough()`
 * carries each route's extra reported fields without this file having to
 * re-declare seventeen slightly different result shapes. Passthrough is
 * safe HERE, unlike on a read projection: an internal MUTATION response
 * reports what it changed (ids, states, amounts), never a tenant's
 * recipient or message data.
 */
const internalMutationResult = z.object({ replayed: z.boolean() }).passthrough();

/**
 * `ImpersonationMutationDeps` (not the narrower `MutationProxyDeps`) because
 * the impersonation group needs `appPanelBaseUrl` - taking the wider type
 * here means a caller cannot wire mutations while forgetting the tenant
 * panel URL those three routes must build against.
 */
export function registerMutationRoutes(
  app: FastifyInstance,
  deps: ImpersonationMutationDeps,
): void {
  const clientPath =
    (suffix: string) =>
    (params: Record<string, string>): string =>
      `/internal/v1/clients/${params.id ?? ''}${suffix}`;
  const instancePath =
    (suffix: string) =>
    (params: Record<string, string>): string =>
      `/internal/v1/instances/${params.id ?? ''}${suffix}`;

  const specs = [
    // --- clients -------------------------------------------------------
    {
      method: 'POST' as const,
      path: '/admin/v1/clients/:id/suspend',
      action: 'clients.suspend' as const,
      internalPath: clientPath('/suspend'),
      inputSchema: suspendClientInputSchema,
    },
    {
      method: 'POST' as const,
      path: '/admin/v1/clients/:id/reactivate',
      action: 'clients.reactivate' as const,
      internalPath: clientPath('/reactivate'),
      inputSchema: reactivateClientInputSchema,
    },
    {
      method: 'PUT' as const,
      path: '/admin/v1/clients/:id/limits',
      action: 'clients.limits' as const,
      internalPath: clientPath('/limits'),
      inputSchema: setClientLimitsInputSchema,
    },
    {
      // `superadmin` only - pricing is the highest-blast-radius client knob.
      method: 'PUT' as const,
      path: '/admin/v1/clients/:id/pricing',
      action: 'clients.pricing' as const,
      internalPath: clientPath('/pricing'),
      inputSchema: setClientPricingInputSchema,
    },
    {
      method: 'PUT' as const,
      path: '/admin/v1/clients/:id/plan',
      action: 'clients.plan' as const,
      internalPath: clientPath('/plan'),
      inputSchema: setClientPlanInputSchema,
    },
    // --- wallet (real money) -------------------------------------------
    {
      method: 'POST' as const,
      path: '/admin/v1/clients/:id/wallet/credit',
      action: 'wallet.credit' as const,
      internalPath: clientPath('/wallet/credit'),
      inputSchema: creditClientWalletInputSchema,
    },
    {
      // `superadmin` only: an adjustment can move a balance DOWN.
      method: 'POST' as const,
      path: '/admin/v1/clients/:id/wallet/adjust',
      action: 'wallet.adjust' as const,
      internalPath: clientPath('/wallet/adjust'),
      inputSchema: adjustClientWalletInputSchema,
    },
    {
      method: 'POST' as const,
      path: '/admin/v1/clients/:id/wallet/freeze',
      action: 'wallet.freeze' as const,
      internalPath: clientPath('/wallet/freeze'),
      inputSchema: freezeClientWalletInputSchema,
    },
    {
      method: 'POST' as const,
      path: '/admin/v1/clients/:id/wallet/unfreeze',
      action: 'wallet.unfreeze' as const,
      internalPath: clientPath('/wallet/unfreeze'),
      inputSchema: unfreezeClientWalletInputSchema,
    },
    {
      method: 'POST' as const,
      path: '/admin/v1/topups/:id/approve',
      action: 'topups.approve' as const,
      internalPath: (params: Record<string, string>) =>
        `/internal/v1/topups/${params.id ?? ''}/approve`,
      inputSchema: approveTopupInputSchema,
    },
    {
      method: 'POST' as const,
      path: '/admin/v1/topups/:id/reject',
      action: 'topups.reject' as const,
      internalPath: (params: Record<string, string>) =>
        `/internal/v1/topups/${params.id ?? ''}/reject`,
      inputSchema: rejectTopupInputSchema,
    },
    // --- instances / campaigns -----------------------------------------
    {
      method: 'POST' as const,
      path: '/admin/v1/instances/:id/pause',
      action: 'instances.pause' as const,
      internalPath: instancePath('/pause'),
      inputSchema: pauseInstanceInputSchema,
    },
    {
      // Resume re-runs ELIGIBILITY; it never forces a send, and a pause that
      // came from a provider restriction signal is not auto-resumed
      // (safety-compliance: recovery is a human, legitimate-path action).
      method: 'POST' as const,
      path: '/admin/v1/instances/:id/resume',
      action: 'instances.resume' as const,
      internalPath: instancePath('/resume'),
      inputSchema: resumeInstanceInputSchema,
    },
    {
      // `pacing.relax`, `superadmin` only, and the internal schema requires
      // an expiry - an unbounded relaxation is not expressible.
      method: 'POST' as const,
      path: '/admin/v1/instances/:id/pacing-override',
      action: 'pacing.relax' as const,
      internalPath: instancePath('/pacing-override'),
      inputSchema: pacingOverrideInputSchema,
    },
    {
      method: 'POST' as const,
      path: '/admin/v1/campaigns/:id/cancel',
      action: 'campaigns.cancel' as const,
      internalPath: (params: Record<string, string>) =>
        `/internal/v1/campaigns/${params.id ?? ''}/cancel`,
      inputSchema: cancelCampaignInputSchema,
    },
    {
      method: 'POST' as const,
      path: '/admin/v1/impersonation/:grantId/revoke',
      action: 'impersonation.revoke' as const,
      internalPath: (params: Record<string, string>) =>
        `/internal/v1/impersonation/${params.grantId ?? ''}/revoke`,
      inputSchema: revokeImpersonationInputSchema,
    },
  ];

  for (const spec of specs) {
    registerMutationProxy(app, deps, { ...spec, outputSchema: internalMutationResult });
  }

  // The three impersonation routes that must assemble a tenant `panelUrl`
  // from `APP_PANEL_BASE_URL` live in their own module - they are the only
  // mutations whose response is SHAPED rather than passed through.
  registerImpersonationMutations(app, deps, internalMutationResult);
}
