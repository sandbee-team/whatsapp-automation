import { loadQuery, bindQueryParams } from '@wp/db';
import type { TenantDb, TenantQueryable } from '@wp/db';
import { bindGroupsMetrics } from '../../platform/metrics/groups-metrics.js';
import {
  runGroupSyncForInstance,
  runPendingGroupLeaves,
  type GroupSocketPort,
} from '../../modules/groups/index.js';
import type { RunnerHandle, SessionRunnerRegistry } from './registry.js';

/**
 * engine/session/session-groups-sync-timer.ts (P24 Unit U3, step 4/5) - the
 * per-WORKER groups-sync timer, mechanically split out of `roles/
 * session-worker.ts` (mirrors `engine/fleet/session-cost-feedback-timer.ts`'s
 * own split idiom): every tick, walks this worker's OWNED instances
 * (`registry.values()`, never a fleet-wide scan) and, for each one whose
 * `getGroupSocket()` is live, checks `groups-sync-due.sql` UNDER THAT
 * INSTANCE'S OWN TENANT (`tenantDb.withTenant(handle.clientId, ...)`) - a
 * single batched cross-tenant due-scan is not possible here:
 * `whatsapp_instances`/`wa_groups` carry only the standard `tenant_isolation`
 * RLS policy keyed on `app.client_id`, with no `app.worker_id`-keyed policy
 * the way `instance_lease_state` has for lease renewal, so this is a
 * per-instance check, not a CROSS_TENANT_QUERIES entry. An instance whose
 * tenant never touched groups produces ZERO provider calls (the due query's
 * own EXISTS predicate). Runs pending leaves for every currently-owned
 * instance with a live socket, after the sync pass. One instance's error
 * never aborts the tick for the rest - each runs in its own try/catch, ids
 * only in the log line.
 */

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_JITTER_MS = 12_000;

async function isSyncDue(
  tenantDb: TenantDb,
  clientId: string,
  instanceId: string,
): Promise<boolean> {
  const query = await loadQuery('groups-sync-due');
  const params = bindQueryParams(query, { client_id: clientId, instance_id: instanceId });
  const row = await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
    const result = await tx.query<{ due: boolean }>(query.text, params);
    return result.rows[0];
  });
  return row?.due ?? false;
}

export interface BuildGroupsSyncTimerOptions {
  tenantDb: TenantDb;
  registry: SessionRunnerRegistry;
  logger: {
    warn(obj: Record<string, unknown>, msg: string): void;
    info(obj: Record<string, unknown>, msg: string): void;
  };
  now?: () => number;
  rng?: { random(): number };
  intervalMs?: number;
  jitterMs?: number;
}

export interface GroupsSyncTimerHandle {
  stop(): void;
  runOnce(): Promise<void>;
}

async function syncOneHandle(
  tenantDb: TenantDb,
  handle: RunnerHandle,
  groupSocket: GroupSocketPort,
  metrics: ReturnType<typeof bindGroupsMetrics>,
  now: () => number,
  logger: BuildGroupsSyncTimerOptions['logger'],
): Promise<void> {
  try {
    const due = await isSyncDue(tenantDb, handle.clientId, handle.instanceId);
    if (!due) {
      return;
    }
    await runGroupSyncForInstance({
      tenantDb,
      clientId: handle.clientId,
      instanceId: handle.instanceId,
      groupSocket,
      metrics,
      clock: { now },
      logger,
    });
  } catch (err) {
    logger.warn(
      {
        client_id: handle.clientId,
        instance_id: handle.instanceId,
        error_class: err instanceof Error ? err.name : 'unknown',
      },
      'groups: sync failed, will retry next due cycle',
    );
  }
}

/** Builds and starts the per-worker groups-sync timer. */
export function buildGroupsSyncTimer(options: BuildGroupsSyncTimerOptions): GroupsSyncTimerHandle {
  const now = options.now ?? Date.now;
  const rng = options.rng ?? { random: Math.random };
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
  const metrics = bindGroupsMetrics();

  function nextDelayMs(): number {
    const jitter = (rng.random() * 2 - 1) * jitterMs;
    return intervalMs + jitter;
  }

  async function runOnce(): Promise<void> {
    const handles = [...options.registry.values()];

    for (const handle of handles) {
      const groupSocket = handle.getGroupSocket?.();
      if (!groupSocket) {
        continue;
      }
      await syncOneHandle(options.tenantDb, handle, groupSocket, metrics, now, options.logger);
    }

    for (const handle of handles) {
      const groupSocket = handle.getGroupSocket?.();
      if (!groupSocket) {
        continue;
      }
      try {
        await runPendingGroupLeaves({
          tenantDb: options.tenantDb,
          clientId: handle.clientId,
          instanceId: handle.instanceId,
          groupSocket,
          logger: options.logger,
        });
      } catch (err) {
        options.logger.warn(
          {
            client_id: handle.clientId,
            instance_id: handle.instanceId,
            error_class: err instanceof Error ? err.name : 'unknown',
          },
          'groups: leave sweep failed for instance',
        );
      }
    }
  }

  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function scheduleNext(): void {
    if (stopped) return;
    timerHandle = setTimeout(() => {
      void runOnce()
        .catch((err: unknown) => {
          options.logger.warn(
            { error_class: err instanceof Error ? err.name : 'unknown' },
            'groups: sync timer tick failed',
          );
        })
        .finally(scheduleNext);
    }, nextDelayMs());
  }
  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      if (timerHandle !== undefined) {
        clearTimeout(timerHandle);
      }
    },
    runOnce,
  };
}
