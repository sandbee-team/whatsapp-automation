import { defineConfig } from 'vitest/config';
import { baseConfig } from '../packages/config/vitest.base.js';

/**
 * vitest.perf.config.ts (P29 step 6, Unit U5; fixed U5b) - the LCP
 * performance gate. Run via `pnpm -F website run test:perf`, which is the
 * CI step `website-lcp` (scripts/ci-steps.ts), invoked right after
 * `website-build`. Deliberately excluded from the root unit run
 * (`vitest.config.ts`'s `exclude: ['website/tests/perf/**']`): this suite
 * builds the static export, serves it, and drives real Chrome via
 * Lighthouse - it is a slow, out-of-process runner, never part of
 * `pnpm run test:unit`.
 *
 * U5b fix: this used to spread through `withBase`, whose `mergeConfig`
 * CONCATENATES array fields - so `include` ended up as the base's
 * `['src/**\/*.test.ts', 'tests/**\/*.test.ts']` PLUS this file's
 * `['tests/perf/**\/*.test.ts']`, silently re-running all 7 website unit
 * test files on every `test:perf` invocation. Building `test` directly from
 * `baseConfig.test` and overriding `include` (not merging it) keeps only
 * `setupFiles` inherited; the run must show exactly 1 test file.
 */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['tests/perf/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
