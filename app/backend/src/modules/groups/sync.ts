import { loadQuery, bindQueryParams } from '@wp/db';
import type { TenantDb, TenantQueryable } from '@wp/db';
import { normalizeJidUser, deriveTrackedParticipantDevices } from '@wp/domain';
import type { GroupRole } from '@wp/domain';
import type { GroupsMetricsHandles } from '../../platform/metrics/groups-metrics.js';
import { SYNC_MIN_INTERVAL_MS } from './groups.repo.js';

/**
 * sync.ts (P24 Unit U3, step 4) - the worker-side group sync: fetches every
 * currently-participating group once (rate-gated to at most once per
 * `GROUP_SYNC_MIN_INTERVAL_MS` per instance, enforced by
 * `session-groups-sync-timer.ts`'s own due-scan, not re-checked here), and
 * upserts each as a counts-only `wa_groups` row. NEVER touches
 * `send_enabled`/`left_at`/`leave_requested_at` (a sync only records
 * provider-observed facts). The fetched participants array is counted and
 * discarded here - it never leaves this function, is never logged, never
 * cached, never put in Redis, never a metric label (see this module's own
 * per-call log line below: ids/counts only).
 */

export interface GroupSocketPort {
  groupFetchAllParticipating(): Promise<
    Record<
      string,
      {
        id: string;
        subject?: string;
        participants: Array<{ id: string; admin?: 'admin' | 'superadmin' | null }>;
        announce?: boolean;
        creation?: number;
      }
    >
  >;
  groupLeave(jid: string): Promise<void>;
  selfJid(): string | undefined;
}

export interface RunGroupSyncDeps {
  tenantDb: TenantDb;
  clientId: string;
  instanceId: string;
  groupSocket: GroupSocketPort;
  metrics: Pick<GroupsMetricsHandles, 'observeSyncSeconds'>;
  clock: { now(): number };
  logger: {
    warn(obj: Record<string, unknown>, msg: string): void;
    info(obj: Record<string, unknown>, msg: string): void;
  };
}

function deriveOurRole(
  participants: Array<{ id: string; admin?: 'admin' | 'superadmin' | null }>,
  selfJid: string | undefined,
): GroupRole | null {
  if (!selfJid) {
    return null;
  }
  const normalizedSelf = normalizeJidUser(selfJid);
  const self = participants.find((p) => normalizeJidUser(p.id) === normalizedSelf);
  if (!self) {
    return null;
  }
  if (self.admin === 'admin') return 'admin';
  if (self.admin === 'superadmin') return 'superadmin';
  return 'member';
}

async function upsertOneGroup(
  tx: TenantQueryable,
  input: {
    clientId: string;
    instanceId: string;
    groupJid: string;
    subject: string | null;
    participantCount: number;
    isAnnounce: boolean;
    ourRole: GroupRole | null;
    joinedAt: Date | null;
    trackedParticipantDevices: number;
  },
): Promise<void> {
  const query = await loadQuery('groups-upsert-synced');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
    group_jid: input.groupJid,
    subject: input.subject,
    participant_count: input.participantCount,
    is_announce: input.isAnnounce,
    our_role: input.ourRole,
    joined_at: input.joinedAt,
    tracked_participant_devices: input.trackedParticipantDevices,
  });
  await tx.query(query.text, params);
}

async function markMissingLeft(
  tx: TenantQueryable,
  input: { clientId: string; instanceId: string; jids: string[] },
): Promise<void> {
  const query = await loadQuery('groups-mark-missing-left');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
    jids: input.jids,
  });
  await tx.query(query.text, params);
}

async function markSyncComplete(
  tx: TenantQueryable,
  input: { clientId: string; instanceId: string },
): Promise<void> {
  const query = await loadQuery('groups-sync-complete');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
    min_interval_ms: SYNC_MIN_INTERVAL_MS,
  });
  await tx.query(query.text, params);
}

/**
 * Runs ONE group sync for ONE instance. Never throws for a normal empty/
 * never-touched-groups instance - the caller decides whether to invoke this
 * at all (the due-scan in `session-groups-sync-timer.ts`).
 *
 * An EMPTY fetched map (P24 C2 fix round, Fix 3) is treated as "no data
 * this tick", never as "we are in zero groups now": upserts nothing, marks
 * NOTHING left, still advances the sync clock (so the hourly cadence
 * holds and this instance is not immediately re-selected as due), and logs
 * at warn so a genuinely-empty provider response is visible. A transient
 * empty fetch (provider hiccup) must never mass-disable every group's
 * sending on this instance; a genuinely-left-everything account converges
 * the next time the fetch returns a non-empty set, or per-group via a
 * `group_forbidden` signal (`on-forbidden.ts`).
 */
export async function runGroupSyncForInstance(deps: RunGroupSyncDeps): Promise<void> {
  const startedAt = deps.clock.now();
  const groupsByJid = await deps.groupSocket.groupFetchAllParticipating();
  const selfJid = deps.groupSocket.selfJid();

  const jids: string[] = [];
  let participantTotal = 0;
  const isEmptyFetch = Object.keys(groupsByJid).length === 0;

  await deps.tenantDb.withTenant(deps.clientId, async (tx) => {
    if (!isEmptyFetch) {
      for (const [groupJid, metadata] of Object.entries(groupsByJid)) {
        jids.push(groupJid);
        const participants = metadata.participants;
        participantTotal += participants.length;

        await upsertOneGroup(tx, {
          clientId: deps.clientId,
          instanceId: deps.instanceId,
          groupJid,
          subject: metadata.subject ? metadata.subject.slice(0, 200) : null,
          participantCount: participants.length,
          isAnnounce: Boolean(metadata.announce),
          ourRole: deriveOurRole(participants, selfJid),
          joinedAt: metadata.creation ? new Date(metadata.creation * 1000) : null,
          trackedParticipantDevices: deriveTrackedParticipantDevices(participants.length),
        });
      }

      await markMissingLeft(tx, { clientId: deps.clientId, instanceId: deps.instanceId, jids });
    }

    await markSyncComplete(tx, { clientId: deps.clientId, instanceId: deps.instanceId });
  });

  const logFields = {
    client_id: deps.clientId,
    instance_id: deps.instanceId,
    group_count: jids.length,
    participant_total: participantTotal,
  };
  if (isEmptyFetch) {
    deps.logger.warn(logFields, 'groups: sync returned no data this tick');
  } else {
    deps.logger.info(logFields, 'groups: sync complete');
  }
  deps.metrics.observeSyncSeconds((deps.clock.now() - startedAt) / 1000);
}
