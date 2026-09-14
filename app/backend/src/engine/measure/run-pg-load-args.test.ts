import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertDrainFeasible,
  defaultDrainTimeoutMinutes,
  expectedDrainSeconds,
  parseRunPgLoadArgs,
  sendsPerInstance,
  InfeasibleDrainError,
} from './run-pg-load-args.js';

/**
 * run-pg-load-args.test.ts (P26 C1 fix round, FIX-C MAJOR 4) - the CLI
 * surface's own unit test, plus the literal-scan extension the review asked
 * for: `pg-load-validate.test.ts`'s `derived_literals_never_leak_outside_
 * derived_comparison` covers only `scripts/measure/pg-load.ts`, so a literal
 * `sendsPerDayPerInstance: 600` in the RUNNABLE half
 * (`run-pg-load.ts`) went unscanned - exactly the MAJOR 4 finding. Does not
 * reach `@wp/server-kit` (only `@wp/domain`, `node:fs`/`node:os`, and
 * `scripts/measure/scale-fleet.js`, which has no server-kit dependency - see
 * `measure-enqueue.test.ts` for the same reasoning), so no
 * `stub-wp-server-kit-env` import is needed here.
 */

describe('parseRunPgLoadArgs', () => {
  it('defaults sends/instances/caps the same way as before', () => {
    const args = parseRunPgLoadArgs([]);
    expect(args.sends).toBe(100_000);
    expect(args.instances).toBe(1_000);
    expect(sendsPerInstance(args.sends, args.instances)).toBe(100);
  });

  it('accepts --sends-per-day as an explicit override for the projection input', () => {
    const args = parseRunPgLoadArgs(['--sends-per-day', '450']);
    expect(args.sendsPerDay).toBe(450);
  });

  it('--sends-per-day is undefined when absent, signalling "derive from the tenant mix"', () => {
    const args = parseRunPgLoadArgs([]);
    expect(args.sendsPerDay).toBeUndefined();
  });

  it('accepts --baseline-seconds (default 60) and --concurrent-note (default "none declared")', () => {
    const defaults = parseRunPgLoadArgs([]);
    expect(defaults.baselineSeconds).toBe(60);
    expect(defaults.concurrentNote).toBe('none declared');

    const overridden = parseRunPgLoadArgs([
      '--baseline-seconds',
      '0',
      '--concurrent-note',
      'wp-p26-drift 7-day run, ~1000 sessions',
    ]);
    expect(overridden.baselineSeconds).toBe(0);
    expect(overridden.concurrentNote).toBe('wp-p26-drift 7-day run, ~1000 sessions');
  });

  it('re-exports the drain-arithmetic helpers unchanged', () => {
    expect(expectedDrainSeconds(100, 10)).toBeGreaterThan(0);
    expect(defaultDrainTimeoutMinutes(100, 10)).toBeGreaterThan(0);
    expect(() =>
      assertDrainFeasible({
        sends: 100_000,
        instances: 10,
        tenants: 1,
        workers: 1,
        forcePgBouncer: false,
        out: 'x',
        projectedAt: [],
        drainTimeoutMinutes: 1,
        hourlyCap: 1,
        dailyCap: 1,
        drainTimeoutDerived: false,
        sendsPerDay: undefined,
        baselineSeconds: 60,
        concurrentNote: 'none declared',
      }),
    ).toThrow(InfeasibleDrainError);
  });
});

describe('run-pg-load*.ts never carries a bare sends/day literal outside a derivation call', () => {
  it('run_pg_load_never_hardcodes_sendsPerDayPerInstance', () => {
    const files = ['./run-pg-load.ts', './run-pg-load-fleet.ts', './run-pg-load-snapshots.ts'];
    for (const rel of files) {
      const here = fileURLToPath(new URL(rel, import.meta.url));
      const source = readFileSync(here, 'utf8');
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(withoutComments).not.toMatch(/sendsPerDayPerInstance:\s*\d/);
    }
  });
});
