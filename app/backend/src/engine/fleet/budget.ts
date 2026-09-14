/**
 * engine/fleet/budget.ts (P09 Unit U1) - derives a single worker process's
 * WhatsApp-session capacity from its heap budget, and asserts at boot that
 * the process was actually launched with a `--max-old-space-size` matching
 * the configured `WORKER_HEAP_BUDGET_MB` (a mismatch here means every other
 * derivation in this file is computing a cap the process cannot honor -
 * core invariant 2, fail-safe: refuse to start rather than run with an
 * unverified heap ceiling).
 *
 * `WORKER_PLANNED_SESSION_MB` (default 35) is the PESSIMISTIC per-session
 * footprint bracket - a derived number, not a measurement - and stays the
 * default until P10 replaces it with `measuredSessionMb` from real fleet
 * sampling (`measuredSessionMb ?? plannedSessionMb`, measured always wins
 * when present). The 135/69 cap figures that fall out of the 18MB/35MB
 * brackets are likewise derived, not measured - see `budget.test.ts` and
 * ADR 0018 S8 (never surface these numbers in panel/customer-facing text).
 */

export interface WorkerBudgetConfig {
  heapBudgetMb: number;
  processBaselineMb: number;
  plannedSessionMb: number;
  measuredSessionMb: number | undefined;
  safetyFactor: number;
}

const SESSION_CAP_FLOOR = 10;
const SESSION_CAP_CEILING = 250;

/**
 * `usable = heapBudgetMb - processBaselineMb`; `perSession = measuredSessionMb
 * ?? plannedSessionMb` (measured wins); `floor((usable / perSession) *
 * safetyFactor)`, clamped to `[10, 250]`. The 250 ceiling applies AFTER the
 * floor/safety-factor multiplication (ADR 0018 S3: a single Node process
 * above 250 sessions concentrates too much blast radius, independent of how
 * much heap headroom the math would otherwise allow).
 */
export function deriveSessionCap(cfg: WorkerBudgetConfig): number {
  const usable = cfg.heapBudgetMb - cfg.processBaselineMb;
  const perSession = cfg.measuredSessionMb ?? cfg.plannedSessionMb;
  const raw = Math.floor((usable / perSession) * cfg.safetyFactor);
  return Math.min(SESSION_CAP_CEILING, Math.max(SESSION_CAP_FLOOR, raw));
}

/** `deriveSessionCap`'s result form, plus whether the cap rests on the derived `plannedSessionMb` bracket rather than a real measurement. */
export interface SessionCapResult {
  cap: number;
  /** `true` when `measuredSessionMb` was absent and `plannedSessionMb` (a derived bracket, not a measurement) was used instead - callers surface this on their cap gauge/log (P10 step 7/9). */
  provisional: boolean;
}

/**
 * `deriveSessionCap` plus a `provisional` tag: `provisional = true` exactly
 * when `cfg.measuredSessionMb === undefined` (planned-only fallback), `false`
 * when a real measured figure was used - even if that measured figure is
 * clamped to the floor/ceiling. Added alongside (never replacing)
 * `deriveSessionCap` so P09's existing bare-`number` callers/tests keep
 * working unchanged; new callers that need to know "is this cap backed by a
 * real measurement" should call this instead.
 */
export function deriveSessionCapResult(cfg: WorkerBudgetConfig): SessionCapResult {
  return {
    cap: deriveSessionCap(cfg),
    provisional: cfg.measuredSessionMb === undefined,
  };
}

/**
 * Thrown by `assertHeapBudgetMatchesNodeFlags` when the process's actual
 * `--max-old-space-size` (read from `execArgv` or `NODE_OPTIONS`) disagrees
 * with `WORKER_HEAP_BUDGET_MB`, or is absent entirely - the process refuses
 * to start rather than derive a session cap the runtime cannot back.
 */
export class HeapBudgetMismatchError extends Error {
  code = 'HEAP_BUDGET_MISMATCH';

  constructor(message: string) {
    super(message);
    this.name = 'HeapBudgetMismatchError';
  }
}

const MAX_OLD_SPACE_SIZE_RE = /--max-old-space-size=(\d+)/;

function findMaxOldSpaceSizeMb(execArgv: readonly string[]): number | undefined {
  for (const arg of execArgv) {
    const match = MAX_OLD_SPACE_SIZE_RE.exec(arg);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

/**
 * Boot assertion: the running process's actual `--max-old-space-size` must
 * equal `cfg.heapBudgetMb`. Checks `execArgv` first (a flag passed directly
 * to `node`), falling back to parsing `NODE_OPTIONS` (a flag set via env)
 * when `execArgv` carries none. Throws `HeapBudgetMismatchError` (named, so
 * callers can distinguish this from any other boot failure) when the flag
 * is missing from both, or present but numerically different from
 * `cfg.heapBudgetMb`.
 *
 * Takes `execArgv`/`nodeOptionsEnv` as explicit parameters (rather than
 * reading `process.execArgv`/`process.env.NODE_OPTIONS` itself) so tests can
 * drive every branch without a real child process launched with real flags.
 */
export function assertHeapBudgetMatchesNodeFlags(
  cfg: Pick<WorkerBudgetConfig, 'heapBudgetMb'>,
  execArgv: readonly string[],
  nodeOptionsEnv: string | undefined,
): void {
  const fromExecArgv = findMaxOldSpaceSizeMb(execArgv);
  const fromNodeOptions =
    fromExecArgv === undefined && nodeOptionsEnv !== undefined
      ? findMaxOldSpaceSizeMb(nodeOptionsEnv.split(/\s+/))
      : undefined;

  const actualMb = fromExecArgv ?? fromNodeOptions;

  if (actualMb === undefined) {
    throw new HeapBudgetMismatchError(
      `--max-old-space-size is not set in execArgv or NODE_OPTIONS, but WORKER_HEAP_BUDGET_MB=` +
        `${cfg.heapBudgetMb} requires it to be set and equal - refusing to start with an ` +
        `unverified heap ceiling`,
    );
  }

  if (actualMb !== cfg.heapBudgetMb) {
    throw new HeapBudgetMismatchError(
      `--max-old-space-size=${actualMb} disagrees with WORKER_HEAP_BUDGET_MB=${cfg.heapBudgetMb} - ` +
        `refusing to start with a heap ceiling that does not match the configured budget`,
    );
  }
}
