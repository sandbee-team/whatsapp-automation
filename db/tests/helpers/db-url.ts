import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const DEV_ENV_PATH = path.join(REPO_ROOT, '.secrets', 'dev.env');

/**
 * Resolves the `DATABASE_URL` integration tests connect with: a real
 * `DATABASE_URL` env var wins if set, else this parses `.secrets/dev.env`
 * (KEY=VALUE lines) for local dev. Test helpers are allowed to read
 * `process.env`/dotenv files directly - only `db/src/**` (shipped runtime
 * code) may not.
 */
export function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) {
    return fromEnv;
  }

  let raw: string;
  try {
    raw = readFileSync(DEV_ENV_PATH, 'utf8');
  } catch {
    throw new Error(
      `No DATABASE_URL available: set the DATABASE_URL env var, or ensure it exists at ${DEV_ENV_PATH}.`,
    );
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (key === 'DATABASE_URL') {
      return trimmed.slice(eq + 1).trim();
    }
  }

  throw new Error(
    `No DATABASE_URL available: set the DATABASE_URL env var, or add a DATABASE_URL=... line to ${DEV_ENV_PATH}.`,
  );
}
