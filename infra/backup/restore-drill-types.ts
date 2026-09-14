/**
 * restore-drill-types.ts (P29a Unit U3, step 9) - shared type-only contracts
 * between `restore-drill.ts` and `restore-drill-basebackup.ts`. Split into
 * its own file (rather than either importing types from the other) so
 * neither module has a runtime import cycle on the other - both import
 * FROM here, neither imports from its sibling.
 */

export interface RunProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable process runner - the ONLY place the restore-drill modules spawn anything. */
export type RunProcess = (
  command: string,
  argv: string[],
  opts?: {
    stdinFromFile?: string;
    /** Extra env vars merged onto the child's environment (e.g. `RESTORE_DRILL_SOURCE_URL`/`RESTORE_DRILL_TARGET_URL` - see `run-restore-verify.ts`'s argv parser) - never put a DSN in `argv`, it is visible in process listings. */
    env?: Record<string, string>;
  },
) => Promise<RunProcessResult>;

export interface RestoreDrillCliArgs {
  mode: 'basebackup' | 'pgbackrest';
  scratchPort: number;
  keep: boolean;
  productionHost?: string;
  /** Explicit opt-in required for a non-loopback SOURCE host (see `assertSourceIsSafe` in `restore-drill-lib.ts`); a production-pattern-matching source is refused regardless. */
  allowRemoteSource: boolean;
  pgBin: string;
  outPath: string;
  markdownPath: string;
}

export interface RestoreDrillEnv {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface RestoreDrillDeps {
  runProcess: RunProcess;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  now: () => string;
  /** Injectable file-size reader (defaults to a real `statSync` in `main()`) - tests inject a fake so no test ever depends on a real file on disk. */
  readFileSize: (path: string) => number;
}

export interface RestoreDrillRunResult {
  verdict: 'PASS' | 'FAIL';
  mode: 'basebackup' | 'pgbackrest';
  rtoMs: number;
  rpoSeconds: number;
  reportPath: string;
  exitCode: number;
}
