# Key-ring restore drill

Purpose: prove the key-ring backup actually restores, before launch and on a
recurring cadence afterwards. A key backup that has never been restored is
not a backup.

## The three copies

The key ring exists in exactly three places, by description only (no path
is recorded here or in any drill output):

- **Host secret store** - the running copy the API/worker processes read at
  boot, per the design at `/etc/wp/secrets/` mode `0400`.
- **Founder's offline encrypted copy** - held by the founder, encrypted with
  `age` under a passphrase known only to the founder. (The drill itself
  stands this step in with an AES-256-GCM encryption under a scrypt-derived
  key, generated fresh in memory for the drill run - it never touches disk
  and is never printed. `age` is the production tool.)
- **Sealed second offline copy** - a second encrypted copy, held separately
  from the founder's own copy, so no single person or location loss destroys
  the only backup.

## Cadence

Run the drill quarterly. Next drill due: **2026-12-08**.

## Running the drill

```
pnpm run drill:keyring
```

The drill provisions a production-shaped ring in a scratch directory,
makes both offline copies, seals a real credential-shaped record under the
active `session` key, destroys the running copy, restores from the offline
copy, and re-opens the sealed record. It prints per-phase timings and a
verdict, and writes `docs/measurements/<date>-keyring-restore-drill.json`.

- **PASS** means the offline copy restores and the previously sealed record
  opens identically after restore - the backup works.
- **FAIL** means the backup does not work. This is an honest result, not a
  workaround: launch is blocked until the backup is fixed and the drill
  passes again. There is no fallback path that "makes do" without a working
  key-ring backup.

## Never print, log, or paste key material

No key bytes, no base64 material, no passphrase, and no secret storage path
may ever appear in a terminal, a log line, an error message, a chat message,
or a committed file. The drill enforces this on every line it prints and on
the evidence file it writes; the same rule applies to anyone operating it by
hand.

If the drill is killed mid-run (SIGKILL, power loss), the scratch directory
under the OS temp dir may still hold the drill-generated (never production)
ring and its plaintext restored copy - delete that `wp-keyring-restore-drill-*`
directory by hand before doing anything else.

## Rotation

See [`docs/RUNBOOK.md#kek-rotation`](../RUNBOOK.md#kek-rotation) for how KEK
rotation itself works. This runbook covers the restore drill only.

## A different secret from the Postgres backup passphrase

The key-ring passphrase is a separate secret from the Postgres backup
passphrase (see
[`docs/runbooks/restore-from-backup.md`](restore-from-backup.md)) - an
attacker needs both, not one, to reconstruct sealed data from backups alone.
