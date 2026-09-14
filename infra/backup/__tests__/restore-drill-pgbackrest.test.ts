import { describe, expect, it, vi } from 'vitest';
import {
  buildPgBackRestRestoreArgv,
  computeRecoveryPoint,
  computeRto,
} from '../restore-drill-lib.js';
import { runRestoreDrill, type RestoreDrillCliArgs, type RunProcess } from '../restore-drill.js';

/**
 * restore-drill-pgbackrest.test.ts (P29a Unit U3, step 9) - split out of
 * `restore-drill.test.ts` purely for the repo's `max-lines` cap (that file
 * sat at 306/300 lines with these tests included). Covers the `pgbackrest`
 * mode's argv shape (never spawned for real - pgBackRest is not installed
 * on Windows) and the pure `computeRecoveryPoint`/`computeRto` contracts.
 */

function defaultArgs(overrides: Partial<RestoreDrillCliArgs> = {}): RestoreDrillCliArgs {
  return {
    mode: 'basebackup',
    scratchPort: 55499,
    keep: false,
    allowRemoteSource: false,
    pgBin: 'C:\\Program Files\\PostgreSQL\\17\\bin',
    outPath: 'ignored.json',
    markdownPath: 'ignored.md',
    ...overrides,
  };
}

function buildFakeRunProcess(calls: Array<{ command: string; argv: string[] }>): RunProcess {
  return async (command, argv) => {
    calls.push({ command, argv });
    return { code: 0, stdout: '', stderr: '' };
  };
}

describe('the pgbackrest mode builds a point-in-time restore into a scratch target', () => {
  it('the_pgbackrest_mode_builds_a_point_in_time_restore_into_a_scratch_target', async () => {
    const argv = buildPgBackRestRestoreArgv({
      stanza: 'wp',
      targetTimeIso: '2026-09-08T00:00:00.000Z',
      pgDataDir: '/var/lib/postgresql/data',
      repoPath: '/var/lib/pgbackrest',
    });
    expect(argv).toContain('--type=time');
    expect(argv).toContain('--target=2026-09-08T00:00:00.000Z');
    expect(argv).toContain('--target-action=promote');

    const calls: Array<{ command: string; argv: string[] }> = [];
    const deps = {
      runProcess: buildFakeRunProcess(calls),
      env: {
        POSTGRES_HOST: '127.0.0.1',
        POSTGRES_PORT: '55432',
        POSTGRES_USER: 'wp',
        POSTGRES_PASSWORD: 'x',
        POSTGRES_DB: 'wp',
      },
      out: vi.fn(),
      now: () => '2026-09-08T00:00:00.000Z',
      readFileSize: () => 0,
    };
    await runRestoreDrill(defaultArgs({ mode: 'pgbackrest' }), deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('pgbackrest');
    expect(calls[0]?.argv).not.toContain('pg_basebackup');
  });
});

// Sanity: computeRecoveryPoint / computeRto pure-function contracts used
// indirectly via fixtures in restore-drill.test.ts - exercised directly
// here too, since they are exported and part of this unit's public
// contract.
describe('recovery point and RTO computations', () => {
  it('computeRecoveryPoint_and_computeRto_compute_exact_values', () => {
    const recovery = computeRecoveryPoint({
      backupEndIso: '2026-09-08T00:00:00.000Z',
      lastReplayIso: null,
      drillStartIso: '2026-09-08T00:02:00.000Z',
    });
    expect(recovery.recoveryPointIso).toBe('2026-09-08T00:00:00.000Z');
    expect(recovery.rpoSeconds).toBe(120);
    expect(recovery.ok).toBe(true);

    const rto = computeRto({
      restoreStartIso: '2026-09-08T00:00:00.000Z',
      verifiedAtIso: '2026-09-08T00:01:00.000Z',
    });
    expect(rto.rtoMs).toBe(60_000);
    expect(rto.ok).toBe(true);
  });
});
