/**
 * The schema version this repo's compiled code expects to find applied in
 * `schema_migrations` (the highest `version` row). Every migration added
 * under `db/migrations/` bumps this constant in the same change - it is a
 * compiled constant, not a runtime query, so a stale deploy can never
 * silently believe it is up to date.
 *
 * Per-migration rationale lives in each migration file's own header under
 * `db/migrations/` (the enumerated history that used to be duplicated here
 * was removed at P14 close for the max-lines cap - the migration files were
 * always the authoritative copy).
 *
 * `db/tests/migrate-runner.test.ts` asserts this constant structurally
 * (equal to both the on-disk migration file count and the highest on-disk
 * version number), so a missed bump here fails that test instead of only
 * failing at boot via `assertSchemaVersion`.
 */
export const EXPECTED_SCHEMA_VERSION = 77;
