/**
 * scripts/measure/child-exec-argv.ts (P26, main-session fix after run #4) -
 * decides which Node exec flags a scale-fleet CHILD process is spawned with.
 *
 * WHY THIS EXISTS: `scale-fleet.ts` used to spawn children with a hardcoded
 * `['--import', 'tsx']`. On the Windows host that resolves the workspace
 * `tsx` and works. Inside the Linux measurement container the SAME
 * resolution reaches the host's pnpm store, whose `esbuild` binary is
 * win32-only, so every child crashed before it could send `ready` - the
 * parent then reported only a bare IPC timeout (run #4 of the P26 log).
 * The parent itself runs fine there because it is started with an explicit
 * Linux loader (`--import /lt/node_modules/tsx/dist/loader.mjs`).
 *
 * Rule: a child must load TypeScript THE SAME WAY ITS PARENT DID. So the
 * child exec argv is, in priority order:
 *   1. `WP_SCALE_CHILD_EXEC_ARGV` (JSON array) when set - an explicit
 *      operator override, never guessed;
 *   2. the parent's own loader-class flags (`--import`, `--loader`,
 *      `--require`, `--experimental-loader`, in order, with their values)
 *      when the parent has any - so an in-container parent's Linux loader is
 *      inherited verbatim;
 *   3. the historical default `['--import', 'tsx']` otherwise.
 * Heap-size and other non-loader flags are deliberately NOT inherited - ten
 * children must not each copy the parent's `--max-old-space-size`.
 *
 * Pure: no I/O, no process access - both inputs are injected so the rule is
 * unit-testable.
 */

const LOADER_FLAGS = new Set(['--import', '--loader', '--require', '--experimental-loader']);

export const DEFAULT_CHILD_EXEC_ARGV: readonly string[] = Object.freeze(['--import', 'tsx']);

export class InvalidChildExecArgvOverrideError extends Error {
  constructor(reason: string) {
    super(`WP_SCALE_CHILD_EXEC_ARGV must be a JSON array of strings - ${reason}`);
    this.name = 'InvalidChildExecArgvOverrideError';
  }
}

/** Extracts `--flag value` / `--flag=value` pairs for the loader-class flags only, in order. */
export function loaderFlagsOf(parentExecArgv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < parentExecArgv.length; i += 1) {
    const arg = parentExecArgv[i] as string;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!LOADER_FLAGS.has(flag)) continue;
    if (eq !== -1) {
      out.push(arg);
      continue;
    }
    const value = parentExecArgv[i + 1];
    if (value === undefined || value.startsWith('--')) continue;
    out.push(flag, value);
    i += 1;
  }
  return out;
}

export function childExecArgv(input: {
  parentExecArgv: readonly string[];
  override?: string | undefined;
}): string[] {
  if (input.override !== undefined && input.override !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.override);
    } catch {
      throw new InvalidChildExecArgvOverrideError('not valid JSON');
    }
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
      throw new InvalidChildExecArgvOverrideError('not an array of strings');
    }
    return [...(parsed as string[])];
  }
  const inherited = tsCapableLoaderFlagsOf(input.parentExecArgv);
  return inherited.length > 0 ? inherited : [...DEFAULT_CHILD_EXEC_ARGV];
}

/**
 * Only a loader that can actually execute TypeScript is worth inheriting.
 * vitest runs its workers with `--require .../vitest/suppress-warnings.cjs`
 * (a plain CJS preload, no TS support); inheriting THAT as "the parent's
 * loader" would spawn children with no TS loader at all, and every child
 * would crash on its `.ts` entry (found by U6c: `fleet.start()` 6.4 s
 * standalone vs a bare 60 s timeout under vitest). Keep `--import`/
 * `--loader`/`--require` pairs whose value names a TS loader (`tsx`,
 * `ts-node`, `tsimp`, `esbuild-register`, `swc-node`) and drop the rest.
 */
export function tsCapableLoaderFlagsOf(parentExecArgv: readonly string[]): string[] {
  const pairs = loaderFlagsOf(parentExecArgv);
  const out: string[] = [];
  for (let i = 0; i < pairs.length; i += 1) {
    const arg = pairs[i] as string;
    const eq = arg.indexOf('=');
    const value = eq === -1 ? pairs[i + 1] : arg.slice(eq + 1);
    const tsCapable = value !== undefined && TS_LOADER_PATTERN.test(value);
    if (eq === -1) {
      if (tsCapable && value !== undefined) out.push(arg, value);
      i += 1;
    } else if (tsCapable) {
      out.push(arg);
    }
  }
  return out;
}

const TS_LOADER_PATTERN = /tsx|ts-node|tsimp|esbuild-register|swc-node/;
