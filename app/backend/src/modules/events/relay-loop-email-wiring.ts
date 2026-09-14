/**
 * relay-loop-email-wiring.ts (P17 U3, step 4; P17 fix round F1) - split out
 * of relay-loop.ts for the max-lines cap (that file had almost no headroom
 * left - mechanical extraction, same idiom as
 * `session-worker-discovery-wiring.ts`). Owns the EMAIL LEG's own seam:
 * `EmailFanoutPort` (structurally distinct from `WebhookFanoutPort` since the
 * F1 fix - see below) plus the pure row-filter `selectEmailRows` `drainOnce`
 * calls once per tick.
 *
 * `deps.emailFanout` is OPTIONAL and defaults to a no-op (same "every
 * pre-existing caller keeps its exact prior behaviour un-wired" discipline
 * `WebhookFanoutPort` established) - a row whose fanout includes 'email' is
 * still claimed and marked published by the ordinary drain tick even with no
 * `emailFanout` wired; it simply carries no actual email send in that case.
 *
 * NOT PINNED TO THE TICK'S TRANSACTION (F1 fix, CRITICAL): unlike
 * `WebhookFanoutPort.writeDeliveries` (which durably hands off inside the
 * SAME transaction the claim ran on), `EmailFanoutPort.dispatchEmails`
 * receives the whole `RelayPool`, not a pinned `client` - `drainOnce` calls
 * it AFTER its own `withRelayRole` transaction has already committed (see
 * `relay-loop.ts`'s own doc comment). The production implementation
 * (`modules/notifications/dispatch/relay-email-fanout.ts`) opens its OWN short-lived `wp_relay`-scoped
 * connection for its read queries (recipient/instance-label resolution needs
 * `wp_relay`'s EXECUTE grant on those SECURITY DEFINER functions, migration
 * 0049) - never a bare pool connection with no role set.
 */

export interface ClaimedEmailRow {
  id: string;
  clientId: string;
  instanceId: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

export interface EmailFanoutPort {
  /** Sends (or suppresses, per the hourly cap) one email per claimed row - see `modules/notifications/dispatch/email.ts`'s own doc comment for the full contract. Runs OUTSIDE the tick's own transaction (F1 fix, this module's own doc comment) - `pool` is `relay-loop.ts`'s own `RelayPool`, never a pinned client. Never throws (per-row isolation is this port's own contract, delegated to `dispatch/email.ts`). */
  dispatchEmails(pool: RelayPoolLike, rows: ClaimedEmailRow[]): Promise<void>;
}

/** Structural subset of `relay-loop.ts`'s own `RelayPool` (never imported back from there, which would be circular). */
export interface RelayPoolLike {
  connect(): Promise<{
    query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[]; rowCount: number | null }>;
    release(err?: unknown): void;
  }>;
}

/**
 * Runs `emailFanout.dispatchEmails` AFTER the tick's own transaction has
 * committed (F1 fix - see this module's own doc comment). A no-op when
 * either there are zero email rows this tick or no `emailFanout` is wired.
 * Swallows any throw defensively - `dispatchEmails` itself never throws
 * (per-row isolation is `dispatch/email.ts`'s own contract), but a
 * wiring-level defect in a future implementation must never take down the
 * drain loop's own timer/caller either.
 */
export async function dispatchEmailsAfterCommit(
  pool: RelayPoolLike,
  emailFanout: EmailFanoutPort | undefined,
  rows: ClaimedEmailRow[],
): Promise<void> {
  if (rows.length === 0 || !emailFanout) return;
  await emailFanout.dispatchEmails(pool, rows).catch(() => undefined);
}

interface EmailEligibleRow {
  id: string;
  client_id: string;
  instance_id: string | null;
  event_type: string;
  fanout: string[];
  payload: Record<string, unknown>;
}

/** Rows this tick whose fanout includes 'email' - `notification.created` is the only event family that ever carries this fanout member (see `db/queries/notify-fanout.sql`'s own header), so `row.event_type`/`payload.kind` always resolve together. */
export function selectEmailRows(rows: readonly EmailEligibleRow[]): ClaimedEmailRow[] {
  return rows
    .filter((row) => row.fanout.includes('email'))
    .map((row) => ({
      id: row.id,
      clientId: row.client_id,
      instanceId: row.instance_id,
      kind: String(row.payload['kind'] ?? ''),
      payload: row.payload,
    }));
}
