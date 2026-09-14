/**
 * platform/registered-reads.ts (P28 Unit U4, step 6) - the key set
 * `platformRead()` accepts. An unlisted key throws
 * `UnregisteredPlatformReadError` BEFORE a connection is ever checked out,
 * so an unreviewed cross-tenant read cannot even open a transaction.
 *
 * WHY THIS EXISTS SEPARATELY from `scripts/registries/cross-tenant-queries-p28-admin.ts`:
 * that registry is the REVIEW artefact (role, reason, exact projected
 * columns) and lives under `scripts/`, which shipped admin-backend code must
 * never import. This module is the RUNTIME allow-list. They are kept in
 * exact lockstep by `platform-read.test.ts#a_cross_tenant_read_outside_platform_read_is_impossible`,
 * which derives the key set from the source tree, checks each key has a
 * complete registry entry, and asserts this set EQUALS that derived set - so
 * adding a read here without a reviewed registry entry (or vice versa) fails
 * the build rather than shipping an unreviewed platform read.
 *
 * Keys are `<repo-relative-file>:<exported-symbol>`, the same shape
 * `scripts/check-tenant-scope.ts` derives.
 */
export const REGISTERED_PLATFORM_READS: ReadonlySet<string> = new Set([
  'admin/backend/src/modules/clients/clients.read.ts:listClients',
  'admin/backend/src/modules/clients/clients.read.ts:readClient',
  'admin/backend/src/modules/instances/instances.read.ts:listInstances',
  'admin/backend/src/modules/instances/instances.read.ts:listClientInstances',
  'admin/backend/src/modules/queue/queue.read.ts:readQueueSummary',
  'admin/backend/src/modules/wallet/wallet.read.ts:readWalletAccount',
  'admin/backend/src/modules/wallet/wallet.read.ts:listWalletLedger',
  'admin/backend/src/modules/wallet/wallet.read.ts:readClientPricing',
  'admin/backend/src/modules/plans/plans.read.ts:listPlans',
  'admin/backend/src/modules/plans/plans.read.ts:readClientLimits',
  'admin/backend/src/modules/topups/topups.read.ts:listTopups',
  'admin/backend/src/modules/audit/audit.read.ts:listStaffAudit',
  'admin/backend/src/modules/audit/audit.read.ts:listRecentClientStaffActions',
  'admin/backend/src/modules/audit/audit.read.ts:listActiveImpersonations',
  // TEST-ONLY (see the probe module's own header): proves a write from
  // inside platformRead is refused by the GRANT surface (Postgres 42501),
  // not by application care. Never reachable from a route.
  'admin/backend/src/modules/clients/write-attempt-probe.read.ts:attemptSendPathWrite',
]);
