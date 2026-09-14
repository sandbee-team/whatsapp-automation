import { describe, expect, it } from 'vitest';
import * as contracts from '../index.js';
import * as internalBarrel from './index.js';
import { resumeInstanceInputSchema as internalResumeSchema } from './instances.js';
import { resumeInstanceInputSchema as tenantResumeSchema } from '../instances.js';

/**
 * barrel-shadowing.test.ts (P28 Unit U3b, step 5) - proves that every name
 * `internal/index.ts` exports is the INTERNAL one when imported from
 * `@wp/contracts`, i.e. that no name in this staff-only directory is
 * silently shadowed by a same-named TENANT contract export.
 *
 * WHY THIS TEST EXISTS: `src/index.ts` re-exports the tenant contracts by
 * NAME and this directory with `export *`. In ES modules an explicit named
 * export SHADOWS a star re-export, silently and with NO type error. That is
 * exactly what happened to `resumeInstanceInputSchema`: both the tenant
 * `POST /v1/instances/{id}/resume` and the staff
 * `POST /internal/v1/instances/{id}/resume` declared it, so every
 * `@wp/contracts` importer got the TENANT body schema (no `clientId`) and
 * the staff resume route rejected its own valid request with
 * `Unrecognized key: "clientId"` - a 400 where its contract says 422/200.
 * Resolved by aliasing the three internal `resumeInstance*` exports; this
 * test is what stops the next staff route from re-introducing the trap.
 */

describe('internal contract barrel is not shadowed by tenant contracts', () => {
  it('no_internal_barrel_export_resolves_to_a_different_object_via_the_package_root', () => {
    const shadowed: string[] = [];
    for (const [name, internalValue] of Object.entries(internalBarrel)) {
      if (!(name in contracts)) continue;
      const rootValue = (contracts as Record<string, unknown>)[name];
      if (rootValue !== internalValue) shadowed.push(name);
    }
    expect(
      shadowed,
      `these internal/ exports are shadowed at the package root: ${shadowed.join(', ')}`,
    ).toEqual([]);
  });

  it('the_two_resume_schemas_are_genuinely_different_and_both_reachable', () => {
    // Not the same object - the collision was real, not a re-export of one.
    expect(internalResumeSchema).not.toBe(tenantResumeSchema);

    // The STAFF schema requires `clientId` (its tenant scope, since a staff
    // caller has no tenant session); the TENANT schema forbids it.
    const staffBody = { clientId: '11111111-1111-4111-8111-111111111111', reason: 'a reason' };
    expect(internalResumeSchema.safeParse(staffBody).success).toBe(true);
    expect(tenantResumeSchema.safeParse(staffBody).success).toBe(false);

    // Both are reachable from the package root under their own names.
    expect(contracts.staffResumeInstanceInputSchema).toBe(internalResumeSchema);
    expect(contracts.resumeInstanceInputSchema).toBe(tenantResumeSchema);
  });
});
