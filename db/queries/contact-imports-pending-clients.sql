-- contact-imports-pending-clients.sql (P20 Unit U5, step 6) - the
-- cross-tenant discovery half of the resumable CSV import sweep
-- (`import-runner.ts#runOneContactImportSweep`). Bounded (LIMIT-capped),
-- returns only `client_id` - the per-client claim/batch/upsert work is a
-- SEPARATE `tenantDb.withTenant` transaction per client, same "discover
-- cross-tenant, then re-scope per tenant" idiom as
-- `warmup-evaluator.ts#runOnePacingEvaluatorSweep`/`health-due.sql`.
-- Registered in `scripts/registries/cross-tenant-queries.ts` (role: cron
-- pool user, same as `wallet-rollup-compute`).

-- name: contact-imports-pending-clients
SELECT DISTINCT client_id
  FROM contact_imports
 WHERE status IN ('uploaded', 'importing')
 ORDER BY client_id
 LIMIT $limit;
