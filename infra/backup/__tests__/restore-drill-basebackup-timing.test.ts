import { describe, expect, it, vi } from 'vitest';
import { runRestoreDrill, type RestoreDrillCliArgs, type RunProcess } from '../restore-drill.js';

/**
 * restore-drill-basebackup-timing.test.ts (P29a defect-1 fix, 2026-09-09) -
 * split out of `restore-drill.test.ts` purely for the repo's `max-lines`
 * cap (same code-motion-split idiom as `restore-drill-pgbackrest.test.ts`,
 * which duplicates its own small `defaultArgs`/`buildFakeRunProcess`
 * helpers rather than importing another `.test.ts` file - importing a test
 * file as a module re-registers its `describe`/`it` blocks into THIS run).
 * Proves the `pg_basebackup` phase is timed (`--backup-ms`) and sized
 * (`--backup-bytes`) via the verify invocation's argv - a fake spawner and
 * an injected clock/size-reader only, no real process or file.
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

function buildFakeRunProcessWithOpts(
  calls: Array<{ command: string; argv: string[]; env?: Record<string, string> }>,
): RunProcess {
  return async (command, argv, opts) => {
    calls.push({ command, argv, env: opts?.env });
    return { code: 0, stdout: '', stderr: '' };
  };
}

// One ISO per `deps.now()` call in call order: backupStart, backupEnd,
// restoreStart, verifiedAt(pre-verify, unused), verifiedAt(post-verify).
const ISO_SEQUENCE = [
  '2026-09-08T00:00:00.000Z',
  '2026-09-08T00:00:07.500Z',
  '2026-09-08T00:00:08.000Z',
  '2026-09-08T00:00:09.000Z',
  '2026-09-08T00:02:00.000Z',
];

describe('the basebackup phase is timed and sized in the report argv', () => {
  it('the_basebackup_phase_is_timed_and_sized_in_the_report_argv', async () => {
    const calls: Array<{ command: string; argv: string[] }> = [];
    const fakeRunProcess = buildFakeRunProcess(calls);

    let callIndex = 0;
    const now = (): string => {
      const value = ISO_SEQUENCE[callIndex] ?? ISO_SEQUENCE[ISO_SEQUENCE.length - 1];
      callIndex += 1;
      return value as string;
    };
    // base.tar=900_000_000 + pg_wal.tar=25_988_531 = 925_988_531 bytes.
    const readFileSize = (path: string): number => {
      if (path.endsWith('base.tar')) return 900_000_000;
      if (path.endsWith('pg_wal.tar')) return 25_988_531;
      return 0;
    };

    const deps = {
      runProcess: fakeRunProcess,
      env: {
        POSTGRES_HOST: '127.0.0.1',
        POSTGRES_PORT: '55432',
        POSTGRES_USER: 'wp',
        POSTGRES_PASSWORD: 'x',
        POSTGRES_DB: 'wp',
      },
      out: vi.fn(),
      now,
      readFileSize,
    };

    await runRestoreDrill(defaultArgs(), deps);

    const verifyCall = calls.find((call) =>
      call.argv.some((arg) => arg.includes('run-restore-verify.ts')),
    );
    expect(verifyCall).toBeDefined();
    const argv = verifyCall?.argv ?? [];
    const backupMsIndex = argv.indexOf('--backup-ms');
    const backupBytesIndex = argv.indexOf('--backup-bytes');
    expect(backupMsIndex).toBeGreaterThan(-1);
    expect(backupBytesIndex).toBeGreaterThan(-1);
    // backupEnd - backupStart = 00:00:07.500 - 00:00:00.000 = 7500 ms.
    expect(argv[backupMsIndex + 1]).toBe('7500');
    expect(argv[backupBytesIndex + 1]).toBe('925988531');
  });
});

describe('the_verifier_receives_dsns_through_env_not_argv', () => {
  it('the_verifier_receives_dsns_through_env_not_argv', async () => {
    const calls: Array<{ command: string; argv: string[]; env?: Record<string, string> }> = [];
    const fakeRunProcess = buildFakeRunProcessWithOpts(calls);

    let callIndex = 0;
    const now = (): string => {
      const value = ISO_SEQUENCE[callIndex] ?? ISO_SEQUENCE[ISO_SEQUENCE.length - 1];
      callIndex += 1;
      return value as string;
    };

    const deps = {
      runProcess: fakeRunProcess,
      env: {
        POSTGRES_HOST: '127.0.0.1',
        POSTGRES_PORT: '55432',
        POSTGRES_USER: 'wp',
        POSTGRES_PASSWORD: 'secret-pw',
        POSTGRES_DB: 'wp',
      },
      out: vi.fn(),
      now,
      readFileSize: () => 0,
    };

    await runRestoreDrill(defaultArgs(), deps);

    const verifyCall = calls.find((call) =>
      call.argv.some((arg) => arg.includes('run-restore-verify.ts')),
    );
    expect(verifyCall).toBeDefined();
    const argv = verifyCall?.argv ?? [];

    expect(argv.some((arg) => arg.includes('postgres://'))).toBe(false);
    expect(verifyCall?.env?.RESTORE_DRILL_SOURCE_URL).toContain('postgres://');
    expect(verifyCall?.env?.RESTORE_DRILL_TARGET_URL).toContain('postgres://');
    expect(verifyCall?.env?.RESTORE_DRILL_SOURCE_URL).toContain('secret-pw');
    expect(verifyCall?.env?.RESTORE_DRILL_TARGET_URL).toContain('secret-pw');
  });
});
