/**
 * restore-drill-lib.ts (P29a Unit U3, step 9) - PURE helpers for the timed
 * Postgres restore drill. Node builtins only, no I/O: every function here is
 * a predicate or an argv/plan builder, never a spawner. The orchestrator
 * (`restore-drill.ts`) calls `assertNotProductionTarget` BEFORE spawning any
 * process - a refusal must happen with zero side effects.
 *
 * Extends (does not replace) the P26 pg_dump-based drill
 * (`scripts/ops/restore-drill.ps1`/`.sh` + `run-restore-verify.ts`) with two
 * additional restore modes this phase adds: a real `pg_basebackup` into a
 * SCRATCH docker container (exercised for real on this dev box), and the
 * production `pgbackrest` PITR argv shape (built and unit-tested here, never
 * spawned on this box - pgBackRest is not installed on Windows).
 */

// Production/loopback refusal predicates (`assertNotProductionTarget`,
// `assertSourceIsSafe`, `RestoreDrillRefusedError`, `DrillTarget`,
// `DEFAULT_PRODUCTION_HOST_PATTERNS`) moved to the sibling
// `restore-drill-refusal.ts` (pure code-motion split for the `max-lines`
// cap) - re-exported here so every existing import of this module keeps
// working unchanged.
export {
  RestoreDrillRefusedError,
  DEFAULT_PRODUCTION_HOST_PATTERNS,
  assertNotProductionTarget,
  assertSourceIsSafe,
  type DrillTarget,
} from './restore-drill-refusal.js';

export interface BuildBaseBackupArgvOptions {
  pgBin: string;
  host: string;
  port: number;
  user: string;
  outDir: string;
}

/**
 * `pg_basebackup` argv, tar format with streamed WAL bundled into the same
 * output directory (`base.tar` + `pg_wal.tar`) - self-contained, so the
 * restored copy needs no external WAL archive/`restore_command` (see
 * `buildScratchContainerPlan`'s own comment on why `recovery.signal` is
 * deliberately NOT part of that plan).
 */
export function buildBaseBackupArgv(opts: BuildBaseBackupArgvOptions): string[] {
  return [
    '-h',
    opts.host,
    '-p',
    String(opts.port),
    '-U',
    opts.user,
    '-D',
    opts.outDir,
    '-Ft',
    '-X',
    'stream',
    '-c',
    'fast',
    '--no-password',
    '--progress',
  ];
}

export interface ScratchContainerPlanOptions {
  name: string;
  port: number;
  volume: string;
  image?: string;
  /** Absolute host paths to the two tars `pg_basebackup` wrote. */
  baseTarPath: string;
  pgWalTarPath: string;
  /** A drill-only random password - inert once PGDATA exists from the restored tar (see step comment below). */
  drillPassword: string;
}

export interface DockerCommand {
  /** One line of human-readable rationale for this step. */
  description: string;
  argv: string[];
  /** When set, `stdin` bytes come from this HOST file - the orchestrator streams it, never `docker cp` (see step comment). */
  stdinFromFile?: string;
}

/**
 * The ordered docker command plan for the `basebackup-scratch-container`
 * mode. Each command is a plain argv the orchestrator's injected spawner
 * runs in order; nothing here executes anything itself (pure builder).
 *
 * Step rationale (each cost a real defect found while proving this plan on
 * this dev box, 2026-09-08):
 *  - the two backup tars are streamed into the container over
 *    `docker exec -i <name> sh -c "cat > <path>"` (stdin), NOT `docker cp` -
 *    on this box's Docker Desktop npipe transport, `docker cp` of the
 *    ~1.7 GB `base.tar` failed outright ("read/write on closed pipe")
 *    while the stdin-stream form completed with a byte-for-byte match.
 *  - NO `recovery.signal` / `recovery_target` config is written. A
 *    `pg_basebackup -X stream` backup already bundles every WAL segment the
 *    restore needs into `pg_wal.tar`; `backup_label` alone (written by
 *    `pg_basebackup` into `base.tar`) makes Postgres perform ordinary
 *    backup/crash recovery using that bundled WAL on startup - no
 *    `restore_command` exists in this mode, so `recovery_target_action =
 *    'promote'` errors with `FATAL: must specify "restore_command" when
 *    standby mode is not enabled` (confirmed on this box during Unit U3).
 *    `recovery.signal`-driven PITR promotion is the `pgbackrest` mode's
 *    concern (`buildPgBackRestRestoreArgv`), not this one.
 *  - the scratch container's `POSTGRES_PASSWORD` env is inert the moment
 *    PGDATA already exists (the official image's entrypoint only applies it
 *    on a FRESH empty PGDATA) - the restored cluster's own `pg_hba`/role
 *    passwords come from the SOURCE cluster inside the tar, so the
 *    orchestrator must connect with the SOURCE user/password against the
 *    scratch port, never the container's own `drillPassword`.
 */
export function buildScratchContainerPlan(opts: ScratchContainerPlanOptions): DockerCommand[] {
  const image = opts.image ?? 'postgres:17';
  const dataDir = '/var/lib/postgresql/data';
  const stagingDir = '/tmp/basebackup';
  return [
    {
      description: 'create the scratch named volume',
      argv: ['volume', 'create', opts.volume],
    },
    {
      description: 'start a scratch postgres:17 container, sleeping (no PGDATA yet)',
      argv: [
        'run',
        '-d',
        '--name',
        opts.name,
        '-p',
        `127.0.0.1:${String(opts.port)}:5432`,
        '-v',
        `${opts.volume}:${dataDir}`,
        '-e',
        `POSTGRES_PASSWORD=${opts.drillPassword}`,
        image,
        'sleep',
        'infinity',
      ],
    },
    {
      description: 'create the staging directory inside the container',
      argv: ['exec', opts.name, 'mkdir', '-p', stagingDir],
    },
    {
      description:
        'stream base.tar into the container via stdin (docker cp fails on large files on this platform)',
      argv: ['exec', '-i', opts.name, 'sh', '-c', `cat > ${stagingDir}/base.tar`],
      stdinFromFile: opts.baseTarPath,
    },
    {
      description: 'stream pg_wal.tar into the container via stdin',
      argv: ['exec', '-i', opts.name, 'sh', '-c', `cat > ${stagingDir}/pg_wal.tar`],
      stdinFromFile: opts.pgWalTarPath,
    },
    {
      description:
        'extract base.tar into PGDATA and pg_wal.tar into PGDATA/pg_wal, fix ownership/mode',
      argv: [
        'exec',
        opts.name,
        'sh',
        '-c',
        [
          `mkdir -p ${dataDir}`,
          `tar -xf ${stagingDir}/base.tar -C ${dataDir}`,
          `mkdir -p ${dataDir}/pg_wal`,
          `tar -xf ${stagingDir}/pg_wal.tar -C ${dataDir}/pg_wal`,
          `chown -R postgres:postgres ${dataDir}`,
          `chmod 700 ${dataDir}`,
        ].join(' && '),
      ],
    },
    {
      description:
        'start postgres in the background as the postgres user (crash/backup recovery replays bundled WAL)',
      argv: ['exec', '-d', '-u', 'postgres', opts.name, 'postgres', '-D', dataDir],
    },
  ];
}

export interface PgBackRestRestoreArgvOptions {
  stanza: string;
  targetTimeIso: string;
  pgDataDir: string;
  repoPath: string;
}

/**
 * The PRODUCTION pgBackRest PITR restore shape - built and unit-tested here,
 * NEVER spawned on this box (pgBackRest is not installed on Windows and does
 * not run here). Real operator use is documented in
 * `docs/runbooks/restore-from-backup.md`.
 */
export function buildPgBackRestRestoreArgv(opts: PgBackRestRestoreArgvOptions): string[] {
  return [
    `--stanza=${opts.stanza}`,
    '--type=time',
    `--target=${opts.targetTimeIso}`,
    '--target-action=promote',
    `--pg1-path=${opts.pgDataDir}`,
    `--repo1-path=${opts.repoPath}`,
    'restore',
  ];
}

// Ledger-chain / RPO / RTO computations live in `scripts/ops/restore-drill-
// metrics.ts` (moved there, not `infra/backup/`, so `app/backend`'s
// composite project can import them too - see that file's own header) -
// re-exported here so `infra/backup/restore-drill.ts` and this unit's own
// tests can import either module.
export {
  evaluateLedgerChain,
  computeRecoveryPoint,
  computeRto,
  type LedgerRow,
  type LedgerBreak,
  type LedgerChainResult,
  type ComputeRecoveryPointInput,
  type RecoveryPointResult,
  type ComputeRtoInput,
  type RtoResult,
} from '../../scripts/ops/restore-drill-metrics.js';
