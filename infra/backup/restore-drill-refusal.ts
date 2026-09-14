/**
 * restore-drill-refusal.ts (P29a C1 fix round, finding 6) - the drill's
 * production/loopback refusal predicates, split out of `restore-drill-lib.ts`
 * purely for the repo's `max-lines` cap (same code-motion-split idiom as
 * `session-worker-discovery-wiring.ts`) - no new module boundary, just a
 * sibling file re-exported from `restore-drill-lib.ts` so every existing
 * import path keeps working unchanged.
 */

export class RestoreDrillRefusedError extends Error {
  constructor(reason: string) {
    super(`restore drill refused: ${reason}`);
    this.name = 'RestoreDrillRefusedError';
  }
}

export interface DrillTarget {
  host: string;
  port: number;
  database: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** Default production-host patterns - matched against the target host AND any `--production-host` value. */
export const DEFAULT_PRODUCTION_HOST_PATTERNS: RegExp[] = [/prod/i, /\.wp\./, /^db\./];

function matchesAnyPattern(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

/**
 * Refuses (throws `RestoreDrillRefusedError`) BEFORE any process is spawned
 * when the target is unsafe. Never names the password in the thrown message
 * - only host/port/database, which are not secrets. Checks, in order:
 *   1. target host is not loopback,
 *   2. target host:port equals source host:port,
 *   3. target database equals source database ON THE SAME SERVER (host AND
 *      port) - deliberately NOT a bare database-NAME match: a real
 *      `pg_basebackup` restore reuses the source's own database name on a
 *      DIFFERENT scratch port (see `restore-drill.ts`'s own header), so
 *      "same name" alone would refuse every legitimate basebackup run,
 *      making clause 2 above the operative guard for that case and this
 *      clause pure defense-in-depth/documentation of intent,
 *   4. target host matches a production-host pattern,
 *   5. an explicitly-provided `--production-host` value matches a pattern
 *      (guards a target whose bare hostname looks safe but was flagged by
 *      an operator-supplied hint, e.g. a CNAME check done out of band).
 */
export function assertNotProductionTarget(
  target: DrillTarget,
  source: DrillTarget,
  productionHostPatterns: readonly RegExp[] = DEFAULT_PRODUCTION_HOST_PATTERNS,
  explicitProductionHost?: string,
): void {
  if (!LOOPBACK_HOSTS.has(target.host)) {
    throw new RestoreDrillRefusedError(
      `target host "${target.host}" is not loopback (127.0.0.1 / ::1 / localhost)`,
    );
  }
  if (target.host === source.host && target.port === source.port) {
    throw new RestoreDrillRefusedError(
      `target host:port (${target.host}:${String(target.port)}) equals the source host:port`,
    );
  }
  if (
    target.database === source.database &&
    target.host === source.host &&
    target.port === source.port
  ) {
    throw new RestoreDrillRefusedError(
      `target database "${target.database}" equals the source database on the same server`,
    );
  }
  if (matchesAnyPattern(target.host, productionHostPatterns)) {
    throw new RestoreDrillRefusedError(
      `target host "${target.host}" matches a production-host pattern`,
    );
  }
  if (
    explicitProductionHost !== undefined &&
    matchesAnyPattern(explicitProductionHost, productionHostPatterns)
  ) {
    throw new RestoreDrillRefusedError(
      `--production-host "${explicitProductionHost}" matches a production-host pattern`,
    );
  }
}

/**
 * Refuses (throws `RestoreDrillRefusedError`) BEFORE any process is spawned
 * when the SOURCE the drill would `pg_basebackup` FROM is unsafe.
 * `assertNotProductionTarget` above only ever checks the target (always
 * hardcoded loopback in `restore-drill.ts`, so it can never fail on its own)
 * - this is the source-side counterpart: a `POSTGRES_HOST` pointed at a
 * production-looking host must refuse a real `pg_basebackup` run against it,
 * same as a production-looking TARGET would. `allowRemoteSource` is the
 * explicit `--allow-remote-source` opt-in (CLI-parsed in `restore-drill.ts`)
 * for the one legitimate case (a real non-loopback dev/staging Postgres) -
 * even with it set, a PATTERN-matching production host is still refused.
 */
export function assertSourceIsSafe(
  source: DrillTarget,
  allowRemoteSource: boolean,
  productionHostPatterns: readonly RegExp[] = DEFAULT_PRODUCTION_HOST_PATTERNS,
  explicitProductionHost?: string,
): void {
  if (matchesAnyPattern(source.host, productionHostPatterns)) {
    throw new RestoreDrillRefusedError(
      `source host "${source.host}" matches a production-host pattern`,
    );
  }
  if (
    explicitProductionHost !== undefined &&
    matchesAnyPattern(explicitProductionHost, productionHostPatterns)
  ) {
    throw new RestoreDrillRefusedError(
      `--production-host "${explicitProductionHost}" matches a production-host pattern`,
    );
  }
  if (!LOOPBACK_HOSTS.has(source.host) && !allowRemoteSource) {
    throw new RestoreDrillRefusedError(
      `source host "${source.host}" is not loopback and --allow-remote-source was not passed`,
    );
  }
}
