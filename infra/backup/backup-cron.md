# Backup schedule (production)

INTERNAL — operational schedule; not a marketing/SLA claim (ADR 0016).

This is the production backup cadence pgBackRest runs on the Postgres host.
It is NOT exercised by anything in this repo's automation (pgBackRest is not
installed on Windows) - `infra/backup/pgbackrest.conf.example` is the config
shape; this file is the schedule around it.

## Cadence

| Job                    | Schedule                         | Tool                                                                                 |
| ---------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| Full backup            | Weekly, Sunday 02:00 IST         | `pgbackrest --stanza=wp --type=full backup`                                          |
| Incremental backup     | Daily, 02:00 IST (except Sunday) | `pgbackrest --stanza=wp --type=incr backup`                                          |
| Continuous WAL archive | Always on                        | `archive_command = 'pgbackrest --stanza=wp archive-push %p'`, `archive_timeout = 60` |
| Repository check       | Daily                            | `pgbackrest --stanza=wp check`                                                       |

`archive_timeout = 60` bounds the worst-case RPO to at most 60 seconds of
unarchived WAL - well under the 5-minute RPO target
(`docs/RUNBOOK.md` `## restore-drill`).

## Verify schedule (launch checklist)

- [ ] `pgbackrest check` passing daily (repository reachable, stanza valid).
- [ ] A timed restore drill run before the first paying tenant
      (`infra/backup/restore-drill.ps1` / `.sh` on a dev/staging box first;
      the production path is `docs/runbooks/restore-from-backup.md`).
- [ ] Full backup retention (`repo1-retention-full=4`) confirmed non-empty in
      the repository listing.
- [ ] Off-site repository credentials rotated on the same cadence as the
      key-ring passphrase review (`docs/runbooks/key-ring-restore.md`) - they
      are DIFFERENT secrets, rotated independently, but reviewed together.

## Re-timing cadence

Re-time the restore drill:

- Before the first paying tenant goes live.
- At every 3x growth in connected numbers (matches the cadence stated in
  `docs/RUNBOOK.md` `## restore-drill` and ADR 0018 §7's own tiers).
