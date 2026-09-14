import type { TenantQueryable } from '@wp/db';
import { assertIdsOnly, coalesceKeyFor, REALTIME_PAYLOAD_KEYS } from '@wp/domain';
import type { RealtimePayloadEventType } from '@wp/domain';

/**
 * modules/events/emit.ts (P15 U2, step 4) - the ONE way a business
 * transaction writes an outbox row (ADR 0010: "Business change + outbox row
 * commit in one transaction ... Nothing is ever published from inside a
 * business transaction"). `emit` inserts exactly one row on the CALLER's
 * own transaction handle (`tx`, a `TenantQueryable` - same handle
 * `TenantDb.withTenant`'s callback already receives, see `db/src/tenant-db.ts`)
 * and returns. It never opens a connection, never begins/commits/rolls back
 * anything itself, and never calls a publisher/hub/socket - the relay
 * (`roles/relay.ts`, a later unit) is the only process that ever reads an
 * unpublished row and calls `hub.publish`. `scripts/check-no-direct-publish.ts`
 * is the mechanical enforcement of that split.
 *
 * `instance.qr` is REJECTED unconditionally: a QR is a bearer credential
 * (see `@wp/contracts`'s `instanceQrEventSchema` doc comment) and must never
 * be stored, logged, or coalesced - it keeps its existing direct
 * worker->redis-bridge leg (`modules/realtime/redis-bridge.ts`), never the
 * outbox.
 *
 * Fields validated at this boundary, before any SQL is built (the DB CHECKs
 * in migration 0041/0048 are the storage-layer authority; this is a typed
 * error FIRST, not a substitute for them):
 *   - `fanout` is a non-empty subset of {sse, webhook, email} (migration 0048,
 *     P17 U3 step 3, widened the DB CHECK to add 'email' - the notifications
 *     module's own `notify()`/`db/queries/notify-fanout.sql` is the only
 *     caller expected to actually use 'email' in practice, but `emit()`
 *     itself stays a generic outbox writer and does not special-case which
 *     event types may use which channel).
 *   - `payload` is ids/enums only for any event type this module recognises
 *     as an SSE-payload event (`REALTIME_PAYLOAD_KEYS`, reusing the exact
 *     allow-list `modules/realtime/hub.ts` already enforces on direct
 *     publish) - the same PII gate applies whether an event reaches the
 *     client via the old direct hub path or the new outbox path.
 *   - `coalesce_key`, when omitted and `fanout` includes `sse`, is DERIVED
 *     via `coalesceKeyFor` for any event type that function recognises
 *     (never invented ad hoc here) - a caller may also pass one explicitly
 *     to override the derivation for a shape `coalesceKeyFor` does not yet
 *     know (e.g. a future event family this module has not been extended
 *     for). If neither an explicit key nor a derivable one exists, this is a
 *     typed rejection here rather than a CHECK violation surfacing deep in
 *     the caller's transaction.
 */

export interface EmitInput {
  clientId: string;
  instanceId?: string;
  type: string;
  entityId: string;
  payload: Record<string, unknown>;
  fanout: readonly ('sse' | 'webhook' | 'email')[];
  /** Explicit override - see the module doc comment above. Omit to let `coalesceKeyFor` derive it. */
  coalesceKey?: string;
}

const FANOUT_VALUES = new Set(['sse', 'webhook', 'email']);

function resolveCoalesceKey(input: EmitInput): string | null {
  if (input.coalesceKey !== undefined) {
    return input.coalesceKey;
  }

  if (!input.fanout.includes('sse')) {
    return null;
  }

  // sse fanout with no explicit key: derive it, or fail loudly - never
  // silently write a NULL coalesce_key for an sse-fanned row (migration
  // 0041's own CHECK would reject that anyway; failing here gives the
  // caller a typed error instead of a raw constraint-violation).
  return coalesceKeyFor({
    type: input.type,
    instanceId: input.instanceId,
    entityId: input.entityId,
  });
}

/** Inserts one `outbox_events` row on `tx`. Never opens a connection, never publishes. */
export async function emit(tx: TenantQueryable, input: EmitInput): Promise<void> {
  if (input.type === 'instance.qr') {
    throw new Error('emit: "instance.qr" is a bearer credential and never enters the outbox');
  }

  if (input.fanout.length === 0) {
    throw new Error('emit: fanout must be a non-empty subset of {sse, webhook}');
  }

  for (const value of input.fanout) {
    if (!FANOUT_VALUES.has(value)) {
      throw new Error(`emit: unknown fanout value "${value}"`);
    }
  }

  const allowedKeys = REALTIME_PAYLOAD_KEYS[input.type as RealtimePayloadEventType] as
    readonly string[] | undefined;
  if (allowedKeys !== undefined) {
    assertIdsOnly(input.payload, allowedKeys, input.type);
  }

  const coalesceKey = resolveCoalesceKey(input);

  await tx.query(
    `INSERT INTO outbox_events
       (client_id, instance_id, event_type, entity_id, payload, coalesce_key, fanout)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     -- client_id = $1`,
    [
      input.clientId,
      input.instanceId ?? null,
      input.type,
      input.entityId,
      JSON.stringify(input.payload),
      coalesceKey,
      input.fanout,
    ],
  );

  // P15 U4 (step 5) - relay wake HINT ONLY (ADR 0010: "correctness never
  // depends on NOTIFY" - the relay's 1s poll floor is the actual
  // correctness mechanism; this is a latency optimisation). `pg_notify`
  // fires only on COMMIT of the caller's own transaction (Postgres
  // semantics), so a caller that rolls back after this point publishes no
  // wake either - same "nothing happens until the business transaction
  // commits" guarantee the row insert above already carries (see
  // `a_rolled_back_business_transaction_publishes_no_event`, extended to
  // also prove no NOTIFY fires). Empty payload: the wake carries no data at
  // all, the relay always re-queries `outbox_events` itself - never treat a
  // notification payload as authoritative.
  await tx.query(`SELECT pg_notify('wp_outbox_wake', '')`);
}
