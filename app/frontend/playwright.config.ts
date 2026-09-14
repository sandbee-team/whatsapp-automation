import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * playwright.config.ts (P04b UB3) - the signup/onboarding acceptance e2e.
 * Chromium only. `webServer` boots BOTH the real api role (ROLE=api) and the
 * Vite dev server, since the SPA's refresh cookie is `SameSite=Strict` +
 * `Secure` (see api-client.ts / vite.config.ts) - every request has to ride
 * the same origin the browser navigates to (http://localhost:5173), never a
 * direct hit to the api's own port.
 *
 * Playwright config runs in plain Node (no zod, no @wp/* imports) - `.secrets
 * /dev.env` is parsed by hand here, mirroring `platform/db/db-url.ts` and
 * `platform/redis.ts`'s own dev-env fallback parsing exactly, so the api
 * process gets DATABASE_URL/REDIS_URL without depending on those files'
 * production entrypoints (`loadConfig`) supplying dev defaults for every
 * other key - see `platform/config.ts`, which already defaults everything
 * else (PUBLIC_BASE_URL, MAIL_HOST/PORT, AUTH_JWT_SECRET, KEY_RING_PATH, ...)
 * when NODE_ENV !== 'production'.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DEV_ENV_PATH = path.join(REPO_ROOT, '.secrets', 'dev.env');

function parseDevEnv(filePath: string): Record<string, string> {
  const raw = readFileSync(filePath, 'utf8');
  const out: Record<string, string> = {};
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
const databaseUrl =
  devEnv.DATABASE_URL ??
  `postgres://${devEnv.POSTGRES_USER}:${devEnv.POSTGRES_PASSWORD}@127.0.0.1:${devEnv.POSTGRES_PORT}/${devEnv.POSTGRES_DB}`;
const redisUrl = `redis://127.0.0.1:${devEnv.REDIS_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
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
      command: 'pnpm -F app-backend exec tsx src/main.ts',
      url: 'http://127.0.0.1:3000/v1/health/ping',
      cwd: REPO_ROOT,
      reuseExistingServer: true,
      timeout: 60_000,
      env: {
        ...process.env,
        ROLE: 'api',
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
      },
    },
    {
      command: 'pnpm -F app-frontend run dev',
      url: 'http://localhost:5173',
      cwd: REPO_ROOT,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
