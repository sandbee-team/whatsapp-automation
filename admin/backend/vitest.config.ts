import { defineConfig } from 'vitest/config';
import { withBase } from '../../packages/config/vitest.base.js';

/**
 * `admin-backend`'s own Vitest project config (P28 Unit U4) - mirrors
 * `app/backend/vitest.config.ts`. `src` integration tests hit a real
 * Postgres, so they are excluded from the root unit config (which excludes
 * every `*.integration.test.ts`) and run only via
 * `pnpm -F admin-backend run test:int`, which the ROOT `test:int` script
 * chains after app-backend's suite - so the CI gate's `integration` step
 * covers them.
 *
 * `fileParallelism: false` follows the same precedent: these suites seed and
 * clean real rows, and app-backend's integration suite runs against the same
 * `wp_test2` database, so every assertion here is scoped to this project's
 * own probe ids rather than to fleet-wide counts.
 *
 * `test.env`: `@wp/server-kit`'s `config` singleton parses `process.env`
 * once at first import anywhere in the process, and admin-backend reaches it
 * through `@wp/server-kit/crypto` (the sealed staff TOTP secret) and the
 * shared logger/metrics. `WP_KEK_PURPOSES` includes `user-secrets` because
 * that is the purpose the staff TOTP secret is sealed under. Test-only
 * placeholder values - never real secrets.
 */
export default defineConfig(
  withBase({
    test: {
      include: ['src/**/*.integration.test.ts'],
      environment: 'node',
      fileParallelism: false,
      testTimeout: 30000,
      env: {
        WP_ENV: 'test',
        WP_LOG_LEVEL: 'info',
        WP_KEY_RING_PATH: 'test-key-ring-path-not-a-real-secret',
        WP_KEK_PURPOSES: 'session,user-secrets',
        WP_ENC_VERSION: '1',
      },
    },
  }),
);
