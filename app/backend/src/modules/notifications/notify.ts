import { randomUUID, createHash } from 'node:crypto';
import { loadQuery, bindQueryParams } from '@wp/db';
import type { TenantQueryable } from '@wp/db';
import {
  NOTIFICATION_KIND_REGISTRY,
  notificationDedupeKeyInput,
  coalesceKeyFor,
  type NotificationKind,
} from '@wp/domain';
import { bindNotificationMetrics } from '../../platform/metrics/notification-metrics.js';

/**
 * modules/notifications/notify.ts (P17 U3, step 3) - the ONE way any
 * business transaction (or background evaluator) writes a `notifications`
 * row plus its per-channel outbox fan-out, in ONE SQL round-trip
 * (`db/queries/notify-fanout.sql`). Signature takes the CALLER's own
 * transaction handle FIRST - there is no overload that opens its own
 * transaction (mirrors `emit()`'s exact discipline, `modules/events/emit.ts`):
 * a pause/health/reconciler/etc caller runs this INSIDE the same
 * `withTenant`/business transaction that just changed the underlying state,
 * so a rollback of that transaction rolls this write back too (core
 * invariant 1 - durable-first - and invariant 3 - idempotency at the storage
 * layer, never an in-memory pre-check).
 *
 * DEDUPE (core invariant 3): `notifications_dedupe_uq (client_id,
 * dedupe_key)` (migration 0048) is the sole dedupe authority - this function
 * never pre-checks with a SELECT, it always attempts the INSERT and reads
 * `ON CONFLICT ... DO NOTHING RETURNING`'s row count. `dedupeKey` is
 * `sha256(notificationDedupeKeyInput(...))` hex - `@wp/domain` owns the pure
 * canonical string (browser-safe, no `node:crypto` - see `dedupe-key.ts`'s
 * own header), this file is the one place that wraps it with the digest,
 * mirroring `engine/queue/content-hash.ts#computeContentHash`'s exact split.
 *
 * PII BOUNDARY: `payload` is ids/enums/counts ONLY, matching the DB's own
 * `notifications_payload_size` CHECK (<=2048 bytes) and the outbox row's
 * ids-only `{notificationId, kind, severity, instanceId}` shape
 * (`REALTIME_PAYLOAD_KEYS['notification.created']`) - never a message body,
 * phone number, or other tenant PII. This function does not itself validate
 * `input.payload`'s SHAPE beyond a cheap size pre-filter (`MAX_PAYLOAD_BYTES`'s
 * own doc comment - the DB CHECK remains the one authority, the pre-filter
 * is a fast common-case catch, never a guarantee); the caller owns its own
 * kind-specific payload shape. Documented here as the boundary so a future
 * caller does not treat this column as a place to carry anything else.
 */

export interface NotifyInput {
  clientId: string;
  instanceId?: string;
  kind: NotificationKind;
  /** Transition identity - a pause/pacing_events/job id, NEVER a wall-clock value. See `@wp/domain`'s `notificationDedupeKeyInput` doc comment for the full contract. */
  transitionId: string;
  /** Only for `dedupeScope: 'instance-day'` kinds (`plan_cap_reached`) - the tenant-local date bucket. Also carries `group_forbidden`'s own enable-cycle bucket - the pre-disable `send_enabled_at` (ISO string), or `'never'` (`on-forbidden.ts`'s own doc). */
  bucket?: string;
  payload: Record<string, unknown>;
  requiresUserAction?: boolean;
}

export type NotifyResult = { created: true; id: string } | { created: false; reason: 'deduped' };

/**
 * A CHEAP PRE-FILTER, NOT an exact match for the DB CHECK (coordinator
 * correction, WARNING): `notifications_payload_size` (migration 0048) is
 * `pg_column_size(payload)` - jsonb's own BINARY on-disk representation,
 * which carries per-key/per-value encoding overhead and is USUALLY LARGER
 * than `Buffer.byteLength(JSON.stringify(payload))` (this function's own
 * cheap UTF-8-text-length check). The two are never guaranteed to agree - a
 * payload with many short keys can pass this JS check and still trip the DB
 * CHECK. This constant is set well BELOW the DB's 2048-byte bound (a safe
 * margin, not a claimed exact match) precisely so it catches the common
 * case early without pretending to be authoritative: the DB CHECK is the
 * ONE authority for "is this payload too large", and every caller's own
 * SAVEPOINT (`reconciler.ts#notifyUnresolvedSendSafe`,
 * `hard-signal-pause.ts`'s own notify call) is the backstop for whatever
 * this pre-filter misses - a boundary payload that passes here but still
 * violates the DB CHECK rolls back to the savepoint and the caller's own
 * write still commits, exactly as if this pre-filter had never fired at all.
 */
const MAX_PAYLOAD_BYTES = 1536;

/**
 * Typed pre-SQL validation error (P17 fix round F5) - thrown by the cheap
 * pre-filter above, BEFORE any `tx.query` call, so the common oversized-
 * payload case never even reaches the database. NOT a guarantee that every
 * oversized payload is caught here - see `MAX_PAYLOAD_BYTES`'s own doc
 * comment for the DB CHECK / SAVEPOINT backstop that catches the rest.
 */
export class NotifyPayloadTooLargeError extends Error {
  readonly code = 'NOTIFY_PAYLOAD_TOO_LARGE';
  constructor(byteLength: number) {
    super(
      `notify: payload is ${String(byteLength)} bytes, exceeds the notifications_payload_size ` +
        `CHECK bound of ${String(MAX_PAYLOAD_BYTES)} bytes (migration 0048)`,
    );
    this.name = 'NotifyPayloadTooLargeError';
  }
}

function isTenantQueryable(tx: unknown): tx is TenantQueryable {
  return (
    typeof tx === 'object' &&
    tx !== null &&
    'query' in tx &&
    typeof (tx as { query: unknown }).query === 'function'
  );
}

/** `sha256(notificationDedupeKeyInput(...))` hex - see this module's own header. */
export function buildNotificationDedupeKey(input: {
  kind: NotificationKind;
  instanceId?: string;
  transitionId: string;
  bucket?: string;
}): string {
  return createHash('sha256').update(notificationDedupeKeyInput(input), 'utf8').digest('hex');
}

interface NotifyFanoutRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  entity_id: string;
  fanout: string[];
}

/** Runs `notify()` on `tx` (the caller's own transaction handle - see module header). Throws a typed error if `tx` is missing or not a queryable transaction handle. */
export async function notify(tx: TenantQueryable, input: NotifyInput): Promise<NotifyResult> {
  if (!isTenantQueryable(tx)) {
    throw new Error(
      "notify: requires the caller's own transaction handle (a TenantQueryable) - there is no overload that opens its own transaction",
    );
  }

  const serializedPayload = JSON.stringify(input.payload);
  const payloadByteLength = Buffer.byteLength(serializedPayload, 'utf8');
  if (payloadByteLength > MAX_PAYLOAD_BYTES) {
    throw new NotifyPayloadTooLargeError(payloadByteLength);
  }

  const entry = NOTIFICATION_KIND_REGISTRY[input.kind];
  const dedupeKey = buildNotificationDedupeKey({
    kind: input.kind,
    instanceId: input.instanceId,
    transitionId: input.transitionId,
    bucket: input.bucket,
  });

  const notificationId = randomUUID();
  const sseCoalesceKey = entry.channels.includes('sse')
    ? coalesceKeyFor({ type: 'notification.created', entityId: notificationId })
    : null;

  const query = await loadQuery('notify-fanout');
  const params = bindQueryParams(query, {
    id: notificationId,
    client_id: input.clientId,
    instance_id: input.instanceId ?? null,
    kind: input.kind,
    severity: entry.severity,
    dedupe_key: dedupeKey,
    payload: serializedPayload,
    requires_user_action: input.requiresUserAction ?? false,
    channels: entry.channels,
    sse_coalesce_key: sseCoalesceKey,
  });

  const result = await tx.query<NotifyFanoutRow>(query.text, params);

  const metrics = bindNotificationMetrics();

  if (result.rows.length === 0) {
    metrics.incrementDeduped(input.kind);
    return { created: false, reason: 'deduped' };
  }

  for (const row of result.rows) {
    for (const channel of row.fanout) {
      metrics.incrementNotifications(input.kind, channel);
    }
  }

  return { created: true, id: notificationId };
}
