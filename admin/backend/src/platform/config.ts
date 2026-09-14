import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

/**
 * platform/config.ts (P28 Unit U4, step 6) - the ONLY file in admin-backend
 * that reads `process.env` (ADR 0014 fact 5, same rule as app-backend's own
 * `platform/config.ts`, whose shape this mirrors). Zod-parsed, fail-closed
 * (a bad value throws at load time - never a silent fallback), frozen, and
 * it NEVER echoes a value in an error message: several of these are secrets
 * (`ADMIN_JWT_SECRET`, `INTERNAL_API_SERVICE_TOKEN_SECRET`), so the error
 * names the offending KEYS only - the same discipline as
 * `@wp/server-kit/config`'s own `ConfigError`.
 *
 * `loadAdminConfig(env)` is exported separately from the `adminConfig`
 * singleton so tests can build an isolated config from an arbitrary env
 * object without touching real `process.env`.
 */

/** Names the offending env var keys only - never a value (see module header). */
export class ConfigError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(`Invalid or missing admin config env var(s): ${keys.join(', ')}`);
    this.name = 'ConfigError';
    this.keys = keys;
  }
}

/**
 * The staff access token's HARD ceiling. A staff token grants cross-tenant
 * read access to every workspace on the platform, so its lifetime is capped
 * in code, not merely defaulted: a deployment cannot widen the blast radius
 * of a stolen token by setting a larger TTL (`ADMIN_ACCESS_TOKEN_TTL_SECONDS`
 * above this value is a config ERROR, not a clamp - a silent clamp would
 * make the deployment believe it got what it asked for).
 */
export const ADMIN_ACCESS_TOKEN_TTL_CEILING_SECONDS = 120;

const adminConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  /** Loopback by default - the admin API is never exposed to the public internet by accident. */
  ADMIN_HOST: z.string().min(1).default('127.0.0.1'),

  /**
   * The admin pool's connection string. Falls back to `DATABASE_URL` (see
   * `loadAdminConfig`) so a single-database dev box needs one variable.
   * Connects as the POOL user; every transaction enters `wp_admin_app` via
   * `SET LOCAL ROLE` inside `platform/platform-read.ts` - the pool user is
   * never itself `wp_admin_app` (that role is NOLOGIN).
   */
  ADMIN_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),

  ADMIN_JWT_SECRET: z.string().min(32).optional(),

  ADMIN_ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(ADMIN_ACCESS_TOKEN_TTL_CEILING_SECONDS)
    .default(ADMIN_ACCESS_TOKEN_TTL_CEILING_SECONDS),
  /** 8 hours - one staff shift; the refresh cookie is rotated on every use. */
  ADMIN_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(8 * 60 * 60),

  /**
   * Comma-separated IPv4 CIDR allow-list for `POST /admin/v1/auth/login`.
   * DEFAULT EMPTY, and an empty list means NOBODY can log in (fail-closed:
   * `@wp/server-kit/auth`'s `isIpAllowed` never implies allow-all). A
   * deployment that has not decided its office/VPN ranges yet gets a locked
   * admin panel, not an open one.
   */
  ADMIN_IP_ALLOWED_CIDRS: z.string().default(''),

  /** Same `false`-by-default rationale as app-backend's `TRUST_PROXY`: a hard-coded `true` lets any caller spoof `req.ip` via X-Forwarded-For and walk straight past the allow-list above. */
  ADMIN_TRUST_PROXY: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),

  INTERNAL_API_BASE_URL: z.string().min(1).default('http://127.0.0.1:3000'),
  INTERNAL_API_SERVICE_TOKEN_SECRET: z.string().min(32).optional(),

  /**
   * Exact origins (comma-separated) allowed to POST the public lead-form
   * route - the marketing site's own origin(s) only, never a wildcard.
   * No static default: production must set this explicitly (see
   * `requireInProduction` below) - the dev-only default is the local site
   * dev ports (`website`'s dev server and its static-export serve script
   * both use 3002).
   */
  LEADS_ALLOWED_ORIGINS: z.string().min(1).optional(),
  /**
   * Keys the HMAC that replaces a lead submitter's raw IP with an
   * irreversible hash before storage (see `modules/leads/bot-guard.ts#
   * hashIp`). A DEDICATED secret, never `ADMIN_JWT_SECRET` - a compromise
   * of one must never unmask the other's protected values.
   */
  LEADS_IP_HASH_SECRET: z.string().min(32).optional(),

  /** Base URL of the TENANT panel - the impersonation entry link is built against this, never against the admin panel's own origin. */
  APP_PANEL_BASE_URL: z.string().min(1).default('http://localhost:5173'),

  /**
   * `@wp/server-kit`'s own env keys, re-declared here because admin-backend
   * opens the sealed staff TOTP secret via `@wp/server-kit/crypto` (purpose
   * `user-secrets`). That package parses `process.env` itself at first
   * import; these entries exist so a MISSING key fails in THIS loader, with
   * this loader's key-only error, rather than deep inside an unrelated
   * import chain.
   */
  WP_KEY_RING_PATH: z.string().min(1).optional(),
  WP_ENC_VERSION: z.coerce.number().int().min(1).default(1),
});

export type AdminConfig = Readonly<
  z.infer<typeof adminConfigSchema> & {
    ADMIN_JWT_SECRET: string;
    ADMIN_DATABASE_URL: string;
    INTERNAL_API_SERVICE_TOKEN_SECRET: string;
    WP_KEY_RING_PATH: string;
    LEADS_IP_HASH_SECRET: string;
    LEADS_ALLOWED_ORIGINS: string;
  }
>;

/**
 * Dev/test-only fallbacks. NEVER used when `NODE_ENV === 'production'` (see
 * `loadAdminConfig`) - same fail-closed fork as app-backend's
 * `DEV_AUTH_JWT_SECRET_DEFAULT`/`DEV_KEY_RING_PATH_DEFAULT`, which cannot be
 * expressed as a static zod default.
 */
const DEV_ADMIN_JWT_SECRET_DEFAULT = 'dev-only-admin-jwt-secret-not-a-real-secret-32+';
const DEV_INTERNAL_SERVICE_TOKEN_DEFAULT = 'dev-only-internal-service-token-not-a-real-secret';
const DEV_LEADS_IP_HASH_SECRET_DEFAULT = 'dev-only-leads-ip-hash-secret-not-a-real-secret-32+';
const DEV_LEADS_ALLOWED_ORIGINS_DEFAULT = 'http://localhost:3002,http://127.0.0.1:3002';
const DEV_KEY_RING_PATH_DEFAULT = path.join(
  REPO_ROOT,
  'packages',
  'server-kit',
  'test',
  'fixtures',
  'key-ring.dev.json',
);

function requireInProduction(
  isProduction: boolean,
  key: string,
  provided: string | undefined,
  devDefault: string,
  missing: string[],
): string {
  if (provided) return provided;
  if (isProduction) {
    missing.push(key);
    return '';
  }
  return devDefault;
}

/** Parses `env` into a frozen `AdminConfig`; throws `ConfigError` (keys only) on any invalid/missing value. */
export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const parsedResult = adminConfigSchema.safeParse(env);
  if (!parsedResult.success) {
    const keys = [...new Set(parsedResult.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigError(keys);
  }
  const parsed = parsedResult.data;
  const isProduction = parsed.NODE_ENV === 'production';
  const missing: string[] = [];

  const databaseUrl = parsed.ADMIN_DATABASE_URL ?? parsed.DATABASE_URL;
  if (!databaseUrl) {
    missing.push('ADMIN_DATABASE_URL');
  }

  const jwtSecret = requireInProduction(
    isProduction,
    'ADMIN_JWT_SECRET',
    parsed.ADMIN_JWT_SECRET,
    DEV_ADMIN_JWT_SECRET_DEFAULT,
    missing,
  );
  const serviceTokenSecret = requireInProduction(
    isProduction,
    'INTERNAL_API_SERVICE_TOKEN_SECRET',
    parsed.INTERNAL_API_SERVICE_TOKEN_SECRET,
    DEV_INTERNAL_SERVICE_TOKEN_DEFAULT,
    missing,
  );
  const keyRingPath = requireInProduction(
    isProduction,
    'WP_KEY_RING_PATH',
    parsed.WP_KEY_RING_PATH,
    DEV_KEY_RING_PATH_DEFAULT,
    missing,
  );
  const leadsIpHashSecret = requireInProduction(
    isProduction,
    'LEADS_IP_HASH_SECRET',
    parsed.LEADS_IP_HASH_SECRET,
    DEV_LEADS_IP_HASH_SECRET_DEFAULT,
    missing,
  );
  const leadsAllowedOrigins = requireInProduction(
    isProduction,
    'LEADS_ALLOWED_ORIGINS',
    parsed.LEADS_ALLOWED_ORIGINS,
    DEV_LEADS_ALLOWED_ORIGINS_DEFAULT,
    missing,
  );

  if (missing.length > 0) {
    throw new ConfigError(missing);
  }

  return Object.freeze({
    ...parsed,
    ADMIN_DATABASE_URL: databaseUrl ?? '',
    ADMIN_JWT_SECRET: jwtSecret,
    INTERNAL_API_SERVICE_TOKEN_SECRET: serviceTokenSecret,
    WP_KEY_RING_PATH: keyRingPath,
    LEADS_IP_HASH_SECRET: leadsIpHashSecret,
    LEADS_ALLOWED_ORIGINS: leadsAllowedOrigins,
  });
}
