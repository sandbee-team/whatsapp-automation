import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  parseActorHeader,
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
  // Aliased in this barrel (P28 U3b) - the bare name is the TENANT resume
  // contract; see `instances.ts`'s own "NAME COLLISION" doc comment.
  staffResumeInstanceInputSchema,
  pacingOverrideInputSchema,
  cancelCampaignInputSchema,
  grantImpersonationInputSchema,
  mintImpersonationTokenInputSchema,
  elevateImpersonationInputSchema,
  revokeImpersonationInputSchema,
  internalContract,
} from './index.js';

/**
 * internal-contract.test.ts (P28 Unit U2, step 3) - every mutation input
 * rejects a missing `reason`, an unknown key (`.strict()`), and (where
 * present) a JSON-number `amountMinor`; `parseActorHeader` accepts only
 * `staff:<uuid>`; the contract path set is snapshotted inline so a route
 * cannot silently disappear.
 */

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

const MUTATION_INPUTS_WITH_REASON: Array<[string, z.ZodTypeAny, Record<string, unknown>]> = [
  ['suspendClientInputSchema', suspendClientInputSchema, {}],
  ['reactivateClientInputSchema', reactivateClientInputSchema, {}],
  [
    'setClientLimitsInputSchema',
    setClientLimitsInputSchema,
    { overrides: [{ limitKey: 'max_contacts', limitValue: 10 }] },
  ],
  ['setClientPricingInputSchema', setClientPricingInputSchema, { overrideItems: {} }],
  ['setClientPlanInputSchema', setClientPlanInputSchema, { planKey: 'starter' }],
  [
    'creditClientWalletInputSchema',
    creditClientWalletInputSchema,
    { amountMinor: '100', kind: 'topup_manual', externalRef: 'ref-1' },
  ],
  [
    'adjustClientWalletInputSchema',
    adjustClientWalletInputSchema,
    { amountMinor: '100', externalRef: 'ref-1' },
  ],
  ['freezeClientWalletInputSchema', freezeClientWalletInputSchema, {}],
  ['unfreezeClientWalletInputSchema', unfreezeClientWalletInputSchema, {}],
  ['approveTopupInputSchema', approveTopupInputSchema, {}],
  ['rejectTopupInputSchema', rejectTopupInputSchema, {}],
  ['pauseInstanceInputSchema', pauseInstanceInputSchema, { clientId: VALID_UUID }],
  ['staffResumeInstanceInputSchema', staffResumeInstanceInputSchema, { clientId: VALID_UUID }],
  [
    'pacingOverrideInputSchema',
    pacingOverrideInputSchema,
    {
      clientId: VALID_UUID,
      expiresAt: '2026-01-01T00:00:00.000Z',
      patch: { dailyCap: 100 },
    },
  ],
  ['cancelCampaignInputSchema', cancelCampaignInputSchema, { clientId: VALID_UUID }],
  ['grantImpersonationInputSchema', grantImpersonationInputSchema, {}],
  ['mintImpersonationTokenInputSchema', mintImpersonationTokenInputSchema, {}],
  ['elevateImpersonationInputSchema', elevateImpersonationInputSchema, {}],
  ['revokeImpersonationInputSchema', revokeImpersonationInputSchema, {}],
];

describe('internal mutation inputs: reason + strict + money shape', () => {
  it.each(MUTATION_INPUTS_WITH_REASON)(
    '%s rejects a missing reason and an unknown key',
    (_name, schema, rest) => {
      // Missing `reason` entirely.
      expect(schema.safeParse({ ...rest }).success).toBe(false);

      // Present but valid `reason`, plus an unknown extra key -> `.strict()` rejects.
      const withUnknownKey = { ...rest, reason: 'a valid reason', unknownField: 'nope' };
      expect(schema.safeParse(withUnknownKey).success).toBe(false);
    },
  );

  it('creditClientWalletInputSchema rejects a JSON-number amountMinor', () => {
    const result = creditClientWalletInputSchema.safeParse({
      reason: 'valid reason',
      amountMinor: 100,
      kind: 'topup_manual',
      externalRef: 'ref-1',
    });
    expect(result.success).toBe(false);
  });

  it('creditClientWalletInputSchema rejects a non-positive amountMinor', () => {
    const result = creditClientWalletInputSchema.safeParse({
      reason: 'valid reason',
      amountMinor: '0',
      kind: 'topup_manual',
      externalRef: 'ref-1',
    });
    expect(result.success).toBe(false);
  });

  it('setClientLimitsInputSchema accepts a null limitValue to clear an override', () => {
    const result = setClientLimitsInputSchema.safeParse({
      reason: 'valid reason',
      overrides: [{ limitKey: 'max_contacts', limitValue: null }],
    });
    expect(result.success).toBe(true);
  });
});

describe('parseActorHeader', () => {
  it('accepts_staff_colon_uuid', () => {
    expect(parseActorHeader(`staff:${VALID_UUID}`)).toEqual({ kind: 'staff', staffId: VALID_UUID });
  });

  it('rejects_system', () => {
    expect(() => parseActorHeader('system')).toThrow();
  });

  it('rejects_api_key_actor', () => {
    expect(() => parseActorHeader('api_key:x')).toThrow();
  });

  it('rejects_a_bare_uuid', () => {
    expect(() => parseActorHeader(VALID_UUID)).toThrow();
  });

  it('rejects_staff_colon_with_a_non_uuid', () => {
    expect(() => parseActorHeader('staff:not-a-uuid')).toThrow();
  });
});

describe('internalContract route set', () => {
  it('the_sorted_METHOD_path_list_matches_the_designed_route_set_exactly', () => {
    function collectRoutes(node: unknown, acc: string[]): void {
      if (node === null || typeof node !== 'object') return;
      const maybeRoute = node as { '~orpc'?: { route?: { method?: string; path?: string } } };
      const route = maybeRoute['~orpc']?.route;
      if (route?.method && route.path) {
        acc.push(`${route.method} ${route.path}`);
        return;
      }
      for (const value of Object.values(node)) {
        collectRoutes(value, acc);
      }
    }

    const routes: string[] = [];
    collectRoutes(internalContract, routes);
    routes.sort();

    expect(routes).toEqual(
      [
        'POST /internal/v1/clients/{id}/suspend',
        'POST /internal/v1/clients/{id}/reactivate',
        'PUT /internal/v1/clients/{id}/limits',
        'PUT /internal/v1/clients/{id}/pricing',
        'PUT /internal/v1/clients/{id}/plan',
        'POST /internal/v1/clients/{id}/wallet/credit',
        'POST /internal/v1/clients/{id}/wallet/adjust',
        'POST /internal/v1/clients/{id}/wallet/freeze',
        'POST /internal/v1/clients/{id}/wallet/unfreeze',
        'POST /internal/v1/topups/{id}/approve',
        'POST /internal/v1/topups/{id}/reject',
        'GET /internal/v1/topups',
        'POST /internal/v1/instances/{id}/pause',
        'POST /internal/v1/instances/{id}/resume',
        'POST /internal/v1/instances/{id}/pacing-override',
        'POST /internal/v1/campaigns/{id}/cancel',
        'POST /internal/v1/clients/{id}/impersonation',
        'POST /internal/v1/impersonation/{grantId}/token',
        'POST /internal/v1/impersonation/{grantId}/elevate',
        'POST /internal/v1/impersonation/{grantId}/revoke',
        'GET /internal/v1/clients/{id}/impersonation',
        'GET /internal/v1/plans',
      ].sort(),
    );
  });
});
