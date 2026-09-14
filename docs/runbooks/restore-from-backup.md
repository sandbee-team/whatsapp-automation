# Restoring Postgres from backup (production)

INTERNAL — operator runbook. No figure here is a marketing claim (ADR 0016).

This is the procedure for a REAL production restore using pgBackRest
point-in-time recovery (PITR). It is written for a human operator; nothing
in this repo executes it automatically (pgBackRest is not installed on the
Windows dev box - see `infra/backup/README.md`).

## The hard rule: scratch first, always

**Never restore directly onto the production host or into the production
database.** Every restore - drill or real incident - goes through a SCRATCH
target first:

1. Restore into a scratch container/host on a scratch port, with a scratch
   PGDATA volume.
2. Run the verification steps below against the scratch target.
3. Only after verification passes, cut over (promote the scratch target to
   be the new primary, or replay the same procedure against the real
   production host during a planned maintenance window).

This mirrors `infra/backup/restore-drill.ts`'s own hard-refusal logic
(`assertNotProductionTarget`): a target that is not loopback, that shares
host:port with the source, or whose hostname matches a production pattern is
refused before anything runs. A human operator follows the same discipline
by procedure, since the real production restore is not automation-gated the
way the drill is.

## Procedure

1. **Identify the target time.** For an incident, this is "just before the
   bad event" (a bad migration, a data-corruption incident, etc). For a
   drill, this is "now" (`recovery_target = 'immediate'`, i.e. the backup's
   own consistent point - see the caveat in step 4).

2. **Restore into a scratch target:**

   ```
   pgbackrest --stanza=wp --type=time --target="<iso-timestamp>" \
     --target-action=promote --pg1-path=<scratch-pgdata-dir> restore
   ```

   (This is exactly the argv `buildPgBackRestRestoreArgv` in
   `infra/backup/restore-drill-lib.ts` builds - the drill's own unit test
   pins this shape.)

3. **Start Postgres against the scratch PGDATA** and wait for it to reach a
   consistent, promoted state.

4. **Verify** (same checks the drill automates for the `basebackup` mode):
   - Schema version matches `EXPECTED_SCHEMA_VERSION` (`@wp/db`) - or run
     `ROLE=migrate` and confirm it does not attempt an unexpected migration.
   - Row counts on `message_jobs`, `wallet_ledger`, `contacts` (and
     `messages`, once it exists) match the source at the target time.
   - `wallet_ledger` continuity: `balance_after_minor = lag(balance_after_minor) + amount_minor`
     per client, ordered by `seq`, holds with zero breaks.
   - A real claim query succeeds against the restored copy (inside a
     transaction that is then rolled back, never committed against the
     scratch target either, until cutover is decided).
   - A plaintext scan finds no key-ring sentinel strings in restored
     session-credential blobs.
   - **`recovery_target = 'immediate'` caveat:** the recovery point is the
     backup's own consistent point, not necessarily "as close to the
     incident as WAL allows" - for a real incident, use
     `recovery_target = 'time'` with the actual target timestamp (per step 2
     above) to replay WAL up to that exact point; only a DRILL (no real data
     to protect) uses `immediate`.

5. **Run the `ROLE=migrate` schema assertion** against the scratch target -
   application roles refuse to boot on a schema mismatch, so this is the
   same gate a real boot would apply.

6. **Only after every check above passes**, proceed to cutover per the
   incident/maintenance runbook (out of scope here - this file covers
   restore + verify only).

## RTO / RPO targets by tier

(Same figures as `docs/RUNBOOK.md` `## restore-drill` - copied here so this
runbook is self-contained for an operator mid-incident.)

- **RTO** (restore time objective):
  - ~1 hour at up to ~2,000 connected numbers, restoring from backup.
  - 4-6 hours at ~10,000 connected numbers restoring from backup, unless a
    warm standby exists.
  - ~15 minutes via promoting a streaming replica - the intended recovery
    path from ~5,000 connected numbers upward.
- **RPO** (recovery point objective): 5 minutes. `archive_timeout = 60` in
  the production Postgres config (see `infra/backup/pgbackrest.conf.example`)
  bounds unarchived WAL to at most 60 seconds, well under this target.

These are DESIGN targets. The dev-box `basebackup` drill measures a lower
bound only (smaller dataset, no PITR replay, no network hop to an off-site
repository) - see `docs/RUNBOOK.md`'s dated measurement paragraphs and
`docs/evidence/P29-restore-drill.md` for the honest gap.

## Secrets

The pgBackRest repository encryption passphrase
(`repo1-cipher-pass` in `infra/backup/pgbackrest.conf.example`) is a
**DIFFERENT secret from the key-ring passphrase**. Losing one must never
lose the other - they are backed up, rotated, and reviewed independently.
See `docs/runbooks/key-ring-restore.md` for the key-ring's own drill and
cadence.
