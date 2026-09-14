import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';

type MergeableConfig = Parameters<typeof mergeConfig>[0];

/**
 * Absolute path so every project inherits the same setup file regardless of its
 * own `root` (the root project, app/backend and db/ all merge this base from
 * different working directories).
 */
const ENV_SETUP_FILE = fileURLToPath(new URL('./vitest-setup-env.ts', import.meta.url));

/**
 * Shared Vitest base config. Individual packages merge their own overrides
 * on top via `mergeConfig(base, { ... })`.
 *
 * `setupFiles` runs BEFORE any test module is imported, which is what makes the
 * `@wp/server-kit` `WP_*` config-singleton class of failure structurally
 * impossible instead of a per-file import-order convention - see
 * `vitest-setup-env.ts`'s header for the P10 incident. A project that overrides
 * `setupFiles` must re-include this path.
 */
export const baseConfig: MergeableConfig = {
  /**
   * `wp-source` is load-bearing (2026-09-14, production-image work).
   *
   * Every workspace package (`@wp/db`, `@wp/domain`, `@wp/contracts`,
   * `@wp/utils`, `@wp/server-kit`) declares a conditional `exports` map whose
   * `default` is the COMPILED `./dist/*.js` - that is what makes a production
   * Docker image able to run plain `node dist/main.js` without `tsx`, since
   * Node would otherwise resolve a workspace import to a `.ts` file and throw
   * `Unknown file extension ".ts"`.
   *
   * Without this condition, Vitest (which honours `exports`) would resolve
   * those same imports to `dist/` too - so the whole suite would silently test
   * STALE COMPILED OUTPUT instead of the source being edited, and a source-only
   * bug would pass. `wp-source` makes tests resolve to `./src/*.ts` instead.
   * `tsc` itself is unaffected: it uses `references`/`types`, not conditions.
   *
   * BOTH blocks below are required, and `ssr.resolve.externalConditions` is
   * the one that actually does the work here - it was verified empirically:
   * with `resolve.conditions` alone, a marker added to `packages/utils/src`
   * and deliberately NOT to its `dist` was invisible to a test importing
   * `@wp/utils`, proving the test had loaded compiled output. Vitest runs
   * tests through its SSR pipeline, and a workspace package resolved as an
   * EXTERNAL dependency there is resolved by `externalConditions`, not by
   * the plain `resolve.conditions` list. Removing either block silently
   * reverts the whole suite to testing `dist/`.
   */
  resolve: {
    conditions: ['wp-source'],
  },
  ssr: {
    resolve: {
      conditions: ['wp-source'],
      externalConditions: ['wp-source'],
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: [ENV_SETUP_FILE],
  },
};

export function withBase(overrides: MergeableConfig): MergeableConfig {
  return mergeConfig(baseConfig, overrides);
}

export default defineConfig(baseConfig);
