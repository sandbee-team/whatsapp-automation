import type { ChildProcess } from 'node:child_process';
import type { createPool } from '@wp/db';
import {
  spreadInstances,
  assignDeadlineMs,
  type ChildMessage,
  type IpcTimeoutOptions,
} from '../../../../../scripts/measure/scale-fleet.js';
import { DISCOVERY_STALE_MS } from '../fleet/discovery.js';

/**
 * scale-fleet-takeover.ts (P26 U2a split) - `reassignDeadWorkerInstances`,
 * mechanically extracted out of `scale-fleet.ts` purely for that file's own
 * max-lines cap. Pure code motion: same "parent-observed staleness -> real
 * LeaseManager.acquire" model documented in `scale-fleet.ts`'s own header -
 * see that file for the full rationale.
 */

export interface TakeoverResult {
  instanceId: string;
  takeoverMs: number;
}

export interface TakeoverDeps {
  pool: ReturnType<typeof createPool>;
  allInstances: { instanceId: string; clientId: string }[];
  children: Map<string, { proc: ChildProcess; killedAtMs?: number }>;
  sendTo: (
    child: ChildProcess,
    message: { type: 'assign'; instances: { instanceId: string; clientId: string }[] },
  ) => void;
  waitForMessage: <T extends ChildMessage>(
    child: ChildProcess,
    predicate: (msg: ChildMessage) => msg is T,
    timeoutMs: number,
    what: string,
  ) => Promise<T>;
  ipcTimeouts?: IpcTimeoutOptions;
}

export async function reassignDeadWorkerInstances(
  deps: TakeoverDeps,
  deadWorkerId: string,
  toWorkerIds: string[],
): Promise<TakeoverResult[]> {
  const { pool, allInstances, children, sendTo, waitForMessage, ipcTimeouts } = deps;
  const dead = children.get(deadWorkerId);
  const killedAtMs = dead?.killedAtMs ?? Date.now();

  // Only instances this dead worker was actually assigned (read from
  // instance_lease_state's own ownership column) - the staleness wait below
  // is the actual correctness gate, this is just scoping the target set.
  // `client_id = ANY($3)` keeps the read inside this fleet's OWN tenants
  // (invariant 4) - the harness shares Postgres with other runs.
  const fleetClientIds = [...new Set(allInstances.map((i) => i.clientId))];
  const ownedResult = await pool.query<{ instance_id: string }>(
    `SELECT instance_id FROM instance_lease_state
      WHERE owner_worker_id = $1 AND instance_id = ANY($2) AND client_id = ANY($3)`,
    [deadWorkerId, allInstances.map((i) => i.instanceId), fleetClientIds],
  );
  const ownedIds = new Set(ownedResult.rows.map((r) => r.instance_id));
  const targets = allInstances.filter((i) => ownedIds.has(i.instanceId));

  // Wait for each instance's lease row to look stale (parent-observed
  // staleness - never a fabricated expiry). `lease_seen_at` NULL or older
  // than DISCOVERY_STALE_MS matches `wp_lease_scan_unowned`'s own predicate.
  const deadline = Date.now() + 60_000;
  for (const instance of targets) {
    for (;;) {
      const result = await pool.query<{ lease_seen_at: Date | null }>(
        'SELECT lease_seen_at FROM instance_lease_state WHERE instance_id = $1 AND client_id = $2',
        [instance.instanceId, instance.clientId],
      );
      const seenAt = result.rows[0]?.lease_seen_at ?? null;
      const isStale = seenAt === null || Date.now() - seenAt.getTime() > DISCOVERY_STALE_MS;
      if (isStale) break;
      if (Date.now() > deadline) {
        throw new Error(
          `reassignDeadWorkerInstances: instance ${instance.instanceId} never went stale`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const spread = spreadInstances(
    targets.map((i) => i.instanceId),
    toWorkerIds.length,
  );
  const results: TakeoverResult[] = [];
  for (let i = 0; i < toWorkerIds.length; i += 1) {
    const workerId = toWorkerIds[i];
    const handle = workerId ? children.get(workerId) : undefined;
    const ids = spread[i] ?? [];
    if (!handle || ids.length === 0) continue;
    const instances = ids
      .map((id) => targets.find((t) => t.instanceId === id))
      .filter((v): v is { instanceId: string; clientId: string } => v !== undefined);
    // Attach every listener BEFORE sending `assign` - the child dispatches
    // its own `assignOne` calls concurrently (`Promise.all`) and can reply
    // faster than a sequential `await waitForMessage` per instance would
    // start listening, which would otherwise miss an early reply forever
    // (`waitForMessage` never buffers messages that arrive before it is
    // attached).
    const deadline = assignDeadlineMs(instances.length, ipcTimeouts);
    const waits = instances.map((instance) =>
      waitForMessage(
        handle.proc,
        (m): m is Extract<ChildMessage, { type: 'assigned' }> =>
          m.type === 'assigned' && m.instanceId === instance.instanceId,
        deadline,
        `assigned for ${String(instances.length)} instances on ${workerId} (takeover)`,
      ),
    );
    sendTo(handle.proc, { type: 'assign', instances });
    await Promise.all(waits);
    for (const instance of instances) {
      results.push({ instanceId: instance.instanceId, takeoverMs: Date.now() - killedAtMs });
    }
  }
  return results;
}
