-- Known-bad/known-good fixture for check-tenant-scope.test.ts's .sql handling
-- (P03 Unit C). Excluded from every real scan (scripts/guards/__fixtures__/**).
-- Mirrors queries.ts's three cases, using the `-- name: <label>` marker
-- convention db/queries/*.sql files use (see db/queries/ensure-partitions.sql).

-- name: listQueuedJobs
SELECT * FROM message_jobs WHERE status = 'queued';

-- name: listQueuedJobsForClient
SELECT * FROM message_jobs WHERE status = 'queued' AND client_id = $1;

-- name: platformWorklistRead
SELECT id FROM message_jobs WHERE next_attempt_at <= now();
