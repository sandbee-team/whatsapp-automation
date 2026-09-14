import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * playwright.config.ts (P29 U4b) - the marketing site's lead-form e2e.
 * Run `pnpm -F website run build` FIRST: the export under `website/out` is
 * served AS-IS by `tests/e2e/serve-out.mjs` (no dev server, no rebuild on
 * change) - this config never invokes Next's own build. `NEXT_PUBLIC_
 * LEADS_ENDPOINT` defaults to the admin dev port when unset, so a plain
 * `pnpm -F website run build && pnpm -F website exec playwright test`
 * works with no env setup beyond `.secrets/dev.env` already existing.
 *
 * Plain Node config (no zod, no `@wp/*` imports) - `.secrets/dev.env` is
 * parsed by hand, mirroring `app/frontend/playwright.config.ts` exactly,
 * so admin-backend's real process gets every `WP_*`/`DATABASE_URL` key it
 * needs without depending on production config defaults for a test run.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEV_ENV_PATH = path.join(REPO_ROOT, '.secrets', 'dev.env');

function parseDevEnv(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const devEnv = parseDevEnv(DEV_ENV_PATH);
const testDatabaseUrl = (devEnv.DATABASE_URL ?? '').replace(/\/wp$/, '/wp_test2');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3002',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm -F admin-backend exec tsx src/index.ts',
      url: 'http://127.0.0.1:3001/admin/v1/health/ping',
      cwd: REPO_ROOT,
      reuseExistingServer: true,
      timeout: 60_000,
      env: {
        ...process.env,
        ...devEnv,
        DATABASE_URL: testDatabaseUrl,
        ADMIN_IP_ALLOWED_CIDRS: '127.0.0.1/32',
        LEADS_ALLOWED_ORIGINS: 'http://127.0.0.1:3002',
      },
    },
    {
      command: 'node tests/e2e/serve-out.mjs 3002 out',
      url: 'http://127.0.0.1:3002/',
      cwd: HERE,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
