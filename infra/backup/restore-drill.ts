import { createReadStream, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNotProductionTarget,
  assertSourceIsSafe,
  buildPgBackRestRestoreArgv,
  type DrillTarget,
} from './restore-drill-lib.js';
import { runBasebackupMode } from './restore-drill-basebackup.js';
import type {
  RestoreDrillCliArgs,
  RestoreDrillDeps,
  RestoreDrillEnv,
  RestoreDrillRunResult,
  RunProcess,
} from './restore-drill-types.js';
import type { RestoreDrillReport } from '../../scripts/ops/restore-drill-report.js';

/**
 * restore-drill.ts (P29a Unit U3, step 9) - the timed Postgres restore
 * drill orchestrator. Extends the P26 pg_dump-based drill
 * (`scripts/ops/restore-drill.ps1`/`.sh`) with a real `pg_basebackup` into a
 * SCRATCH docker container (the mode actually exercised on this dev box)
 * and the production `pgbackrest` PITR argv shape (built, never spawned
 * here).
 *
 * The spawner is injected (`RunProcess`) so unit tests can assert "nothing
 * executed" on a refusal, and assert the exact argv sequence for each mode,
 * without touching a real process or docker. Shared types live in the
 * sibling `restore-drill-types.ts` (see that file's own header for why).
 */

export type {
  RunProcessResult,
  RunProcess,
  RestoreDrillCliArgs,
  RestoreDrillEnv,
  RestoreDrillDeps,
  RestoreDrillRunResult,
} from './restore-drill-types.js';

const DEFAULT_SCRATCH_PORT = 55499;

export function parseRestoreDrillArgv(argv: string[]): RestoreDrillCliArgs {
  const map = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (key === 'keep' || key === 'allow-remote-source') {
      flags.add(key);
      continue;
    }
    if (next !== undefined) {
      map.set(key, next);
      i += 1;
    }
  }
  const mode = map.get('mode') === 'pgbackrest' ? 'pgbackrest' : 'basebackup';
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    mode,
    scratchPort: Number(map.get('scratch-port') ?? DEFAULT_SCRATCH_PORT),
    keep: flags.has('keep'),
    productionHost: map.get('production-host'),
    allowRemoteSource: flags.has('allow-remote-source'),
    pgBin: map.get('pg-bin') ?? 'C:\\Program Files\\PostgreSQL\\17\\bin',
    outPath: map.get('out') ?? `docs/measurements/${stamp}-restore-drill.json`,
    markdownPath: map.get('markdown') ?? `docs/evidence/P29-restore-drill.md`,
  };
}

/** Reads the connection env the wrappers set (mirrors `scripts/ops/restore-drill.ps1`'s own env contract). */
export function readRestoreDrillEnv(env: NodeJS.ProcessEnv): RestoreDrillEnv {
  const port = Number(env.POSTGRES_PORT ?? env.PGPORT ?? '5432');
  return {
    host: env.POSTGRES_HOST ?? env.PGHOST ?? '127.0.0.1',
    port,
    user: env.POSTGRES_USER ?? env.PGUSER ?? '',
    password: env.POSTGRES_PASSWORD ?? env.PGPASSWORD ?? '',
    database: env.POSTGRES_DB ?? 'wp',
  };
}

/**
 * The `pgbackrest` mode ONLY builds and spawns the pgBackRest PITR argv -
 * it is the production restore shape (`docs/runbooks/restore-from-backup.md`
 * documents real operator use); it is never actually functional on this box
 * (pgBackRest is not installed on Windows), so this path exists for its own
 * unit test (argv assertion only) and is refused for a real run below.
 */
async function runPgBackRestMode(deps: RestoreDrillDeps): Promise<number> {
  const targetTimeIso = deps.now();
  const argv = buildPgBackRestRestoreArgv({
    stanza: 'wp',
    targetTimeIso,
    pgDataDir: '/var/lib/postgresql/data',
    repoPath: '/var/lib/pgbackrest',
  });
  const result = await deps.runProcess('pgbackrest', argv);
  deps.out(
    `restore-drill: pgbackrest mode ran with exit ${String(result.code)} (argv-only on this box)`,
  );
  return result.code;
}

/**
 * Runs the whole drill. `assertNotProductionTarget` is called FIRST, before
 * any process is spawned - a refusal here means the returned result has
 * `exitCode !== 0` and `deps.runProcess` was never invoked once.
 */
export async function runRestoreDrill(
  args: RestoreDrillCliArgs,
  deps: RestoreDrillDeps,
): Promise<RestoreDrillRunResult> {
  const source = readRestoreDrillEnv(deps.env);
  const sourceTarget: DrillTarget = {
    host: source.host,
    port: source.port,
    database: source.database,
  };
  const target: DrillTarget = {
    host: '127.0.0.1',
    port: args.scratchPort,
    database: source.database,
  };

  assertSourceIsSafe(sourceTarget, args.allowRemoteSource, undefined, args.productionHost);
  assertNotProductionTarget(target, sourceTarget, undefined, args.productionHost);

  if (args.mode === 'pgbackrest') {
    const code = await runPgBackRestMode(deps);
    return {
      verdict: code === 0 ? 'PASS' : 'FAIL',
      mode: 'pgbackrest',
      rtoMs: 0,
      rpoSeconds: 0,
      reportPath: args.outPath,
      exitCode: code,
    };
  }

  return runBasebackupMode(deps, args, source);
}

function realRunProcess(): RunProcess {
  return (command, argv, opts) =>
    new Promise((resolvePromise, reject) => {
      void import('node:child_process').then(({ spawn }) => {
        const child = spawn(command, argv, {
          stdio: [opts?.stdinFromFile !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          env: opts?.env !== undefined ? { ...process.env, ...opts.env } : process.env,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          resolvePromise({ code: code ?? 1, stdout, stderr });
        });
        if (opts?.stdinFromFile !== undefined && child.stdin !== null) {
          const readStream = createReadStream(opts.stdinFromFile);
          readStream.pipe(child.stdin);
        }
      });
    });
}

async function main(): Promise<void> {
  const args = parseRestoreDrillArgv(process.argv.slice(2));

  // `pg_basebackup`/`psql` etc. read PGHOST/PGPORT/PGUSER/PGPASSWORD, not
  // this repo's POSTGRES_* names - the P26 PS1 script set these explicitly
  // for the same reason (`$env:PGPASSWORD = $env:POSTGRES_PASSWORD`); this
  // TS orchestrator's own child processes need the same mapping applied to
  // ITS `process.env` before spawning, since `realRunProcess` forwards
  // `process.env` verbatim to every native child.
  const sourceEnv = readRestoreDrillEnv(process.env);
  process.env.PGHOST = sourceEnv.host;
  process.env.PGPORT = String(sourceEnv.port);
  process.env.PGUSER = sourceEnv.user;
  process.env.PGPASSWORD = sourceEnv.password;

  const deps: RestoreDrillDeps = {
    runProcess: realRunProcess(),
    env: process.env,
    out: (line) => {
      console.log(line);
    },
    now: () => new Date().toISOString(),
    readFileSize: (filePath) => statSync(filePath).size,
  };

  const result = await runRestoreDrill(args, deps);

  // One number, one source: the final line reports the WRITTEN report's own
  // `rto.rtoMs`/`recovery.rpoSeconds` (read back from `result.reportPath`),
  // never a separately measured figure - a report and its own headline must
  // never disagree (same discipline as `computeRestoreDrillProblems`).
  let rtoMs = result.rtoMs;
  let rpoSeconds = result.rpoSeconds;
  try {
    const written = JSON.parse(
      readFileSync(result.reportPath, 'utf8'),
    ) as Partial<RestoreDrillReport>;
    rtoMs = written.rto?.rtoMs ?? written.restore?.tookMs ?? rtoMs;
    rpoSeconds = written.recovery?.rpoSeconds ?? rpoSeconds;
  } catch {
    // No report was written (e.g. a refusal or a pre-verify failure) - fall
    // back to the orchestrator's own result figures.
  }

  console.log(
    `RESTORE-DRILL: ${result.verdict} mode=${result.mode} rto=${String(rtoMs)} rpo=${String(rpoSeconds)} report=${result.reportPath}`,
  );
  process.exitCode = result.exitCode;
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((err: unknown) => {
    console.error('restore drill failed to run:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
