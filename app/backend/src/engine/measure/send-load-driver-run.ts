import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createPool } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { createMeasureEnqueue } from './measure-enqueue.js';
import {
  expandTenantMix,
  parseTenantMix,
  perInstanceIntervalMs,
  type ExpandedTenant,
} from '../../../../../scripts/loadtest/tenant-mix.js';
import { runSendLoad, type SendLoadPlanItem } from './send-load-driver.js';

/**
 * send-load-driver-run.ts (P26 U2b, step 2) - the isMain-guarded RUNNABLE
 * half of `send-load-driver.ts` (max-lines split - same idiom as
 * `session-worker-discovery-wiring.ts`): reads `tenant-mix.json`, seeds real
 * `clients`/`whatsapp_instances` rows, builds one `SendLoadPlanItem` per
 * seeded instance, drives `runSendLoad` with a REAL clock/sleep, and writes
 * the session's JSON artifact.
 *
 * ENQUEUE PATH (WHICH one, and why): the SHARED
 * `measure-enqueue.ts#createMeasureEnqueue` inserts directly into
 * `message_jobs` (+ `message_job_refs` for the idempotency-key authority)
 * via a raw `@wp/db` `createPool` connection and then publishes the wake,
 * exactly as the real enqueue does - the SAME two-table shape
 * `messages.repo.ts#enqueueMessageJob` and this harness's own
 * `scale-fleet-seed.ts#seedInstance` both write. This is deliberately NOT
 * `messages.service.ts`'s full HTTP send path: that service layer's job is
 * authz/entitlement/instance-link-state/opt-out/group-resolution business
 * logic, none of which this load driver exists to exercise - its job is
 * queue THROUGHPUT under the realistic multi-tenant mix. A direct insert of
 * the durable job row is still "the real send path" from the queue/worker's
 * perspective (core invariant 1: the job row, not a direct send call, is
 * what a worker claims and dispatches) - this never bypasses the durable-job
 * boundary, it just skips the HTTP validation machinery a k6 run against a
 * live server would exercise instead.
 */

interface RunnableArgs {
  targetInstances: number;
  durationMs: number;
  out: string;
}

function parseArgs(argv: string[]): RunnableArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== undefined && arg.startsWith('--')) {
      const val = argv[i + 1];
      map.set(arg.slice(2), val ?? 'true');
      if (val !== undefined) i += 1;
    }
  }
  return {
    targetInstances: Number(map.get('instances') ?? 50),
    durationMs: Number(map.get('duration-ms') ?? 60_000),
    out:
      map.get('out') ??
      `docs/measurements/${new Date().toISOString().slice(0, 10)}-sendload-${map.get('instances') ?? '50'}.json`,
  };
}

/**
 * Inserts one real client + one real linked instance directly (same shortcut
 * as `enqueue-test-support.ts#seedInstance`) - returns the ids the plan item
 * needs. Exported so `check-tenant-scope.ts`'s `enclosingSymbol` keys this
 * span by NAME rather than `(module scope)` (P26 C1 MINOR d).
 */
export async function seedOneInstance(
  pool: ReturnType<typeof createPool>,
  tenantKey: string,
): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();
  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    `Load Test ${tenantKey}`,
    `load-test-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, link_state, health_state)
     VALUES ($1, $2, 'load-test', 'linked', 'connected')`,
    [instanceId, clientId],
  );
  return { clientId, instanceId };
}

/** Exported so `check-tenant-scope.ts`'s `enclosingSymbol` keys this function's own DELETE-cleanup span by NAME rather than `(module scope)` (P26 C1 MINOR d). Still isMain-guarded below; never runs on import. */
export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mixPath = resolve(process.cwd(), 'scripts/loadtest/tenant-mix.json');
  const mix = parseTenantMix(JSON.parse(readFileSync(mixPath, 'utf8')));
  const expanded = expandTenantMix(mix, args.targetInstances);

  const pool = createPool({ connectionString: resolveDatabaseUrl() });
  const redisCtl = createRedis(resolveRedisUrl());
  const clientIds: string[] = [];
  const plan: SendLoadPlanItem[] = [];
  for (const tenant of expanded.tenants as ExpandedTenant[]) {
    for (let i = 0; i < tenant.instances; i += 1) {
      const seeded = await seedOneInstance(pool, tenant.key);
      clientIds.push(seeded.clientId);
      plan.push({
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        intervalMs: perInstanceIntervalMs(tenant.sendsPerDayPerInstance),
        tenantKey: tenant.key,
      });
    }
  }

  console.log(
    `send-load-driver: seeded ${String(plan.length)} instances across ${String(expanded.tenants.length)} tenant classes, running for ${String(args.durationMs)}ms`,
  );

  try {
    const result = await runSendLoad(
      plan,
      {
        enqueue: createMeasureEnqueue({ pool, redisCtl, env: 'test' }),
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      {
        durationMs: args.durationMs,
        jitterRatio: 0.1,
        rng: Math.random,
      },
    );

    const header = {
      schemaVersion: 1 as const,
      kind: 'send-load' as const,
      capturedAtIso: new Date().toISOString(),
      mixPath: 'scripts/loadtest/tenant-mix.json',
      planSize: plan.length,
      node: process.version,
      hostname: os.hostname(),
    };
    const outPath = resolve(process.cwd(), args.out);
    mkdirSync(resolve(outPath, '..'), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ header, result }, null, 2));
    console.log(`send-load-driver: DONE. artifact written to ${args.out}`);
  } finally {
    await pool.query('DELETE FROM message_job_refs WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [clientIds]);
    await pool.end();
    await redisCtl.quit();
  }
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  void main();
}
