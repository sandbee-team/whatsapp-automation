# infra/backup

Backup and restore tooling: the key-ring restore drill, the timed Postgres
restore drill, and the production pgBackRest configuration shape.

INTERNAL — the figures the drills produce are evidence, not marketing
claims (ADR 0016); generated reports carry their own banner saying so.

## What is here

- `keyring-restore-drill.ts` / `keyring-restore-drill-lib.ts` - the key-ring
  backup/restore drill. See `docs/runbooks/key-ring-restore.md`.
- `restore-drill.ts` - the Postgres restore drill orchestrator (this file's
  own module doc explains the flow). Split into `restore-drill-lib.ts` (pure
  refusal/argv/plan builders), `restore-drill-basebackup.ts` (the
  `basebackup` mode's runner), `restore-drill-types.ts` (shared types).
- `restore-drill.ps1` / `restore-drill.sh` - wrappers that load
  `.secrets/dev.env` then run the orchestrator.
- `pgbackrest.conf.example` - the production pgBackRest config shape
  (Backblaze B2 by name only, no real credentials).
- `backup-cron.md` - the production backup schedule and launch checklist.

`scripts/ops/restore-drill.ps1` / `.sh` are 5-line forwarders to the wrappers
above (moved here in P29a) - kept so existing references still resolve.
`scripts/ops/restore-drill-report.ts` (+ `-markdown.ts`, `-metrics.ts`
siblings) is the PURE report schema/validator/formatter both this drill and
`app/backend/src/engine/measure/run-restore-verify*.ts` share.

## Running the restore drill

Two modes, one orchestrator:

```
powershell -File infra/backup/restore-drill.ps1                  # basebackup mode (default) - real, runs on this dev box
powershell -File infra/backup/restore-drill.ps1 --keep            # leave the scratch container/volume for inspection
powershell -File infra/backup/restore-drill.ps1 --mode pgbackrest # argv-only: builds the PITR command, never executes it here
```

POSIX twin: `infra/backup/restore-drill.sh` (same flags).

### One-time dev-Postgres prerequisite: replication `pg_hba` entry

`infra/compose/docker-compose.dev.yml`'s `postgres` service does not ship a
`host replication all all` `pg_hba.conf` entry, so `pg_basebackup` from the
Windows host (which the container sees as the docker-bridge gateway IP, not
literally `127.0.0.1`) fails with `no pg_hba.conf entry for replication
connection` until one is added. This is a ONE-TIME, per-volume fix (it lives
in the named volume's `pg_hba.conf`, so it survives container restarts but
NOT a fresh `wp-dev_postgres_data` volume):

```
docker exec wp-dev-postgres-1 sh -c "echo 'host replication all all scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf"
docker exec wp-dev-postgres-1 psql -U wp -d wp -c "select pg_reload_conf();"
```

If a fresh dev volume ever needs this drill, run the two lines above once
first. This is a dev-box-only workaround; production Postgres hosts run
pgBackRest (no `pg_basebackup` replication connection needed) - see
`docs/runbooks/restore-from-backup.md`.

**`basebackup` mode** (the mode actually exercised here): runs a real
`pg_basebackup -X stream` against the dev Postgres, restores it into a
SCRATCH docker container on a SCRATCH port with a SCRATCH named volume
(created and destroyed by the drill), verifies it, reports, then tears the
container/volume down. It never touches the live `wp` database's data - see
`restore-drill-lib.ts`'s `assertNotProductionTarget`, which hard-refuses
before anything is spawned if the target is not loopback, shares host:port
with the source, or matches a production-host pattern.

The SOURCE host (`POSTGRES_HOST`/`PGHOST`) is refused just as hard, before
anything is spawned: `assertSourceIsSafe` rejects any source matching a
production-host pattern outright, and rejects a non-loopback source unless
`--allow-remote-source` is passed explicitly - so `POSTGRES_HOST=db.prod.internal`
(or any other remote host, by accident) can never be `pg_basebackup`'d by
this drill without an operator opting in by name.

**`pgbackrest` mode**: builds the production point-in-time-recovery argv
shape (`--type=time --target=<iso> --target-action=promote`) and spawns
`pgbackrest` - which is not installed on Windows, so this mode is exercised
by its own unit test (argv assertion with an injected spawner) only. The
real operator procedure is `docs/runbooks/restore-from-backup.md`.

## What it asserts

- Schema version matches `EXPECTED_SCHEMA_VERSION` (`@wp/db`).
- Every `public` table's row count matches (all tables, plus a named
  four-table parity check: `message_jobs`, `wallet_ledger`, `contacts`, and
  `messages` - the last does not exist in v1, reported honestly with
  `exists: false`, never treated as a mismatch).
- The `wallet_ledger` continuity invariant holds on the restored copy:
  `balance_after_minor = lag(balance_after_minor) + amount_minor` per
  client, ordered by `seq` (`evaluateLedgerChain`, bigint-safe).
- A real claim runs on the restored copy inside `BEGIN ... ROLLBACK` (never
  committed) - proves the send-claim path still works post-restore.
- A plaintext scan for key-ring sentinel strings finds zero hits in both the
  restored session-credential blobs and the backup file.
- Measured RTO (restore start -> verified) against the ~1 h launch-tier
  target, and measured RPO against the 5-minute target (with the
  `recovery_target = 'immediate'` caveat documented on `computeRecoveryPoint`
  in `restore-drill-lib.ts`) - an RTO/RPO miss is recorded honestly as a
  `notes` entry next to the target, never silently smoothed into a PASS.

## Where evidence lands

`docs/measurements/<date>-restore-drill.json` (the full report) and
`docs/evidence/P29-restore-drill.md` (the human-readable summary, generated
by `scripts/ops/restore-drill-report.ts --markdown`). `docs/RUNBOOK.md`
`## restore-drill` links the latest measurement paragraph.
