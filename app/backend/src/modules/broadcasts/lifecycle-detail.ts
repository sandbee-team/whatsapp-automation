import type { TenantDb, TenantQueryable } from '@wp/db';
import { BROADCAST_DISCLOSURE, type BroadcastStatus } from '@wp/domain';
import {
  countDeferredRecipients,
  listCampaigns,
  readCounters,
  type CampaignSummaryRow,
} from './broadcasts.repo.js';
import type { CancelBookkeepingResult } from './cancel-bookkeeping.js';

/**
 * lifecycle-detail.ts (P23 Unit U5, step 6) - the read-shaping half of the
 * lifecycle module, split out of `lifecycle.service.ts` purely for the
 * 300-line cap (`session-worker-discovery-wiring.ts`'s own split idiom):
 * `BroadcastDetail`'s wire shape, `toDetail` (joins the O(1) `campaign_
 * counters` rollup with the derived, read-time `deferred` count - NEVER
 * stored, see `campaign-counters.ts`'s own header), and `listBroadcasts`'
 * keyset cursor codec + read path.
 */

export interface LifecycleDeps {
  tenantDb: TenantDb;
  publishWake: (clientId: string, instanceId: string) => Promise<void> | void;
  /**
   * Injectable for tests ONLY (defaults to the real `runCancelBookkeepingBatch`
   * in `lifecycle.service.ts#cancelBroadcast`) - lets a test observe the
   * cancel commit BEFORE any bookkeeping batch has run (a no-op stub), or
   * inject a crash after the first committed batch, without a second cancel
   * code path. Production callers (`roles/api.ts`) never supply this - the
   * real bookkeeping always runs.
   */
  runBookkeeping?: (input: {
    clientId: string;
    campaignId: string;
  }) => Promise<CancelBookkeepingResult>;
}

export interface BroadcastDetail {
  id: string;
  name: string;
  status: BroadcastStatus;
  instanceId: string;
  priority: 'high' | 'normal' | 'low';
  audienceCount: number | null;
  quoteMinor: number | null;
  priceKey: string | null;
  scheduledAt: string | null;
  snapshotDoneAt: string | null;
  expandDoneAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  counters: {
    total: number;
    pending: number;
    skipped: number;
    queued: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    cancelled: number;
    deferred: number;
    chargedMinor: number;
  };
  disclosure: string;
}

export function toIsoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export async function toDetail(
  tx: TenantQueryable,
  clientId: string,
  row: CampaignSummaryRow,
): Promise<BroadcastDetail> {
  const [counters, deferred] = await Promise.all([
    readCounters(tx, clientId, row.id),
    countDeferredRecipients(tx, clientId, row.id),
  ]);

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    instanceId: row.instance_id,
    priority: row.priority,
    audienceCount: row.audience_count,
    quoteMinor: row.quote_minor === null ? null : Number(row.quote_minor),
    priceKey: row.price_key,
    scheduledAt: toIsoOrNull(row.scheduled_at),
    snapshotDoneAt: toIsoOrNull(row.snapshot_done_at),
    expandDoneAt: toIsoOrNull(row.expand_done_at),
    cancelReason: row.cancel_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    counters: {
      total: counters?.total ?? 0,
      pending: counters?.pending ?? 0,
      skipped: counters?.skipped ?? 0,
      queued: counters?.queued ?? 0,
      sent: counters?.sent ?? 0,
      delivered: counters?.delivered ?? 0,
      read: counters?.read ?? 0,
      failed: counters?.failed ?? 0,
      cancelled: counters?.cancelled ?? 0,
      deferred,
      chargedMinor: Number(counters?.charged_minor ?? 0),
    },
    disclosure: BROADCAST_DISCLOSURE,
  };
}

function encodeListCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

function decodeListCursor(cursor: string): { createdAt: string; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = decoded.indexOf('|');
  return { createdAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
}

export interface ListBroadcastsResult {
  items: Array<Omit<BroadcastDetail, 'counters' | 'disclosure'>>;
  nextCursor?: string;
}

/** Keyset list by `(created_at DESC, id DESC)` - NEVER `OFFSET`. */
export async function listBroadcasts(
  deps: LifecycleDeps,
  input: { clientId: string; limit: number; cursor?: string },
): Promise<ListBroadcastsResult> {
  return deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const cursor = input.cursor ? decodeListCursor(input.cursor) : undefined;
    const rows = await listCampaigns(tx, { clientId: input.clientId, limit: input.limit, cursor });

    const items = rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      instanceId: row.instance_id,
      priority: row.priority,
      audienceCount: row.audience_count,
      quoteMinor: row.quote_minor === null ? null : Number(row.quote_minor),
      priceKey: row.price_key,
      scheduledAt: toIsoOrNull(row.scheduled_at),
      snapshotDoneAt: toIsoOrNull(row.snapshot_done_at),
      expandDoneAt: toIsoOrNull(row.expand_done_at),
      cancelReason: row.cancel_reason,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));

    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length === input.limit && last
        ? encodeListCursor(last.created_at.toISOString(), last.id)
        : undefined;

    return { items, nextCursor };
  });
}
