import { defineConfig } from 'vitest/config';
import { withBase } from './packages/config/vitest.base.js';

/**
 * Root Vitest config - the single `test:unit` entrypoint for the whole
 * workspace. Picks up `scripts/**` guard tests plus every workspace's
 * `src|tests` test globs, built on `packages/config/vitest.base.ts`.
 */
export default defineConfig(
  withBase({
    test: {
      include: [
        'scripts/**/*.test.ts',
        'packages/*/src/**/*.test.ts',
        'packages/*/src/**/*.test.tsx',
        'packages/*/tests/**/*.test.ts',
        'packages/*/test/**/*.test.ts',
        'packages/*/test/**/*.test.tsx',
        'app/*/src/**/*.test.ts',
        'app/*/src/**/*.test.tsx',
        'app/*/tests/**/*.test.ts',
        'admin/*/src/**/*.test.ts',
        'admin/*/src/**/*.test.tsx',
        'admin/*/tests/**/*.test.ts',
        'website/src/**/*.test.ts',
        'website/tests/**/*.test.ts',
        'db/src/**/*.test.ts',
        'infra/**/__tests__/*.test.ts',
        'docs/__tests__/*.test.ts',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
        'scripts/guards/__fixtures__/**',
        'demo/**',
        '.memory/**',
        // *.integration.test.ts files hit a real Postgres (see e.g.
        // app/backend/vitest.config.ts, db/vitest.config.ts) - never part of
        // the root unit run; run via each package's own test:int script.
        '**/*.integration.test.ts',
        // website/tests/perf (built + Lighthouse, run by the website-lcp CI
        // step) and website/tests/e2e (Playwright specs) are their own
        // out-of-process runners, never part of the root unit run.
        'website/tests/perf/**',
        'website/tests/e2e/**',
      ],
    },
  }),
);
