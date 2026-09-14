/**
 * scripts/chaos/run-chaos.ts (P26 U6b, step 6) - the PURE half of the chaos
 * harness: flush-target refusal, the deploy-wave-size SLO formula, the
 * scenario registry, the run-record schema + validator/formatter, and the
 * CLI entry. No pg/ioredis/app-backend import here (scripts/ cannot import
 * app/backend - same boundary as `scale-fleet.ts`'s own header). Scenario
 * EXECUTION lives in the `app/backend/test/integration/chaos/*.integration.
 * test.ts` files, which import `assertFlushTargetAllowed`/`deployWaveSize`
 * from here rather than re-deriving either.
 */

// ---------------------------------------------------------------------
// Flush-target refusal (ADR 0018 S5) - `redis-sig` must NEVER be flushed.
// ---------------------------------------------------------------------

/** The only Redis logical role a chaos drill may ever `FLUSHALL`. */
export const FLUSHABLE_TARGETS = ['redis-ctl'] as const;

export type FlushableTarget = (typeof FLUSHABLE_TARGETS)[number];

export class ForbiddenFlushTargetError extends Error {
  constructor(target: string) {
    super(
      `chaos: refusing to flush target "${target}" - only ${FLUSHABLE_TARGETS.join(', ')} may ` +
        "ever be flushed by a chaos drill. Flushing redis-sig would destroy this instance's " +
        'Signal ratchet state (ADR 0018 S5): redis-sig holds non-rebuildable session/identity-key ' +
        'material, and losing it makes every already-encrypted inbound message permanently ' +
        'unreadable - there is no recovery path. redis-cache/postgres/"all" are refused for the ' +
        "same reason: this drill's scope is the control plane only.",
    );
    this.name = 'ForbiddenFlushTargetError';
  }
}

/** Throws `ForbiddenFlushTargetError` for anything other than exactly `'redis-ctl'`. */
export function assertFlushTargetAllowed(target: string): asserts target is FlushableTarget {
  if (!(FLUSHABLE_TARGETS as readonly string[]).includes(target)) {
    throw new ForbiddenFlushTargetError(target);
  }
}

// ---------------------------------------------------------------------
// Deploy-wave-size (ADR 0018 S4 / design S4.3 SLO-derived formula).
// ---------------------------------------------------------------------

export class InvalidDeployWaveSizeInputError extends Error {
  constructor(message: string) {
    super(`deployWaveSize: ${message}`);
    this.name = 'InvalidDeployWaveSizeInputError';
  }
}

const DEFAULT_WAVE_FRACTION = 0.02;

/**
 * `max(1, floor(fleetSessions * fraction / sessionsPerWorker))` - the
 * rolling-deploy wave size in WORKER count, derived from the fraction of the
 * fleet's total sessions the SLO allows to be mid-reconnect at once
 * (default 2%), never a fabricated worker count.
 */
export function deployWaveSize(input: {
  fleetSessions: number;
  sessionsPerWorker: number;
  fraction?: number;
}): number {
  const { fleetSessions, sessionsPerWorker } = input;
  const fraction = input.fraction ?? DEFAULT_WAVE_FRACTION;
  if (sessionsPerWorker <= 0) {
    throw new InvalidDeployWaveSizeInputError(
      `sessionsPerWorker must be > 0, got ${String(sessionsPerWorker)}`,
    );
  }
  return Math.max(1, Math.floor((fleetSessions * fraction) / sessionsPerWorker));
}

// ---------------------------------------------------------------------
// Scenario registry + run-record schema.
// ---------------------------------------------------------------------

export type ChaosScenario = 'worker-kill' | 'redis-flush' | 'postgres-outage' | 'rolling-deploy';

export const CHAOS_SCENARIOS: readonly ChaosScenario[] = [
  'worker-kill',
  'redis-flush',
  'postgres-outage',
  'rolling-deploy',
];

export interface ChaosRunRecord {
  schemaVersion: 1;
  kind: 'chaos';
  scenario: ChaosScenario;
  capturedAtIso: string;
  fleet: { instances: number; workers: number; sessionsPerWorker: number };
  /** Every measured SLO number - the value itself, never a pass/fail word. `null` is allowed only alongside a matching entry in `notes` explaining why it is unobservable. */
  measurements: Record<string, number | string | null>;
  sloTargets: Record<string, string>;
  verdict: 'PASS' | 'FAIL';
  problems: string[];
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validates a `ChaosRunRecord`-shaped value. Enforces the phase's own rule
 * ("each artifact records the measured SLO number, not a pass/fail word"):
 * every `measurements` entry must be a number, a string, or an explicitly
 * `null` value accompanied by a matching note; `scenario` must be one of
 * `CHAOS_SCENARIOS`; `measurements` must not be empty; and a `PASS` verdict
 * with non-empty `problems` is itself a problem (a self-contradictory
 * record). Never throws.
 */
export function validateChaosRunRecord(input: unknown): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, problems: ['record is not an object'] };
  }
  const record = input as Partial<ChaosRunRecord>;

  if (!record.scenario || !CHAOS_SCENARIOS.includes(record.scenario)) {
    problems.push(`scenario "${String(record.scenario)}" is not in CHAOS_SCENARIOS`);
  }

  const measurements = record.measurements;
  if (!isRecord(measurements) || Object.keys(measurements).length === 0) {
    problems.push('measurements must be a non-empty object');
  } else {
    const notes = Array.isArray(record.notes) ? record.notes : [];
    for (const [key, value] of Object.entries(measurements)) {
      const kind = typeof value;
      if (kind === 'number' || kind === 'string') continue;
      if (value === null) {
        const explained = notes.some((n) => n.includes(key));
        if (!explained) {
          problems.push(`measurements.${key} is null but no note explains why it is unobservable`);
        }
        continue;
      }
      problems.push(`measurements.${key} must be a number, string, or explained null`);
    }
  }

  if (record.verdict === 'PASS' && Array.isArray(record.problems) && record.problems.length > 0) {
    problems.push('verdict is PASS but problems is non-empty');
  }

  return { ok: problems.length === 0, problems };
}

/** Renders a `ChaosRunRecord` as a short Markdown report (Gate-B table input). */
export function formatChaosRunMarkdown(record: ChaosRunRecord): string {
  const lines: string[] = [];
  lines.push(`# Chaos run: ${record.scenario}`);
  lines.push('');
  lines.push(`- capturedAt: ${record.capturedAtIso}`);
  lines.push(
    `- fleet: ${String(record.fleet.workers)} workers x ${String(record.fleet.sessionsPerWorker)} sessions/worker = ${String(record.fleet.instances)} instances`,
  );
  lines.push(`- verdict: **${record.verdict}**`);
  lines.push('');
  lines.push('| measurement | value | SLO target |');
  lines.push('|---|---|---|');
  for (const [key, value] of Object.entries(record.measurements)) {
    lines.push(`| ${key} | ${String(value)} | ${record.sloTargets[key] ?? '-'} |`);
  }
  if (record.problems.length > 0) {
    lines.push('');
    lines.push('## Problems');
    for (const p of record.problems) lines.push(`- ${p}`);
  }
  if (record.notes.length > 0) {
    lines.push('');
    lines.push('## Notes');
    for (const n of record.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------
// CLI (isMain-guarded) - `--validate`, `--markdown`, `--wave-size`,
// `--flush-target`. No scenario EXECUTION here; the integration tests are
// the executors.
// ---------------------------------------------------------------------

/** Exit codes: `0` success, `1` a validation/usage failure. Exported for a direct unit test of the CLI dispatch without spawning a process. */
export function runChaosCli(argv: string[], readFile: (path: string) => string): number {
  if (argv.includes('--validate')) {
    const path = argv[argv.indexOf('--validate') + 1];
    if (!path) throw new Error('--validate requires a <json> path');
    const record: unknown = JSON.parse(readFile(path));
    const result = validateChaosRunRecord(record);
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }

  if (argv.includes('--wave-size')) {
    const sessionsIdx = argv.indexOf('--sessions');
    const perWorkerIdx = argv.indexOf('--per-worker');
    const fleetSessions = Number(argv[sessionsIdx + 1]);
    const sessionsPerWorker = Number(argv[perWorkerIdx + 1]);
    if (sessionsIdx === -1 || perWorkerIdx === -1) {
      throw new Error('--wave-size requires --sessions <n> --per-worker <n>');
    }
    console.log(String(deployWaveSize({ fleetSessions, sessionsPerWorker })));
    return 0;
  }

  if (argv.includes('--flush-target')) {
    const target = argv[argv.indexOf('--flush-target') + 1];
    if (!target) throw new Error('--flush-target requires a <name>');
    try {
      assertFlushTargetAllowed(target);
      console.log('OK');
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  console.error(
    'run-chaos: no mode given - use --validate <json>, --markdown <json> <out.md>, ' +
      '--wave-size --sessions <n> --per-worker <n>, or --flush-target <name>',
  );
  return 1;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;

if (isMain) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const argv = process.argv.slice(2);
  if (argv.includes('--markdown')) {
    const idx = argv.indexOf('--markdown');
    const path = argv[idx + 1];
    const out = argv[idx + 2];
    if (!path || !out) {
      console.error('--markdown requires a <json> path and an <out.md> path');
      process.exitCode = 1;
    } else {
      const record = JSON.parse(readFileSync(path, 'utf8')) as ChaosRunRecord;
      writeFileSync(out, formatChaosRunMarkdown(record), 'utf8');
      console.log(`markdown written: ${out}`);
      process.exitCode = 0;
    }
  } else {
    process.exitCode = runChaosCli(argv, (path) => readFileSync(path, 'utf8'));
  }
}
