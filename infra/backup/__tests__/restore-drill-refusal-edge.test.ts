import { describe, expect, it, vi } from 'vitest';
import {
  assertNotProductionTarget,
  RestoreDrillRefusedError,
  type DrillTarget,
} from '../restore-drill-lib.js';
import { runRestoreDrill, type RestoreDrillCliArgs, type RunProcess } from '../restore-drill.js';

/**
 * restore-drill-refusal-edge.test.ts (P29a E3/C2 hardening) - production-
 * refusal edge cases beyond the four already covered in restore-drill.test.ts:
 * case sensitivity, IPv6/0.0.0.0, DSN-shaped strings, empty host, trailing
 * dots, same-port-different-database, `--production-host` regex metacharacter
 * safety, and the orchestrator recording ZERO spawned processes AND writing
 * NO file on refusal.
 */

const SOURCE: DrillTarget = { host: '127.0.0.1', port: 55432, database: 'wp' };

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

describe('assertNotProductionTarget edge cases', () => {
  it('a_production_host_pattern_match_is_case_insensitive', () => {
    expect(() =>
      assertNotProductionTarget({ host: 'DB.WP.INTERNAL', port: 55499, database: 'wp' }, SOURCE),
    ).toThrow(RestoreDrillRefusedError);
  });

  it('a_production_host_pattern_match_is_case_insensitive_mixed_case', () => {
    expect(() =>
      assertNotProductionTarget({ host: 'Db.Wp.Internal', port: 55499, database: 'wp' }, SOURCE),
    ).toThrow(RestoreDrillRefusedError);
  });

  it('ipv6_loopback_is_not_in_the_loopback_allowlist_and_is_refused', () => {
    // `[::1]` (bracketed, as it appears in a URL/host string) is NOT the bare
    // `::1` the loopback set recognises - refused as "not loopback".
    expect(() =>
      assertNotProductionTarget({ host: '[::1]', port: 55499, database: 'wp' }, SOURCE),
    ).toThrow(RestoreDrillRefusedError);
  });

  it('bare_ipv6_loopback_is_accepted_as_loopback', () => {
    const ipv6Source: DrillTarget = { host: '::1', port: 55432, database: 'wp' };
    expect(() =>
      assertNotProductionTarget({ host: '::1', port: 55499, database: 'wp' }, ipv6Source),
    ).not.toThrow();
  });

  it('0_0_0_0_is_refused_as_not_loopback', () => {
    expect(() =>
      assertNotProductionTarget({ host: '0.0.0.0', port: 55499, database: 'wp' }, SOURCE),
    ).toThrow(RestoreDrillRefusedError);
  });

  it('a_dsn_shaped_string_with_userinfo_is_refused_as_not_loopback', () => {
    expect(() =>
      assertNotProductionTarget(
        { host: 'postgres://user:pass@127.0.0.1:5432', port: 55499, database: 'wp' },
        SOURCE,
      ),
    ).toThrow(RestoreDrillRefusedError);
  });

  it('an_empty_host_is_refused_as_not_loopback', () => {
    expect(() =>
      assertNotProductionTarget({ host: '', port: 55499, database: 'wp' }, SOURCE),
    ).toThrow(RestoreDrillRefusedError);
  });

  it('localhost_with_a_trailing_dot_is_refused_as_not_loopback', () => {
    // `localhost.` (FQDN trailing-dot form) is a DIFFERENT string from the
    // exact `localhost` in the allowlist - must not be silently treated as
    // equivalent.
    expect(() =>
      assertNotProductionTarget({ host: 'localhost.', port: 55499, database: 'wp' }, SOURCE),
    ).toThrow(RestoreDrillRefusedError);
  });

  it('same_host_same_port_as_source_is_refused_regardless_of_database_name', () => {
    expect(() =>
      assertNotProductionTarget(
        { host: '127.0.0.1', port: 55432, database: 'some-other-db' },
        SOURCE,
      ),
    ).toThrow(RestoreDrillRefusedError);
  });

  it('a_production_host_pattern_with_regex_metacharacters_does_not_crash_or_bypass', () => {
    // A `--production-host` value containing regex metacharacters (from the
    // OPERATOR-supplied string, not the pattern side) must be matched
    // literally against the pattern list, never interpreted as its own
    // regex - and must not throw a regex compile error.
    const weirdHost = 'db.wp.internal(evil)[.*';
    expect(() =>
      assertNotProductionTarget(
        { host: '127.0.0.1', port: 55499, database: 'wp' },
        SOURCE,
        undefined,
        weirdHost,
      ),
    ).toThrow(RestoreDrillRefusedError);
  });

  it('a_production_host_value_that_matches_no_pattern_does_not_refuse', () => {
    expect(() =>
      assertNotProductionTarget(
        { host: '127.0.0.1', port: 55499, database: 'wp' },
        SOURCE,
        undefined,
        'totally-benign-label',
      ),
    ).not.toThrow();
  });

  it('the_refused_error_message_never_names_a_password', () => {
    try {
      assertNotProductionTarget({ host: 'db.wp.internal', port: 55499, database: 'wp' }, SOURCE);
      throw new Error('unreachable: expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RestoreDrillRefusedError);
      const message = (err as Error).message;
      expect(message).not.toMatch(/password/i);
    }
  });
});

describe('orchestrator refusal has zero side effects', () => {
  it('a_refused_target_records_zero_spawned_processes_and_writes_no_file', async () => {
    const calls: Array<{ command: string; argv: string[] }> = [];
    const writtenFiles: string[] = [];
    const runProcess: RunProcess = async (command, argv) => {
      calls.push({ command, argv });
      return { code: 0, stdout: '', stderr: '' };
    };
    const deps = {
      runProcess,
      env: {
        POSTGRES_HOST: 'db.wp.internal',
        POSTGRES_PORT: '55432',
        POSTGRES_USER: 'wp',
        POSTGRES_PASSWORD: 'x',
        POSTGRES_DB: 'wp',
      },
      out: vi.fn((line: string) => {
        // Simulates a caller that would write evidence based on `out` lines -
        // proves nothing is ever emitted for a refused run either.
        writtenFiles.push(line);
      }),
      now: () => '2026-09-08T00:00:00.000Z',
      readFileSize: () => 0,
    };

    await expect(
      runRestoreDrill(defaultArgs({ productionHost: 'db.wp.internal' }), deps),
    ).rejects.toThrow(RestoreDrillRefusedError);

    expect(calls).toHaveLength(0);
    expect(writtenFiles).toHaveLength(0);
  });

  it('a_refused_pgbackrest_mode_also_records_zero_spawned_processes', async () => {
    const calls: Array<{ command: string; argv: string[] }> = [];
    const runProcess: RunProcess = async (command, argv) => {
      calls.push({ command, argv });
      return { code: 0, stdout: '', stderr: '' };
    };
    const deps = {
      runProcess,
      env: {
        POSTGRES_HOST: 'db.wp.internal',
        POSTGRES_PORT: '55432',
        POSTGRES_USER: 'wp',
        POSTGRES_PASSWORD: 'x',
        POSTGRES_DB: 'wp',
      },
      out: vi.fn(),
      now: () => '2026-09-08T00:00:00.000Z',
      readFileSize: () => 0,
    };

    await expect(
      runRestoreDrill(defaultArgs({ mode: 'pgbackrest', productionHost: 'db.wp.internal' }), deps),
    ).rejects.toThrow(RestoreDrillRefusedError);

    expect(calls).toHaveLength(0);
  });
});

describe('source-side refusal (finding 6)', () => {
  it('a_production_looking_source_host_is_refused_before_any_spawn', async () => {
    const calls: Array<{ command: string; argv: string[] }> = [];
    const runProcess: RunProcess = async (command, argv) => {
      calls.push({ command, argv });
      return { code: 0, stdout: '', stderr: '' };
    };
    const deps = {
      runProcess,
      env: {
        POSTGRES_HOST: 'db.prod.internal',
        POSTGRES_PORT: '55432',
        POSTGRES_USER: 'wp',
        POSTGRES_PASSWORD: 'x',
        POSTGRES_DB: 'wp',
      },
      out: vi.fn(),
      now: () => '2026-09-08T00:00:00.000Z',
      readFileSize: () => 0,
    };

    await expect(runRestoreDrill(defaultArgs({ allowRemoteSource: true }), deps)).rejects.toThrow(
      RestoreDrillRefusedError,
    );

    expect(calls).toHaveLength(0);
  });

  it('a_remote_source_requires_the_explicit_allow_flag', async () => {
    const calls: Array<{ command: string; argv: string[] }> = [];
    const runProcess: RunProcess = async (command, argv) => {
      calls.push({ command, argv });
      return { code: 0, stdout: '', stderr: '' };
    };
    const deps = {
      runProcess,
      env: {
        POSTGRES_HOST: 'dev-box.example.net',
        POSTGRES_PORT: '55432',
        POSTGRES_USER: 'wp',
        POSTGRES_PASSWORD: 'x',
        POSTGRES_DB: 'wp',
      },
      out: vi.fn(),
      now: () => '2026-09-08T00:00:00.000Z',
      readFileSize: () => 0,
    };

    await expect(runRestoreDrill(defaultArgs({ allowRemoteSource: false }), deps)).rejects.toThrow(
      RestoreDrillRefusedError,
    );
    expect(calls).toHaveLength(0);

    // With the flag, the drill proceeds past the refusal to its first spawn
    // (the real `pg_basebackup` call fails immediately under the fake
    // spawner's non-zero-free default here, but the point is it was reached
    // at all - zero calls above, at least one call now).
    calls.length = 0;
    await runRestoreDrill(defaultArgs({ allowRemoteSource: true }), deps);
    expect(calls.length).toBeGreaterThan(0);
  });
});
