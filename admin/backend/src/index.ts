import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_SCHEMA_VERSION } from '@wp/db';
import { loadAdminConfig } from './platform/config.js';
import { createAdminLogger } from './platform/logger.js';
import { bindAdminMetrics } from './platform/metrics.js';
import { createAdminPool } from './platform/db-admin.js';
import { IpAttemptWindow } from './modules/staff-auth/lockout.js';
import { UsedTotpCodes } from './modules/staff-auth/totp.js';
import { createLeadsRepo } from './modules/leads/leads.repo.js';
import { PublicLeadsRateLimiter } from './modules/leads/public-rate-limit.js';
import { buildAdminApp } from './server.js';
import type { AdminReadPool, PlatformReadDeps } from './platform/platform-read.js';

/**
 * admin-backend boot (P28 Unit U4, step 6/10) - the internal back-office
 * API. Read-mostly by design: it owns no migrations, writes no tenant or
 * send-path data, and performs every side effect through app-backend's
 * `/internal/v1` (ADR 0014 fact 1/12).
 *
 * BOOT ORDER, and why: config (fail-closed, so a missing secret stops the
 * process rather than starting an unauthenticated panel) -> pool -> SCHEMA
 * VERSION ASSERTION -> listen. The schema assertion is not optional
 * politeness: admin-backend reads columns it does not own, so a deploy that
 * runs ahead of the migration would render wrong or empty values to a staff
 * member making a suspension or refund decision. Refusing to start is the
 * only safe answer, and it is compared against a COMPILED constant so a
 * stale build can never believe it is current.
 */

interface SchemaVersionRow extends Record<string, unknown> {
  version: string | number | null;
}

/**
 * Fails CLOSED: an unreadable `schema_migrations`, a NULL max, or any
 * mismatch all refuse the boot. There is no "assume it is fine" branch.
 */
export async function assertAdminSchemaVersion(pool: AdminReadPool): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query<SchemaVersionRow>(
      'SELECT max(version) AS version FROM schema_migrations',
    );
    const applied = Number(result.rows[0]?.version ?? NaN);
    if (applied !== EXPECTED_SCHEMA_VERSION) {
      throw new Error(
        `admin-backend expects schema version ${String(EXPECTED_SCHEMA_VERSION)} but the database has ${String(result.rows[0]?.version ?? 'none')} - refusing to start`,
      );
    }
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const config = loadAdminConfig();
  const logger = createAdminLogger();
  const metrics = bindAdminMetrics();
  const pool = createAdminPool(config);

  await assertAdminSchemaVersion(pool);

  const read: PlatformReadDeps = {
    pool,
    logDefect: (fields) => {
      logger.error(fields as never, 'admin defect');
    },
    onRead: (key) => {
      metrics.incPlatformRead(key);
    },
  };
  const auth = { pool, jwtSecret: config.ADMIN_JWT_SECRET, now: () => new Date() };
  const totpParams = {
    keyRingPath: config.WP_KEY_RING_PATH,
    encVersion: config.WP_ENC_VERSION,
  };
  const sessionTiming = {
    jwtSecret: config.ADMIN_JWT_SECRET,
    accessTokenTtlSeconds: config.ADMIN_ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlSeconds: config.ADMIN_REFRESH_TTL_SECONDS,
    now: () => new Date(),
  };

  const app = await buildAdminApp({
    read,
    auth,
    trustProxy: config.ADMIN_TRUST_PROXY,
    staffAuth: {
      auth,
      cookieSecure: config.NODE_ENV === 'production',
      login: {
        ...read,
        ...sessionTiming,
        allowedCidrs: config.ADMIN_IP_ALLOWED_CIDRS,
        totpParams,
        totpWindow: 1,
        ipWindow: new IpAttemptWindow(),
        usedTotpCodes: new UsedTotpCodes(),
      },
      refresh: { ...read, ...sessionTiming },
    },
    mutations: {
      auth,
      appPanelBaseUrl: config.APP_PANEL_BASE_URL,
      internal: {
        baseUrl: config.INTERNAL_API_BASE_URL,
        serviceTokenSecret: config.INTERNAL_API_SERVICE_TOKEN_SECRET,
        fetch: (url, init) => globalThis.fetch(url, init),
      },
    },
    leads: {
      auth,
      repo: createLeadsRepo(pool),
      allowedOrigins: config.LEADS_ALLOWED_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
      ipHashSecret: config.LEADS_IP_HASH_SECRET,
      now: () => new Date(),
      limiter: new PublicLeadsRateLimiter(() => new Date()),
      // No `wp_admin_leads_outcomes_total`-shaped counter exists on
      // `platform/metrics.ts` yet (adding one needs its own metric
      // allow-list registry entry, out of this unit's scope) - `onOutcome`
      // is left unset rather than inventing an unregistered metric.
    },
  });

  await app.listen({ port: config.ADMIN_PORT, host: config.ADMIN_HOST });
  // `LogFields` is an ALLOW-LIST (see platform/logger.ts): only listed
  // field names survive serialisation, so the port is not logged here.
  logger.info({}, 'admin api listening');
}

// True only when this module is the process entry point, false when a test
// imports it. `import.meta.main` alone is NOT enough: it is undefined before
// Node 24 (the repo pins `engines.node >= 24`, but a developer shell running
// Node 22 then SILENTLY skips `main()` - the process exits 0 with no output
// and no listener, which reads as "the server started and died"). The
// `process.argv[1]` comparison is the same fallback
// `app/backend/scripts/dev-role.ts` uses, so both entry points behave
// identically on either runtime.
const isEntryPoint =
  import.meta.main ??
  (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]));

if (isEntryPoint) {
  await main();
}
