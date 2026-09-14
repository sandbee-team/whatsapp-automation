import { loadQuery, bindQueryParams, type TenantDb } from '@wp/db';
import type { InstanceCardData } from '@wp/contracts';
import { tenantKey } from '../../platform/redis.js';

/**
 * card.service.ts (P17 Unit U4, step 7) - `readInstanceCard`: the instance
 * card's read model. Composes `db/queries/instance-card.sql` (link/health/
 * desired state + pacing-state limits/next_eligible_at) with two BOUNDED
 * queue probes (`instance-card-queue-depth.sql` / `instance-card-oldest-
 * queued.sql`) and today's usage counters (`instance-card-usage.sql`) -
 * this module NEVER re-implements gap arithmetic itself: `nextSendEarliestAt`
 * is `instance_pacing_state.next_eligible_at`, read verbatim.
 *
 * Client-scoped throughout (`client_id` bound on every statement) - never
 * cross-tenant, so none of these queries are registered in
 * `CROSS_TENANT_QUERIES`.
 *
 * The two queue numbers (`queueDepth`/`oldestQueuedAgeSeconds`) are cached in
 * Redis for 5s PER INSTANCE (rebuildable: a cache miss recomputes, and a
 * Redis error falls back to a direct compute rather than failing the whole
 * card - core invariant "Redis state is rebuildable; PostgreSQL is the
 * source of truth").
 */

const QUEUE_CACHE_TTL_SEC = 5;
const QUEUE_DEPTH_CAP = 10_000;

export interface CardServiceRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSec: number): Promise<unknown>;
}

export interface CardServiceCtx {
  tenantDb: TenantDb;
  redis: CardServiceRedis;
  env: string;
}

export interface ReadInstanceCardInput {
  clientId: string;
  instanceId: string;
}

export class InstanceCardNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such WhatsApp instance.');
    this.name = 'InstanceCardNotFoundError';
  }
}

interface InstanceCardRow extends Record<string, unknown> {
  instance_id: string;
  label: string | null;
  link_state: string;
  health_state: string;
  desired_state: string;
  needs_user_action: boolean;
  user_action_reason: string | null;
  pause_reason: string | null;
  last_send_at: Date | null;
  health_score: string;
  health_band: string;
  warmup_tier: number;
  warmup_tier_since: Date | null;
  eff_daily_cap: number;
  eff_new_conv_cap: number;
  eff_window_start_local: string;
  eff_window_end_local: string;
  pacing_timezone: string;
}

interface QueueDepthResult {
  queueDepth: number;
  queueDepthCapped: boolean;
}

/** Runs the bounded `LIMIT 10001` queue-depth probe directly against Postgres - no cache. */
async function computeQueueDepth(
  tenantDb: TenantDb,
  input: ReadInstanceCardInput,
): Promise<QueueDepthResult> {
  const query = await loadQuery('instance-card-queue-depth');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
  });
  const result = await tenantDb.withTenant(input.clientId, (tx) =>
    tx.query<{ queue_depth: string }>(query.text, params),
  );
  const raw = Number(result.rows[0]?.queue_depth ?? 0);
  if (raw > QUEUE_DEPTH_CAP) {
    return { queueDepth: QUEUE_DEPTH_CAP, queueDepthCapped: true };
  }
  return { queueDepth: raw, queueDepthCapped: false };
}

interface OldestQueuedResult {
  oldestQueuedAgeSeconds: number | null;
}

/** Runs the `MIN(created_at)` oldest-queued probe directly against Postgres - no cache. `server_now` is read here but deliberately NOT part of the returned/cached shape (see `cachedQueueNumbers`'s own doc comment) - the caller reads its own fresh `serverNow` per request instead. */
async function computeOldestQueued(
  tenantDb: TenantDb,
  input: ReadInstanceCardInput,
): Promise<OldestQueuedResult> {
  const query = await loadQuery('instance-card-oldest-queued');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
  });
  const result = await tenantDb.withTenant(input.clientId, (tx) =>
    tx.query<{ oldest_queued_at: Date | null; server_now: Date }>(query.text, params),
  );
  const row = result.rows[0];
  const serverNow = row?.server_now ?? new Date();
  if (!row?.oldest_queued_at) {
    return { oldestQueuedAgeSeconds: null };
  }
  const ageSeconds = (serverNow.getTime() - row.oldest_queued_at.getTime()) / 1000;
  return { oldestQueuedAgeSeconds: Math.max(0, ageSeconds) };
}

interface UsageResult {
  todaySent: number;
  newConversationsToday: number;
  nextEligibleAt: Date | null;
}

/** Reads today's counters AND `next_eligible_at` from the SAME stored `pacing_ledger` row `reserve-pacing.sql` maintains - never a `count(*)` over `message_jobs`, never a re-derived gap. */
async function computeUsage(
  tenantDb: TenantDb,
  input: ReadInstanceCardInput,
): Promise<UsageResult> {
  const query = await loadQuery('instance-card-usage');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
  });
  const result = await tenantDb.withTenant(input.clientId, (tx) =>
    tx.query<{ consumed_count: number; new_conv_count: number; next_eligible_at: Date | null }>(
      query.text,
      params,
    ),
  );
  const row = result.rows[0];
  return {
    todaySent: row?.consumed_count ?? 0,
    newConversationsToday: row?.new_conv_count ?? 0,
    nextEligibleAt: row?.next_eligible_at ?? null,
  };
}

/** The cached shape - deliberately EXCLUDES `serverNow` (P17 fix round F3): a `Date` revived from `JSON.parse` on a cache hit is a plain string, not a `Date` instance, so a stale/mis-typed `serverNow` would either throw on `.toISOString()` or corrupt the client's clock-skew math. `serverNow` is always read fresh, per request, never cached. */
type CachedQueueNumbers = QueueDepthResult & OldestQueuedResult;

/** Reads/writes the 5s Redis cache for the two queue numbers - a cache miss OR a Redis error recomputes directly (rebuildable, never fails the card). `serverNow` is read fresh on EVERY call (never cached - see `CachedQueueNumbers`'s own doc comment). */
async function cachedQueueNumbers(
  ctx: CardServiceCtx,
  input: ReadInstanceCardInput,
): Promise<CachedQueueNumbers & { serverNow: Date }> {
  const key = tenantKey(ctx.env, input.clientId, 'instance-card-queue', input.instanceId);
  const serverNow = new Date();

  try {
    const cached = await ctx.redis.get(key);
    if (cached) {
      return { ...(JSON.parse(cached) as CachedQueueNumbers), serverNow };
    }
  } catch {
    // Redis down/unreachable - fall through to a direct compute below
    // (rebuildable cache, never a card failure).
  }

  const [depth, oldest] = await Promise.all([
    computeQueueDepth(ctx.tenantDb, input),
    computeOldestQueued(ctx.tenantDb, input),
  ]);
  const combined: CachedQueueNumbers = { ...depth, ...oldest };

  try {
    await ctx.redis.set(key, JSON.stringify(combined), 'EX', QUEUE_CACHE_TTL_SEC);
  } catch {
    // Cache write failure is never fatal - the numbers are still returned.
  }

  return { ...combined, serverNow };
}

function warmupDayFrom(warmupTierSince: Date | null, now: Date): number {
  if (!warmupTierSince) return 0;
  const wholeDays = Math.floor((now.getTime() - warmupTierSince.getTime()) / (24 * 60 * 60 * 1000));
  return wholeDays + 1;
}

function healthBandUpper(band: string): 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'CRITICAL' {
  const upper = band.toUpperCase();
  if (upper === 'HEALTHY' || upper === 'WATCH' || upper === 'DEGRADED' || upper === 'CRITICAL') {
    return upper;
  }
  return 'HEALTHY';
}

/**
 * Reads the full instance card. `nextSendEarliestAt` is NULL whenever the
 * instance is not `connected` OR is parked (`desired_state = 'offline'`) -
 * the countdown is a floor, never a promise, and a paused/parked/logged-out
 * number renders STATE, not a ticking number (task binding fact).
 */
export async function readInstanceCard(
  ctx: CardServiceCtx,
  input: ReadInstanceCardInput,
): Promise<InstanceCardData> {
  const query = await loadQuery('instance-card');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
  });
  const result = await ctx.tenantDb.withTenant(input.clientId, (tx) =>
    tx.query<InstanceCardRow>(query.text, params),
  );
  const row = result.rows[0];
  if (!row) {
    throw new InstanceCardNotFoundError();
  }

  const [queueNumbers, usage] = await Promise.all([
    cachedQueueNumbers(ctx, input),
    computeUsage(ctx.tenantDb, input),
  ]);

  const parked = row.desired_state === 'offline';
  const eligibleForCountdown = row.health_state === 'connected' && row.desired_state !== 'offline';

  return {
    instanceId: row.instance_id,
    label: row.label ?? '',
    linkState: row.link_state as InstanceCardData['linkState'],
    healthState: row.health_state as InstanceCardData['healthState'],
    desiredState: row.desired_state as InstanceCardData['desiredState'],
    parked,
    needsUserAction: row.needs_user_action,
    userActionReason: row.user_action_reason,
    healthScore: row.health_score === null ? null : Number(row.health_score),
    healthBand: healthBandUpper(row.health_band),
    warmupTier: row.warmup_tier,
    warmupDay: warmupDayFrom(row.warmup_tier_since, queueNumbers.serverNow),
    todaySent: usage.todaySent,
    effDailyCap: row.eff_daily_cap,
    newConversationsToday: usage.newConversationsToday,
    effNewConvCap: row.eff_new_conv_cap,
    sendingWindow: {
      start: row.eff_window_start_local,
      end: row.eff_window_end_local,
      tz: row.pacing_timezone,
    },
    lastSendAt: row.last_send_at ? row.last_send_at.toISOString() : null,
    queueDepth: queueNumbers.queueDepth,
    queueDepthCapped: queueNumbers.queueDepthCapped,
    oldestQueuedAgeSeconds: queueNumbers.oldestQueuedAgeSeconds,
    nextSendEarliestAt:
      eligibleForCountdown && usage.nextEligibleAt ? usage.nextEligibleAt.toISOString() : null,
    serverNow: queueNumbers.serverNow.toISOString(),
  };
}
