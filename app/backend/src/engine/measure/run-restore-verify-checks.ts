import { loadQuery, bindQueryParams, type createPool } from '@wp/db';
import { DEFAULT_BAND_WEIGHTS } from '@wp/domain';
import type { RestoreDrillReport } from '../../../../../scripts/ops/restore-drill-report.js';

/**
 * run-restore-verify-checks.ts (P26 Unit U7, step 7) - the query helpers for
 * `run-restore-verify.ts`, split out purely to stay under the repo's
 * `max-lines` cap (see `session-worker-discovery-wiring.ts` for the
 * established split idiom this file mirrors). No behaviour lives here that
 * isn't also owned by `run-restore-verify.ts`'s own doc comment - this is a
 * pure code-motion split, not a new module boundary.
 *
 * Every helper takes a `Pool` built by `@wp/db`'s `createPool` (the repo's
 * ONE pool constructor, per review) rather than importing `pg` directly -
 * `app/backend` has no direct `pg` dependency and none is added here.
 */

/**
 * P26 C1 fix round MINOR (e): derives the ADR 0018 tier claim from the
 * RESTORED `whatsapp_instances` COUNT, never a hardcoded `'<=2000'` -
 * `run-restore-verify.ts` used to write that literal regardless of what the
 * drill actually restored. Bands match ADR 0018 section 7's own tiers
 * (`<=2000` / `5000` / `10000`); the `claimedRto` text mirrors
 * `ADR_0018_TIER_CLAIM` (`restore-drill-report.ts`) split per band.
 */
export function deriveAdr0018Tier(
  restoredInstanceCount: number,
): RestoreDrillReport['adr0018Tier'] {
  if (restoredInstanceCount <= 2000) {
    return { tier: '<=2000', claimedRto: '~1 h at <= 2,000 connected' };
  }
  if (restoredInstanceCount <= 5000) {
    return { tier: '5000', claimedRto: '4-6 h at 10,000 from backup (5,000 band)' };
  }
  return { tier: '10000', claimedRto: '4-6 h at 10,000 from backup' };
}

export const SENTINELS = [
  'noiseKey',
  'signedIdentityKey',
  'registrationId',
  'advSecretKey',
] as const;

type Pool = ReturnType<typeof createPool>;

/**
 * The minimal `.query`-only surface `listPublicTables`/`countRows` need - a
 * `PoolClient` (from `pool.connect()`, e.g. `run-restore-snapshot-counts.ts`
 * counting every table INSIDE one pinned snapshot transaction) has this same
 * shape but is not structurally a full `Pool` (it lacks `totalCount` etc.),
 * so these two helpers accept the narrower type deliberately.
 */
export interface Queryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface TableNameRow {
  table_name: string;
}

export async function listPublicTables(pool: Queryable): Promise<string[]> {
  const result = await pool.query<TableNameRow>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  return result.rows.map((r) => r.table_name);
}

export async function countRows(pool: Queryable, tableName: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "${tableName.replace(/"/g, '""')}"`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

export async function readSchemaVersion(pool: Pool): Promise<number> {
  const result = await pool.query<{ max_version: number | string | null }>(
    'SELECT max(version) AS max_version FROM schema_migrations',
  );
  const raw = result.rows[0]?.max_version ?? null;
  return raw === null ? 0 : Number(raw);
}

export async function readDatabaseSizeBytes(pool: Pool, database: string): Promise<number> {
  const result = await pool.query<{ size: string }>('SELECT pg_database_size($1)::text AS size', [
    database,
  ]);
  return Number(result.rows[0]?.size ?? '0');
}

/**
 * The real DWRR band weights (`HIGH:NORMAL:LOW = 6:3:1`,
 * `packages/domain/src/queue/dwrr.ts`) - `message_jobs.priority_rank` only
 * ever carries one of these three values in production. ~199,828 leftover
 * `Queue Fixture Client` rows in the live DB carry ranks 10/20/30, which the
 * real claim statement never matches; the probe must not pick one of those
 * (P26 restore-drill-verifier lesson, 2026-09-07).
 */
const REAL_BAND_RANKS = Object.values(DEFAULT_BAND_WEIGHTS);

/**
 * The claim-check on TARGET: runs INSIDE `BEGIN ... ROLLBACK` on a SINGLE
 * pinned connection (`pool.connect()` - the transaction/`SET LOCAL` pairing
 * requires one connection, same reasoning as `WorkerDb.withWorker`'s own doc
 * comment), never mutating the scratch DB's jobs. Binds the exact parameter
 * set `claimOne`/`claim.integration.test.ts`'s `DEFAULT_CLAIM_INPUT` use,
 * with `app.client_id` set via `SET LOCAL` exactly as `TenantDb.withTenant`
 * does (RLS is FORCEd; this connection is the superuser, but `SET LOCAL` is
 * set anyway so the claim runs under the same tenant-scoping contract
 * production callers use).
 *
 * The picking query MIRRORS `db/queries/claim-jobs.sql`'s own WHERE clause
 * (fence, health, epoch, client status, wallet, campaign, band, timing)
 * exactly - a job the probe picks that the real predicate would reject is
 * not a claim-path proof, it is a coin flip (P26 restore-drill-verifier
 * lesson, 2026-09-07: drills #2 and #3 both returned 0 rows because the old
 * picking query had no predicates at all and could land on an unclaimable
 * fixture row). `ORDER BY j.created_at DESC` prefers the newest row when
 * more than one is claimable. When NO row satisfies the mirrored predicate,
 * that is an honest, NAMED zero - never indistinguishable from a query bug.
 */
export async function runClaimCheck(
  pool: Pool,
): Promise<{ rowsReturned: number; ok: boolean; note: string }> {
  const picked = await pool.query<{
    client_id: string;
    instance_id: string;
    current_fence: string;
    priority_rank: number;
  }>(
    `SELECT ils.client_id, ils.instance_id, ils.current_fence, j.priority_rank
       FROM message_jobs j
       JOIN whatsapp_instances   i  ON i.id = j.instance_id  AND i.client_id  = j.client_id
       JOIN instance_lease_state ils ON ils.instance_id = j.instance_id AND ils.client_id = j.client_id
       JOIN clients              c  ON c.id = j.client_id
       JOIN wallet_accounts      w  ON w.client_id = j.client_id
       LEFT JOIN campaigns       cp ON cp.id = j.campaign_id AND cp.client_id = j.client_id
      WHERE j.status          = 'queued'
        AND j.priority_rank   = ANY($1)
        AND j.next_attempt_at <= now()
        AND j.scheduled_at    <= now()
        AND i.health_state    = 'connected'
        AND i.session_epoch   = j.session_epoch
        AND i.deleted_at IS NULL
        AND c.status          = 'active'
        AND w.state NOT IN ('empty','frozen')
        AND w.balance_minor  >= w.max_rate_minor
        AND (j.campaign_id IS NULL OR cp.status IN ('running','expanding'))
      ORDER BY j.created_at DESC
      LIMIT 1`,
    [REAL_BAND_RANKS],
  );
  const row = picked.rows[0];
  if (row === undefined) {
    return {
      rowsReturned: 0,
      ok: false,
      note: 'no claimable job existed in the source at dump time - claim path not exercised',
    };
  }

  const query = await loadQuery('claim-jobs');
  const params = bindQueryParams(query, {
    client_id: row.client_id,
    instance_id: row.instance_id,
    band: row.priority_rank,
    fence: row.current_fence,
    worker: 'restore-drill-verify',
    claim_expiry_ms: 30_000,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT set_config($1, $2, true)', ['app.client_id', row.client_id]);
      const claimed = await client.query(query.text, params);
      return {
        rowsReturned: claimed.rows.length,
        ok: claimed.rows.length >= 1,
        note: 'ran as the superuser connection (RLS FORCEd but bypassed by superuser); claimed inside BEGIN...ROLLBACK, never committed',
      };
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
  }
}

export async function runPlaintextScan(
  pool: Pool,
  dumpPath: string,
): Promise<RestoreDrillReport['verification']['plaintextScan']> {
  let blobHits = 0;
  for (const sentinel of SENTINELS) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM whatsapp_session_credentials
        WHERE position(convert_to($1, 'UTF8') in ciphertext) > 0`,
      [sentinel],
    );
    blobHits += Number(result.rows[0]?.count ?? '0');
  }

  const dumpFileHits = await scanDumpFileForSentinels(dumpPath);

  return {
    sentinels: [...SENTINELS],
    blobHits,
    dumpFileHits,
    ok: blobHits === 0 && dumpFileHits === 0,
  };
}

/**
 * Streaming byte scan of the dump file for every sentinel - the dump is
 * uncompressed custom format (`-Z0`), precisely so this scan is meaningful
 * (a compressed dump would hide a plaintext hit from a naive substring
 * scan).
 */
async function scanDumpFileForSentinels(dumpPath: string): Promise<number> {
  const { createReadStream } = await import('node:fs');
  const needles = SENTINELS.map((s) => Buffer.from(s, 'utf8'));
  let hits = 0;
  let carry = Buffer.alloc(0);
  const maxNeedleLen = Math.max(...needles.map((n) => n.length));

  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(dumpPath);
    stream.on('data', (chunk: Buffer) => {
      const combined = Buffer.concat([carry, chunk]);
      for (const needle of needles) {
        let index = combined.indexOf(needle);
        while (index !== -1) {
          hits += 1;
          index = combined.indexOf(needle, index + 1);
        }
      }
      carry = combined.subarray(Math.max(0, combined.length - (maxNeedleLen - 1)));
    });
    stream.on('end', () => {
      resolvePromise();
    });
    stream.on('error', (err) => {
      reject(err);
    });
  });

  return hits;
}
