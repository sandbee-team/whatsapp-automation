import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/load-dev-env.ts (added 2026-09-08) - loads `.secrets/dev.env` into
 * `process.env` for LOCAL DEVELOPMENT ONLY, before any application module is
 * imported.
 *
 * WHY A SEPARATE PRELOAD MODULE, not a call at the top of `src/index.ts`:
 * `@wp/server-kit`'s `config` singleton parses `process.env` at IMPORT time
 * (see packages/server-kit/src/config/index.ts - the `parse()` call runs
 * during module evaluation, not on first use). ES module imports are hoisted
 * and evaluated before any statement in the importing module's body, so a
 * `loadDevEnv()` call placed inside `src/index.ts` would run AFTER
 * `@wp/db`/`@wp/server-kit` had already thrown
 * `ConfigError: Invalid or missing config env var(s): WP_ENV, ...`. Hence
 * `tsx --import` (this file) rather than an in-app call.
 *
 * Mirrors `app/backend/scripts/dev-role.ts`'s own `loadDevEnv()`, including
 * the two behaviours that file learned the hard way:
 *  - an EXISTING `process.env` value always wins, so
 *    `DATABASE_URL=... pnpm run dev` (and CI) still override the file;
 *  - a relative `WP_KEY_RING_PATH` is resolved against the REPO ROOT, not the
 *    current working directory - otherwise running from `admin/backend/`
 *    resolves the fixture ring path against the wrong base and
 *    `FileKeyProvider` fails with `CRYPTO_KEY_RING_INVALID`.
 *
 * Never imported by production code or by tests: `admin/backend`'s own
 * `vitest.config.ts` sets the `WP_*` vars it needs explicitly.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const ENV_FILE_PATH = resolve(REPO_ROOT, '.secrets', 'dev.env');

/** Parses `KEY=value` lines, skipping blanks and `#` comments, stripping one layer of matching quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

function loadDevEnv(): void {
  if (!existsSync(ENV_FILE_PATH)) {
    console.error(
      `admin dev: ${ENV_FILE_PATH} not found - create it first (docs/RUNNING-LOCALLY.md).`,
    );
    process.exit(1);
  }
  const parsed = parseEnvFile(readFileSync(ENV_FILE_PATH, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const ring = process.env.WP_KEY_RING_PATH;
  if (ring !== undefined && ring !== '' && !isAbsolute(ring)) {
    process.env.WP_KEY_RING_PATH = resolve(REPO_ROOT, ring.replaceAll('\\', '/'));
  }
}

loadDevEnv();
