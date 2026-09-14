import type { CrossTenantQueryEntry } from './cross-tenant-queries.js';

/**
 * cross-tenant-queries-p26.ts (P26 scale-proof-1k) - the measurement
 * harness's deliberately cross-tenant spans. `app/backend/src/engine/measure/**`
 * is measurement-only code, unreachable from production (`.dependency-cruiser.cjs`
 * `src-never-imports-engine-measure`), that SEEDS probe tenants and VERIFIES a
 * restored scratch database. Every read that CAN be tenant-scoped is (they bind
 * `client_id = ANY($ids)` next to their instance predicate); the five spans
 * below either create the tenants in the first place or must, by definition,
 * cover the whole database. Keyed `<file>:<symbol>` exactly as
 * `check-tenant-scope.ts` derives them.
 */
export const CROSS_TENANT_QUERIES_P26: Record<string, CrossTenantQueryEntry> = Object.freeze({
  'app/backend/src/engine/measure/measure-enqueue.ts:createMeasureEnqueue': {
    role: 'measurement driver (pool user; the P26 fleet harness only)',
    reason:
      'P26 U2e - the ONE durable-first enqueue the load/pacing drivers use: INSERT message_jobs + message_job_refs for a probe tenant the harness itself seeded, then publishWake, mirroring messages.repo.ts. client_id is a BOUND VALUE in every row (never derived from another tenant), so there is no predicate to scope by; the caller only ever passes ids returned by seedScaleFleet and every row is deleted by the id-scoped cleanupScaleFleet.',
    projectedColumns: ['id', 'created_at'],
  },
  'app/backend/src/engine/measure/scale-fleet-seed.ts:seedTenant': {
    role: 'measurement seed (pool user; the P26 fleet harness only)',
    reason:
      'P26 U2a - creates one probe tenant (clients, wallet_accounts, client_pricing) that a fleet-scale run measures, returning its client id to the caller so cleanupScaleFleet can delete it id-scoped (= ANY($ids), never a name pattern). Seeding IS the act that brings a tenant into existence; there is no tenant to scope by before it runs.',
    projectedColumns: ['id'],
  },
  'app/backend/src/engine/measure/scale-fleet-seed.ts:seedInstance': {
    role: 'measurement seed (pool user; the P26 fleet harness only)',
    reason:
      'P26 U2a - seeds one instance (whatsapp_instances, instance_lease_state, instance_pacing_state, optional queued message_jobs) under an ALREADY-seeded clientId (seedTenant) - every row is bound to that one clientId, never derived from another tenant, and deleted id-scoped by cleanupScaleFleet.',
    projectedColumns: ['id'],
  },
  'app/backend/src/engine/measure/send-load-driver-run.ts:seedOneInstance': {
    role: 'measurement seed (pool user; the P26 load driver only)',
    reason:
      'P26 U2b - inserts one probe client + whatsapp_instances row directly (same shortcut as enqueue-test-support.ts#seedInstance). Seeding IS the act that brings the tenant into existence; there is no tenant to scope by before it runs.',
    projectedColumns: ['id'],
  },
  'app/backend/src/engine/measure/send-load-driver-run.ts:main': {
    role: 'measurement seed + cleanup (pool user; the P26 load driver only)',
    reason:
      'P26 U2b - the standalone load-driver runnable deletes its own seeded probe clients + whatsapp_instances afterwards (DELETE ... WHERE client_id = ANY / id = ANY, never a name pattern) - the same ids seedOneInstance returned, nothing else.',
    projectedColumns: ['id'],
  },
  'app/backend/src/engine/measure/run-restore-verify-checks.ts:runClaimCheck': {
    role: 'restore drill verifier (superuser on a SCRATCH database, read + ROLLBACK)',
    reason:
      'P26 U7 - after a timed pg_restore into a scratch database, proves db/queries/claim-jobs.sql still returns rows there: picks ONE eligible (client_id, instance_id, current_fence) from the restored data (no tenant is known in advance - the drill verifies whatever was backed up), then runs the real claim statement inside BEGIN ... ROLLBACK with app.client_id set. Never runs against the live database.',
    projectedColumns: ['client_id', 'instance_id', 'current_fence'],
  },
  'app/backend/src/engine/measure/run-restore-verify-checks.ts:runPlaintextScan': {
    role: 'restore drill verifier (superuser on a SCRATCH database, read-only)',
    reason:
      'P26 U7 - scans EVERY whatsapp_session_credentials blob in the restored scratch database for plaintext credential sentinels (noiseKey, signedIdentityKey, registrationId, advSecretKey). A plaintext credential for ANY tenant fails the drill, so the scan is whole-table by definition (the P07 no-plaintext invariant, re-proven on the restore).',
    projectedColumns: ['count'],
  },
  'app/backend/src/engine/measure/orphan-attempts-preflight.ts:readOrphanAttemptLandmines': {
    role: 'operator preflight (pool user; run-pg-load.ts and friends call this before a load run starts)',
    reason:
      "FIX-P26-D (run log row 26) - a one-shot, read-only preflight that must see EVERY orphan send_attempts row inside the id window the sequence is about to walk through, regardless of which tenant's fixture left it behind (evaluator-fixtures.ts's old fake message_job_id range collided with the real message_jobs bigserial). There is no single tenant to scope to: the whole point is to catch a landmine before the run picks a client. Projects only ids/counts, never payload or recipient columns.",
    projectedColumns: ['seq_last_value', 'count', 'min_job_id', 'max_job_id', 'distinct_clients'],
  },
  'app/backend/src/engine/measure/run-restore-verify-extra.ts:runLedgerChainCheck': {
    role: 'restore drill verifier (superuser on a SCRATCH database, read-only)',
    reason:
      'P29a U3 (step 9) - two whole-table reads on the RESTORED scratch copy, never the live database: (1) the wallet_ledger continuity check walks EVERY tenant ledger ordered by (client_id, seq) and asserts balance_after_minor = previous balance + amount_minor - money for ANY tenant surviving the restore is the invariant, so no single tenant can be scoped; (2) the sibling plaintext scan (buildPlaintextScan, keyed here because it is a non-exported helper below this symbol) counts whatsapp_session_credentials blobs carrying a plaintext sentinel, whole-table by definition (same P07 invariant as run-restore-verify-checks.ts:runPlaintextScan). Projects ledger ids/amounts and a count only - never a payload, recipient or credential column.',
    projectedColumns: ['client_id', 'seq', 'amount_minor', 'balance_after_minor', 'count'],
  },
});
