import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildBaseBackupArgv,
  buildScratchContainerPlan,
  type DockerCommand,
} from './restore-drill-lib.js';
import type {
  RestoreDrillCliArgs,
  RestoreDrillDeps,
  RestoreDrillEnv,
  RestoreDrillRunResult,
} from './restore-drill-types.js';

/**
 * restore-drill-basebackup.ts (P29a Unit U3, step 9) - the `basebackup`
 * mode's runner, split out of `restore-drill.ts` purely for the repo's
 * `max-lines` cap (same code-motion-split idiom as
 * `session-worker-discovery-wiring.ts`). No new module boundary: this file
 * and `restore-drill.ts` share one contract, documented on the orchestrator.
 *
 * Real `pg_basebackup` -> scratch docker container -> verify -> report ->
 * cleanup. Every native call goes through the injected `deps.runProcess` so
 * tests never touch a real process.
 */

async function runDockerCommand(
  runProcess: RestoreDrillDeps['runProcess'],
  cmd: DockerCommand,
): Promise<{ code: number; stderr: string }> {
  const result = await runProcess('docker', cmd.argv, { stdinFromFile: cmd.stdinFromFile });
  return { code: result.code, stderr: result.stderr };
}

export async function runBasebackupMode(
  deps: RestoreDrillDeps,
  args: RestoreDrillCliArgs,
  source: RestoreDrillEnv,
): Promise<RestoreDrillRunResult> {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const scratchDir = mkdtempSync(path.join(tmpdir(), `wp-restore-drill-${stamp}-`));
  const containerName = `wp-restore-drill-${stamp}`;
  const volumeName = `wp_restore_drill_${stamp}`;
  const drillPassword = randomBytes(16).toString('hex');
  const baseTarPath = path.join(scratchDir, 'base.tar');
  const pgWalTarPath = path.join(scratchDir, 'pg_wal.tar');

  const backupStartIso = deps.now();
  const pgBasebackupArgv = buildBaseBackupArgv({
    pgBin: args.pgBin,
    host: source.host,
    port: source.port,
    user: source.user,
    outDir: scratchDir,
  });
  const backupResult = await deps.runProcess(
    path.join(args.pgBin, 'pg_basebackup.exe'),
    pgBasebackupArgv,
  );
  const backupEndIso = deps.now();
  if (backupResult.code !== 0) {
    deps.out(
      `restore-drill: pg_basebackup failed with exit ${String(backupResult.code)}: ${backupResult.stderr || backupResult.stdout}`,
    );
    return {
      verdict: 'FAIL',
      mode: 'basebackup',
      rtoMs: 0,
      rpoSeconds: 0,
      reportPath: args.outPath,
      exitCode: 1,
    };
  }

  const restoreStartIso = deps.now();
  const plan = buildScratchContainerPlan({
    name: containerName,
    port: args.scratchPort,
    volume: volumeName,
    baseTarPath,
    pgWalTarPath,
    drillPassword,
  });

  let planFailed = false;
  for (const step of plan) {
    const { code, stderr } = await runDockerCommand(deps.runProcess, step);
    if (code !== 0) {
      deps.out(
        `restore-drill: docker step failed (${step.description}), exit ${String(code)}: ${stderr}`,
      );
      planFailed = true;
      break;
    }
  }

  let exitCode = planFailed ? 1 : 0;
  let verifiedAtIso = deps.now();

  if (!planFailed) {
    // Readiness wait: bounded loop, no sleep-based assertions in tests -
    // a fake `runProcess` in a unit test returns ready on the first
    // `pg_isready` call, so no wall-clock wait ever occurs under test.
    const maxAttempts = 60;
    let ready = false;
    for (let attempt = 0; attempt < maxAttempts && !ready; attempt += 1) {
      const check = await deps.runProcess('docker', [
        'exec',
        containerName,
        'pg_isready',
        '-h',
        'localhost',
        '-p',
        '5432',
      ]);
      ready = check.code === 0;
      if (!ready) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
      }
    }
    if (!ready) {
      deps.out('restore-drill: scratch container never became ready within the 10-minute cap');
      exitCode = 1;
    }
  }

  if (!planFailed && exitCode === 0) {
    const targetUrl = `postgres://${source.user}:${source.password}@127.0.0.1:${String(args.scratchPort)}/${source.database}`;
    const sourceUrl = `postgres://${source.user}:${source.password}@${source.host}:${String(source.port)}/${source.database}`;
    mkdirSync(path.dirname(args.outPath), { recursive: true });
    mkdirSync(path.dirname(args.markdownPath), { recursive: true });

    const backupMs = new Date(backupEndIso).getTime() - new Date(backupStartIso).getTime();
    const backupBytes = deps.readFileSize(baseTarPath) + deps.readFileSize(pgWalTarPath);

    const verifyResult = await deps.runProcess(
      'pnpm',
      [
        'exec',
        'tsx',
        'app/backend/src/engine/measure/run-restore-verify.ts',
        '--out',
        args.outPath,
        '--mode',
        'basebackup-scratch-container',
        '--restore-start',
        restoreStartIso,
        '--backup-end',
        backupEndIso,
        '--backup-ms',
        String(backupMs),
        '--backup-bytes',
        String(backupBytes),
        '--base-tar',
        baseTarPath,
      ],
      {
        // DSNs travel through the child's ENVIRONMENT, never argv - argv is
        // visible in process listings (`ps`/Task Manager), env is not.
        env: {
          RESTORE_DRILL_SOURCE_URL: sourceUrl,
          RESTORE_DRILL_TARGET_URL: targetUrl,
        },
      },
    );
    verifiedAtIso = deps.now();
    if (verifyResult.code !== 0) {
      exitCode = 1;
    }

    const validateResult = await deps.runProcess('pnpm', [
      'exec',
      'tsx',
      'scripts/ops/restore-drill-report.ts',
      '--validate',
      args.outPath,
    ]);
    if (validateResult.code !== 0) {
      exitCode = 1;
    }

    const markdownResult = await deps.runProcess('pnpm', [
      'exec',
      'tsx',
      'scripts/ops/restore-drill-report.ts',
      '--markdown',
      args.outPath,
      args.markdownPath,
    ]);
    if (markdownResult.code !== 0) {
      exitCode = 1;
    }
  }

  if (!args.keep) {
    await deps.runProcess('docker', ['rm', '-f', containerName]);
    await deps.runProcess('docker', ['volume', 'rm', volumeName]);
    rmSync(scratchDir, { recursive: true, force: true });
  }

  const rtoMs = new Date(verifiedAtIso).getTime() - new Date(restoreStartIso).getTime();

  return {
    verdict: exitCode === 0 ? 'PASS' : 'FAIL',
    mode: 'basebackup',
    rtoMs,
    // The single source of truth for RPO is the WRITTEN report's own
    // `recovery.rpoSeconds` (computed by `computeRecoveryPoint` inside
    // `buildBasebackupReport`, then read back in `restore-drill.ts`'s
    // `main()`) - this orchestrator result is a pre-report fallback only, so
    // it reports 0 honestly rather than a locally re-derived (and, before
    // this fix, backwards-subtracted) figure.
    rpoSeconds: 0,
    reportPath: args.outPath,
    exitCode,
  };
}
