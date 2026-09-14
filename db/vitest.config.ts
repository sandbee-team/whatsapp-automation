import { defineConfig } from 'vitest/config';
import { withBase } from '../packages/config/vitest.base.js';

/**
 * `@wp/db`'s own Vitest project config - `db/tests/**` are integration
 * tests that hit a real Postgres (see `db/tests/helpers/db-url.ts`), so they
 * are excluded from the root unit config and run only via `pnpm -F @wp/db
 * run test` (root `test:int`). `fileParallelism: false` keeps runner tests
 * from racing each other's advisory-lock/scratch-DB lifecycle across files;
 * the 30s timeout gives real Postgres round-trips headroom.
 */
export default defineConfig(
  withBase({
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
      fileParallelism: false,
      testTimeout: 30000,
    },
  }),
);
