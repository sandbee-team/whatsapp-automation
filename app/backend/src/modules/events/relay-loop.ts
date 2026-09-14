import { loadQuery, bindQueryParams } from '@wp/db';
import type { BatchFrame } from '@wp/contracts';
import { OUTBOX_EPHEMERAL_TOPICS } from '@wp/domain';
import { coalesceOutboxRows } from './coalescer.js';
import {
  splitPoisonRows,
  POISON_SUPPRESSED_BY_SENTINEL,
  type PoisonableRow,
} from './relay-loop-poison.js';
import {
  selectEmailRows,
  dispatchEmailsAfterCommit,
  type EmailFanoutPort,
} from './relay-loop-email-wiring.js';
import { withRelayRole } from './relay-loop-role.js';

export type { EmailFanoutPort, ClaimedEmailRow } from './relay-loop-email-wiring.js';

/**
 * modules/events/relay-loop.ts (P15 U4, step 5) - `ROLE=relay`'s DB-driving
 * drain tick. One call to `drainOnce` is one tick: claim (up to `limit`,
 * default 500) unpublished `outbox_events` rows as `wp_relay` (BYPASSRLS,
 * migration 0041), apply backpressure, coalesce the sse-fanned rows
 * (`coalescer.ts`), publish one `BatchFrame` per `(client_id, instance_id)`
 * group through the injected `BatchPublisherPort`, and mark every claimed
 * row `published_at`/`suppressed_by` in the SAME transaction the claim ran
 * in (so a crash between "claimed" and "marked" simply leaves the row
 * unpublished for the next tick to reclaim - see
 * `a_crash_between_dispatch_and_mark_republishes_and_the_receiver_dedupes`).
 *
 * WEBHOOK-FANNED ROWS ARE NEVER COALESCED (ADR 0010 / phase task, verbatim).
 * This module does not own `modules/webhooks/**` - a webhook-fanned row is
 * claimed and marked published by THIS loop like any other row, but its
 * actual HTTP dispatch is deliberately out of scope here: `secondaryLoops`
 * (`roles/relay.ts`) is where the webhook dispatcher's own loop plugs in,
 * reading the same rows via its own claim (a separate durable table).
 *
 * BACKPRESSURE (ADR 0010): when the tick's TOTAL unpublished depth (a cheap
 * `COUNT(*) WHERE published_at IS NULL`, read once per tick) exceeds
 * `backpressureDepthThreshold` (injectable, default 50_000), every claimed
 * row whose `event_type` is in `OUTBOX_EPHEMERAL_TOPICS` is marked published
 * with NO frame emitted (a silent drop, counted via
 * `wp_outbox_dropped_total{topic_class}`) instead of being coalesced/
 * published normally. `message.job.*`, `chat.*`, `instance.health_changed`,
 * and every webhook-fanned row are NEVER eligible, regardless of depth
 * (checked by `event_type` membership, never by fanout alone).
 */

/**
 * WEBHOOK FANOUT SEAM (P15 U5, step 7) - keeps this module free of any
 * `modules/webhooks/**` import while `drainOnce` still writes the durable
 * `webhook_deliveries` handoff row IN THE SAME TRANSACTION as the
 * mark-published UPDATE. `writeDeliveries` receives the SAME pinned,
 * `wp_relay`-scoped `client` this tick already runs on; `deps.webhookFanout`
 * is OPTIONAL, defaulting to a no-op.
 */
export interface WebhookFanoutPort {
  writeDeliveries(client: RelayPoolClient, rows: ClaimedWebhookRow[]): Promise<void>;
}

export interface ClaimedWebhookRow {
  outboxEventId: string;
  clientId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface BatchPublisherPort {
  /** Publishes one already-coalesced batch frame for `(clientId, instanceId)`. Never throws on a transport failure (same "fire and forget, counted not thrown" discipline as `redis-bridge.ts`'s own `publish`) - production wiring is the redis bridge's `publishBatch`; tests inject a recording stub. */
  publishBatch(
    clientId: string,
    instanceId: string | null,
    frame: BatchFrame,
  ): void | Promise<void>;
}

export interface RelayMetricsPort {
  setOutboxDepth: (depth: number) => void;
  observePublishLagSeconds: (seconds: number) => void;
  incrementEventsPublished: (fanout: 'sse' | 'webhook') => void;
  incrementSseCoalesced: (count: number) => void;
  incrementDropped: (topicClass: string, count: number) => void;
  /** P15 C1 FIX F2 / CRIT-3 - see `relay-loop-poison.ts`'s own doc comment. */
  incrementPoisoned: (topicClass: string, count: number) => void;
}

export interface RelayPoolClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  release(err?: unknown): void;
}

export interface RelayPool {
  connect(): Promise<RelayPoolClient>;
}

export interface RelayLoopDeps {
  pool: RelayPool;
  publisher: BatchPublisherPort;
  metrics: RelayMetricsPort;
  /** Injected wall clock - `now().getTime()` feeds publish-lag observation. Never `Date.now()` directly (determinism under test). */
  clock: { now: () => Date };
  /** Bounded per-tick claim size - defaults to 500 (ADR 0010 / phase task). */
  limit?: number;
  /** Depth threshold above which ephemeral topics are dropped - defaults to 50_000 (ADR 0010). Injectable so tests never depend on actually inserting 50,001 rows. */
  backpressureDepthThreshold?: number;
  /** Optional - see `WebhookFanoutPort`'s own doc comment. Defaults to a no-op (pre-P15-U5 behaviour: webhook-fanned rows are marked published with no durable delivery handoff). */
  webhookFanout?: WebhookFanoutPort;
  /** Optional - see `relay-loop-email-wiring.ts`'s own doc comment (P17 U3, step 4). Defaults to a no-op: an email-fanned row is still claimed/marked published, just with no actual send. */
  emailFanout?: EmailFanoutPort;
}

export const DEFAULT_RELAY_CLAIM_LIMIT = 500;
export const DEFAULT_BACKPRESSURE_DEPTH_THRESHOLD = 50_000;

const EPHEMERAL_TOPIC_SET: ReadonlySet<string> = new Set(OUTBOX_EPHEMERAL_TOPICS);

interface ClaimedRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  instance_id: string | null;
  event_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  coalesce_key: string | null;
  fanout: ('sse' | 'webhook' | 'email')[];
  attempts: number;
  created_at: Date;
}

/** One tick's return shape: the claimed-row count (existing observability contract) plus the email rows this tick marked published, still pending their POST-COMMIT dispatch (F1 fix - see `drainOnce`'s own doc comment). */
interface DrainTickResult {
  claimedCount: number;
  emailRowsToDispatch: ReturnType<typeof selectEmailRows>;
}

/**
 * Runs one drain tick (email leg OUT of the transaction - P17 fix round F1,
 * CRITICAL: see `relay-loop-email-wiring.ts#dispatchEmailsAfterCommit`'s own
 * doc comment - one bad SMTP send must never roll back the SAME tick's
 * sse/webhook work or pin a PG connection for an SMTP timeout). Zero claimed
 * rows is a normal outcome (no-op). Returns the number of rows claimed this
 * tick (test/observability convenience).
 */
export async function drainOnce(deps: RelayLoopDeps): Promise<number> {
  const { claimedCount, emailRowsToDispatch } = await runDrainTickTransaction(deps);
  await dispatchEmailsAfterCommit(deps.pool, deps.emailFanout, emailRowsToDispatch);
  return claimedCount;
}

async function runDrainTickTransaction(deps: RelayLoopDeps): Promise<DrainTickResult> {
  const limit = deps.limit ?? DEFAULT_RELAY_CLAIM_LIMIT;
  const backpressureDepthThreshold =
    deps.backpressureDepthThreshold ?? DEFAULT_BACKPRESSURE_DEPTH_THRESHOLD;

  return withRelayRole(deps.pool, async (client) => {
    const query = await loadQuery('claim-outbox');
    const params = bindQueryParams(query, { limit });
    const claimed = await client.query<ClaimedRow>(query.text, params);

    if (claimed.rows.length === 0) {
      return { claimedCount: 0, emailRowsToDispatch: [] };
    }

    const depthResult = await client.query<{ depth: string }>(
      'SELECT count(*)::text AS depth FROM outbox_events WHERE published_at IS NULL',
    );
    const depth = Number(depthResult.rows[0]?.depth ?? '0');
    deps.metrics.setOutboxDepth(depth);
    const overBackpressure = depth > backpressureDepthThreshold;

    const now = deps.clock.now();
    const toMarkPublished: string[] = [];
    const toMarkSuppressed: [suppressed: string, winner: string][] = [];
    const toMarkDropped: string[] = [];

    const webhookRows = claimed.rows.filter((row) => row.fanout.includes('webhook'));
    // A row fanned to BOTH sse and webhook must never be dropped just
    // because its sse leg is ephemeral - only sse-ONLY rows are droppable.
    const sseOnlyDroppableCandidates = claimed.rows.filter(
      (row) =>
        row.fanout.includes('sse') &&
        !row.fanout.includes('webhook') &&
        overBackpressure &&
        EPHEMERAL_TOPIC_SET.has(row.event_type),
    );
    const droppableIds = new Set(sseOnlyDroppableCandidates.map((row) => row.id));

    for (const row of sseOnlyDroppableCandidates) {
      toMarkDropped.push(row.id);
      deps.metrics.incrementDropped(row.event_type, 1);
    }

    const sseRowsToCoalesce = claimed.rows.filter(
      (row) => row.fanout.includes('sse') && !droppableIds.has(row.id),
    );

    // Per-row isolation for a malformed row - see `relay-loop-poison.ts`'s
    // own doc comment. A row that fails to parse never reaches the
    // coalescer; it is left unpublished with a bumped `attempts` (retried
    // next tick) or, past the ceiling, quarantined (published,
    // `suppressed_by` = the sentinel).
    const poisonResult: PoisonableRow[] = sseRowsToCoalesce;
    const { parsed, toBumpAttempts, toQuarantine } = splitPoisonRows(poisonResult, deps.metrics);

    const groups = coalesceOutboxRows(parsed);
    for (const group of groups) {
      toMarkPublished.push(...group.winnerIds);
      toMarkSuppressed.push(...group.suppressedIds);
      await deps.publisher.publishBatch(group.clientId, group.instanceId, group.frame);
      deps.metrics.incrementEventsPublished('sse');
      if (group.suppressedIds.length > 0) {
        deps.metrics.incrementSseCoalesced(group.suppressedIds.length);
      }
    }

    if (webhookRows.length > 0 && deps.webhookFanout) {
      // Durable handoff FIRST, same transaction as the mark-published UPDATE
      // below (see `WebhookFanoutPort`'s own doc comment) - a crash after
      // this call but before COMMIT rolls the whole tick back, so the outbox
      // row stays unpublished for the next tick to reclaim rather than ever
      // being published with a missing delivery row.
      await deps.webhookFanout.writeDeliveries(
        client,
        webhookRows.map((row) => ({
          outboxEventId: row.id,
          clientId: row.client_id,
          eventType: row.event_type,
          payload: row.payload,
        })),
      );
    }

    for (const row of webhookRows) {
      toMarkPublished.push(row.id);
      deps.metrics.incrementEventsPublished('webhook');
    }

    // EMAIL LEG (P17 U3, step 4, relay-loop-email-wiring.ts; F1 fix - never
    // dispatched IN this transaction, only claimed/marked published here -
    // see `drainOnce`'s own doc comment for the post-commit dispatch call).
    const emailRows = selectEmailRows(claimed.rows);
    for (const row of emailRows) toMarkPublished.push(row.id);

    if (toMarkPublished.length > 0) {
      await client.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1)', [
        toMarkPublished,
      ]);
    }
    if (toMarkDropped.length > 0) {
      await client.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1)', [
        toMarkDropped,
      ]);
    }
    for (const [suppressedId, winnerId] of toMarkSuppressed) {
      await client.query(
        'UPDATE outbox_events SET published_at = now(), suppressed_by = $2 WHERE id = $1',
        [suppressedId, winnerId],
      );
    }
    if (toBumpAttempts.length > 0) {
      await client.query('UPDATE outbox_events SET attempts = attempts + 1 WHERE id = ANY($1)', [
        toBumpAttempts,
      ]);
    }
    if (toQuarantine.length > 0) {
      await client.query(
        `UPDATE outbox_events SET attempts = attempts + 1, published_at = now(), suppressed_by = $2
          WHERE id = ANY($1)`,
        [toQuarantine, POISON_SUPPRESSED_BY_SENTINEL],
      );
    }

    const oldestCreatedAt = claimed.rows.reduce<Date | undefined>(
      (oldest, row) => (oldest === undefined || row.created_at < oldest ? row.created_at : oldest),
      undefined,
    );
    if (oldestCreatedAt !== undefined) {
      deps.metrics.observePublishLagSeconds((now.getTime() - oldestCreatedAt.getTime()) / 1000);
    }

    return { claimedCount: claimed.rows.length, emailRowsToDispatch: emailRows };
  });
}
