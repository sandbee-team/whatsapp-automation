import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';
import type { ClaimOneCtx } from '../index.js';

/**
 * claim-test-helpers.ts - shared, non-test fixture machinery for the
 * `claimOne` integration test suite (previously duplicated verbatim across
 * `claim.integration.test.ts` and `claim.edge-cases.integration.test.ts`;
 * extracted in the P03-close file-size split, protocol C2). Deliberately
 * does NOT match the `*.test.ts` glob so it is never picked up as its own
 * suite.
 *
 * Every helper takes its caller's own `pool`/`probeClientIds` explicitly
 * (never a shared module-level singleton) so each split test file keeps its
 * own independent pool connection and cleanup list, exactly as the two
 * original files did.
 *
 * `seedTenant` vs `seedTenantEdgeProbe`, and `getJob` vs `getJobWithLease`:
 * the two source files' versions differed (probe client naming, and which
 * columns the SELECT returns) - kept as distinct named exports rather than
 * silently merged, per the split's pure-move contract.
 */

export type TestPool = ReturnType<typeof createPool>;

export const DEFAULT_CLAIM_INPUT = {
  band: 10,
  fence: 1,
  workerId: 'worker-1',
  claimExpiryMs: 30_000,
};

export interface JobRow {
  status: string;
  attempts: number;
}

export interface JobRowWithLease extends JobRow {
  lease_owner: string | null;
  lease_id: string | null;
  owner_fence: string | null;
  leased_at: Date | null;
  lease_expires_at: Date | null;
}

export interface SeededTenant {
  clientId: string;
  instanceId: string;
}

export interface SeedTenantOptions {
  clientStatus?: string;
  healthState?: string;
  sessionEpoch?: number;
  fence?: number;
  walletState?: string;
  balanceMinor?: number;
  maxRateMinor?: number;
  skipWallet?: boolean;
  instanceLabel?: string;
}

/**
 * Deletes every row seeded (directly or transitively) under the given probe
 * client ids. Shared verbatim by both original files' `afterEach` hooks.
 */
export async function cleanupProbeClients(pool: TestPool, probeClientIds: string[]): Promise<void> {
  if (probeClientIds.length === 0) return;
  await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM campaigns WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
}

/**
 * Creates a client + whatsapp_instance + instance_lease_state (+
 * wallet_accounts unless skipped). Pushes the new client id onto
 * `probeClientIds` for `cleanupProbeClients`. This is `claim.integration.test.ts`'s
 * original naming ('Claim Probe Client' / `claim-probe-*`).
 */
export async function seedTenant(
  pool: TestPool,
  probeClientIds: string[],
  options: SeedTenantOptions = {},
): Promise<SeededTenant> {
  return seedTenantWithLabel(pool, probeClientIds, 'Claim Probe Client', 'claim-probe', options);
}

/**
 * Same as `seedTenant`, but with `claim.edge-cases.integration.test.ts`'s
 * original probe naming ('Claim Edge Probe Client' / `claim-edge-probe-*`).
 */
export async function seedTenantEdgeProbe(
  pool: TestPool,
  probeClientIds: string[],
  options: SeedTenantOptions = {},
): Promise<SeededTenant> {
  return seedTenantWithLabel(
    pool,
    probeClientIds,
    'Claim Edge Probe Client',
    'claim-edge-probe',
    options,
  );
}

async function seedTenantWithLabel(
  pool: TestPool,
  probeClientIds: string[],
  companyName: string,
  slugPrefix: string,
  options: SeedTenantOptions,
): Promise<SeededTenant> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    companyName,
    `${slugPrefix}-${clientId}`,
    options.clientStatus ?? 'active',
  ]);

  if (!options.skipWallet) {
    await pool.query(
      'INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor) VALUES ($1, $2, $3, $4)',
      [
        clientId,
        options.balanceMinor ?? 100_000,
        options.walletState ?? 'active',
        options.maxRateMinor ?? 100,
      ],
    );
  }

  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      instanceId,
      clientId,
      options.instanceLabel ?? 'probe',
      options.healthState ?? 'connected',
      options.sessionEpoch ?? 0,
    ],
  );

  await pool.query(
    'INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1, $2, $3)',
    [instanceId, clientId, options.fence ?? 1],
  );

  probeClientIds.push(clientId);
  return { clientId, instanceId };
}

/** Adds a second whatsapp_instance (+ lease row) under an ALREADY-seeded client. */
export async function seedExtraInstance(
  pool: TestPool,
  clientId: string,
  options: { fence?: number; instanceLabel?: string } = {},
): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, $3, 'connected', 0)`,
    [instanceId, clientId, options.instanceLabel ?? 'probe-extra'],
  );
  await pool.query(
    'INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1, $2, $3)',
    [instanceId, clientId, options.fence ?? 1],
  );
  return instanceId;
}

export interface SeedJobOptions {
  clientId: string;
  instanceId: string;
  sessionEpoch?: number;
  band?: number;
  nextAttemptAt?: Date;
  scheduledAt?: Date;
  campaignId?: string | null;
  recipientJid?: string;
}

/** Inserts one 'queued' message_jobs row, returns its bigint id (as a string). */
export async function seedJob(pool: TestPool, options: SeedJobOptions): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, campaign_id, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'text', 'normal', $8, 'queued', $9, $10)
     RETURNING id`,
    [
      options.clientId,
      options.instanceId,
      options.sessionEpoch ?? 0,
      options.campaignId ?? null,
      options.recipientJid ?? '15550000000@s.whatsapp.net',
      '+15550000000',
      JSON.stringify({ text: 'hello' }),
      options.band ?? DEFAULT_CLAIM_INPUT.band,
      options.scheduledAt ?? new Date(Date.now() - 60_000),
      options.nextAttemptAt ?? new Date(Date.now() - 60_000),
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('seedJob: INSERT ... RETURNING id returned no row');
  return id;
}

/**
 * Inserts one `campaigns` row for `clientId` with the given `status`,
 * returns its id. `instanceId` is required (migration 0064, P23 U1 -
 * `campaigns.instance_id` is `NOT NULL`) - pass the same tenant's
 * `seedTenant()`-returned `instanceId` so the FK resolves.
 */
export async function seedCampaign(
  pool: TestPool,
  clientId: string,
  status: string,
  instanceId: string,
): Promise<string> {
  const campaignId = randomUUID();
  await pool.query(
    `INSERT INTO campaigns (id, client_id, status, instance_id, name, audience, message)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, '{}'::jsonb)`,
    [campaignId, clientId, status, instanceId, `Claim Probe Campaign ${campaignId}`],
  );
  return campaignId;
}

/** `claim.integration.test.ts`'s original narrow SELECT (status, attempts only). */
export async function getJob(pool: TestPool, id: string): Promise<JobRow> {
  const result = await pool.query<JobRow>(
    'SELECT status, attempts FROM message_jobs WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`getJob: no message_jobs row with id ${id}`);
  return row;
}

/**
 * `claim.edge-cases.integration.test.ts`'s original wider SELECT, needed by
 * tests that assert on lease-column residue (or its absence).
 */
export async function getJobWithLease(pool: TestPool, id: string): Promise<JobRowWithLease> {
  const result = await pool.query<JobRowWithLease>(
    `SELECT status, attempts, lease_owner, lease_id, owner_fence, leased_at, lease_expires_at
       FROM message_jobs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`getJobWithLease: no message_jobs row with id ${id}`);
  return row;
}

export function ctxFor(clientId: string, sql: ClaimOneCtx['sql']): ClaimOneCtx {
  return { clientId, sql };
}

/**
 * A recording stub ctx that throws if `sql.query` is ever invoked - used to
 * PROVE `claimOne`'s boundary validation rejects before any DB round trip,
 * rather than merely asserting an error message that could equally come
 * from a later DB-level failure. No tenant seeding needed: an invalid-bounds
 * call must never get far enough to touch `clientId`/`instanceId` at all.
 */
export function noQueryCtx(): ClaimOneCtx {
  return {
    clientId: randomUUID(),
    sql: {
      query() {
        throw new Error('claimOne must not query on invalid bounds');
      },
    },
  };
}
