import { defineConfig } from 'vitest/config';
import { withBase } from '../config/vitest.base.js';

/**
 * @wp/server-kit's own Vitest project config. The base include list
 * (`src/**` + `tests/**`) misses this package's singular `test/**` fixture
 * tree (`packages/server-kit/test/auth-state-round-trip.test.ts` and its
 * `test/fixtures/`, added in a later P01 step) - mirrored here and in the
 * root `vitest.config.ts` include list so both the package-local run and the
 * root `vitest run` (the CI unit step) pick those tests up.
 */
export default defineConfig(
  withBase({
    test: {
      include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'test/**/*.test.ts'],
    },
  }),
);
