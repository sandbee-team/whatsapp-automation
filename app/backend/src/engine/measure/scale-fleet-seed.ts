// priority_rank IS the DWRR band weight (HIGH 6 / NORMAL 3 / LOW 1) - the send loop claims
// `j.priority_rank = $band` with exactly these values; a literal 10 is unclaimable (P26 run log #13).
import { DEFAULT_BAND_WEIGHTS } from '@wp/domain';
import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';
import { buildStore } from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { cleanupSendProbeClients } from '../queue/__tests__/queue-send-tenant-fixture.js';
import type { SyntheticFleetHandles } from '../session/synthetic-fleet-support.js';

/**
 * scale-fleet-seed.ts (P26 U2a) - seeds the tenants/instances/creds/pacing
 * rows `scale-fleet.ts`'s parent needs before spawning any worker process,
 * and the matching cleanup. Same real-row shape as `fleet-recovery-test-
 * support.ts#seedLinkedInstance` (linked instance + placeholder lease row +
 * REAL encrypted creds via `buildStore`) plus `queue-send-tenant-fixture.ts`'s
 * wallet/pricing/pacing rows - this module exists purely to compose both
 * for the multi-tenant, multi-instance fleet-scale shape (N tenants x M
 * instances each), which neither existing fixture does on its own.
 */

export interface SeedScaleFleetOptions {
  /** Per-instance `instance_pacing_state` overrides - all defaults are in-range against the ABSOLUTE_* floors/ceilings (packages/domain/src/pacing/constants.ts). */
  effDailyCap?: number;
  effHourlyCap?: number;
  effNewConvCap?: number;
  effGapMinMs?: number;
  effGapMaxMs?: number;
  effColdRatioMax?: number;
  effColdRatioFloor?: number;
  effGroupDailyCap?: number;
  /** Seeds this many queued `message_jobs` rows per instance (unique recipient_jid each) - omitted/0 seeds none. */
  jobsPerInstance?: number;
}

export interface SeededScaleFleetInstance {
  instanceId: string;
  clientId: string;
}

export interface SeededScaleFleet {
  clientIds: string[];
  instances: SeededScaleFleetInstance[];
}

const SEED_OWNER_WORKER_ID = 'worker-scale-seed';

/**
 * Seeds one tenant (clients + wallet_accounts + client_pricing) - returns its
 * clientId. Exported (not just internal to `seedScaleFleet`) so
 * `check-tenant-scope.ts`'s `enclosingSymbol` keys this span by NAME rather
 * than falling back to `(module scope)` - P26 C1 MINOR (d).
 */
export async function seedTenant(pool: ReturnType<typeof createPool>): Promise<string> {
  const clientId = randomUUID();
  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Scale Fleet Probe',
    `scale-fleet-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    'INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor) VALUES ($1, $2, $3, $4)',
    [clientId, 100_000_000, 'active', 100],
  );
  await pool.query('INSERT INTO client_pricing (client_id, price_list_key) VALUES ($1, $2)', [
    clientId,
    'default_inr',
  ]);
  return clientId;
}

/**
 * Seeds one linked, pre-paced instance under `clientId`: `whatsapp_instances`
 * (connected/linked/online), a placeholder `instance_lease_state` row at
 * fence 1 with `lease_seen_at` left NULL (same rationale as
 * `fleet-recovery-test-support.ts#seedLinkedInstance`: a fresh `now()` here
 * would make this seed row look like a currently-live lease and block the
 * first real worker from discovering/grabbing it), REAL encrypted creds
 * through `buildStore(...).saveCreds` on the SAME key ring the workers use,
 * and an in-range `instance_pacing_state` row. Exported for the same
 * per-symbol tenant-scope registry reason as `seedTenant` (P26 C1 MINOR d).
 */
export async function seedInstance(
  handles: SyntheticFleetHandles,
  clientId: string,
  options: SeedScaleFleetOptions,
): Promise<string> {
  const instanceId = randomUUID();

  await handles.pool.query(
    `INSERT INTO whatsapp_instances
       (id, client_id, label, health_state, link_state, desired_state, session_epoch)
     VALUES ($1, $2, 'scale-probe', 'connected', 'linked', 'online', 0)`,
    [instanceId, clientId],
  );
  await handles.pool.query(
    `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
     VALUES ($1, $2, 1, $3, NULL)`,
    [instanceId, clientId, SEED_OWNER_WORKER_ID],
  );

  const store = buildStore(handles, {
    instanceId,
    clientId,
    fence: 1n,
    workerId: SEED_OWNER_WORKER_ID,
  });
  await store.saveCreds({ creds: { seeded: true }, expectedVersion: 0n, fence: 1n });

  await handles.pool.query(
    `INSERT INTO instance_pacing_state (
       instance_id, client_id, warmup_tier,
       eff_daily_cap, eff_hourly_cap, eff_new_conv_cap,
       eff_gap_min_ms, eff_gap_max_ms, eff_cold_ratio_max, eff_cold_ratio_floor,
       eff_window_start_local, eff_window_end_local, eff_group_daily_cap
     ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, '00:00:00', '23:59:59', $10)`,
    [
      instanceId,
      clientId,
      options.effDailyCap ?? 600,
      options.effHourlyCap ?? 60,
      options.effNewConvCap ?? 600,
      options.effGapMinMs ?? 15_000,
      options.effGapMaxMs ?? 30_000,
      options.effColdRatioMax ?? 1,
      options.effColdRatioFloor ?? 0,
      options.effGroupDailyCap ?? 50,
    ],
  );

  const jobsPerInstance = options.jobsPerInstance ?? 0;
  for (let i = 0; i < jobsPerInstance; i += 1) {
    await handles.pool.query(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
       VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', ${DEFAULT_BAND_WEIGHTS.NORMAL}, 'queued', now(), now())`,
      [
        clientId,
        instanceId,
        `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
        JSON.stringify({ text: 'scale-fleet-probe' }),
      ],
    );
  }

  return instanceId;
}

/**
 * Seeds `plan.tenants` tenants, each with `plan.instancesPerWorker *
 * plan.workers / plan.tenants` instances spread evenly (any remainder goes
 * to the first tenants) - the parent (`scale-fleet.ts`) round-robins the
 * flat `instances` list across worker processes via `spreadInstances`.
 */
export async function seedScaleFleet(
  handles: SyntheticFleetHandles,
  plan: { workers: number; instancesPerWorker: number; tenants: number },
  options: SeedScaleFleetOptions = {},
): Promise<SeededScaleFleet> {
  const totalInstances = plan.workers * plan.instancesPerWorker;
  const clientIds: string[] = [];
  for (let i = 0; i < plan.tenants; i += 1) {
    clientIds.push(await seedTenant(handles.pool));
  }

  const instances: SeededScaleFleetInstance[] = [];
  for (let i = 0; i < totalInstances; i += 1) {
    const clientId = clientIds[i % clientIds.length];
    if (clientId === undefined) continue;
    const instanceId = await seedInstance(handles, clientId, options);
    instances.push({ instanceId, clientId });
  }

  return { clientIds, instances };
}

/**
 * Deletes every row this module seeds, keyed on `= ANY($ids)` only (never a
 * name prefix - lesson 2026-09-06). `whatsapp_session_credentials`/
 * `whatsapp_session_keys` are deleted FIRST (neither is covered by
 * `cleanupSendProbeClients`), then delegates the rest of the FK-ordered
 * delete list to that shared fixture.
 */
export async function cleanupScaleFleet(
  pool: ReturnType<typeof createPool>,
  clientIds: string[],
): Promise<void> {
  if (clientIds.length === 0) return;
  await pool.query('DELETE FROM whatsapp_session_keys WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM whatsapp_session_credentials WHERE client_id = ANY($1)', [
    clientIds,
  ]);
  await cleanupSendProbeClients(pool, clientIds);
}
