import type { Redis } from 'ioredis';
import type { NotificationKind } from '@wp/domain';
import { createEmailDispatchPort, CAP_WINDOW_SECONDS, type EmailCapCounter } from './email.js';
import type { EmailFanoutPort, ClaimedEmailRow } from '../../events/index.js';
import { createMailer, type Mailer } from '../../../platform/mailer.js';

/**
 * dispatch/relay-email-fanout.ts (P17 U3, step 4; P17 fix round F1, CORRECTED
 * after re-review - CRITICAL; moved here from `roles/` at P17 close:
 * check-role-boot treats every file under `src/roles/` as a role entrypoint,
 * and this is wiring, not an entrypoint) - `roles/relay.ts`'s production
 * wiring for the notifications email leg. Adapts `dispatch/email.ts`'s
 * `EmailDispatchPort` (keyed on `NotificationEmailRow`) to `relay-loop.ts`'s
 * own `EmailFanoutPort` (keyed on `ClaimedEmailRow`).
 *
 * TX AROUND `resolve` ONLY, THEN RELEASE, THEN `send` WITH NO CONNECTION
 * HELD (the actual fix - the first F1 attempt wrapped the WHOLE dispatch,
 * including every SMTP round-trip, in one `BEGIN`/`SET LOCAL ROLE wp_relay`/
 * `COMMIT` on a pinned connection - a batch with a slow/unreachable mail host
 * (nodemailer's ~2min TCP timeout per row, worst case) would then pin that
 * `wp_relay` connection idle-in-transaction for the whole batch, which can
 * block `VACUUM` on `outbox_events`/`notifications`). `dispatchEmails`
 * receives the whole pool (relay-loop.ts's own doc comment: called AFTER the
 * tick's own transaction has committed): it opens a SHORT-LIVED connection,
 * wraps ONLY `resolve`'s two read-only `client.query` calls in `BEGIN`/`SET
 * LOCAL ROLE wp_relay`/`COMMIT` (never a bare session-level `SET ROLE` -
 * `wp/no-plain-set` bans that outright), COMMITS, and RELEASES the connection
 * back to the pool BEFORE `send` (the actual SMTP calls) ever runs - so no
 * database connection is held for any part of the network I/O.
 */

/** `EmailCapCounter` backed by a real Redis - `INCR` + `EXPIRE CAP_WINDOW_SECONDS` (only on first use, so an existing counter's remaining TTL is never reset by a later increment - this hour's cap window is fixed at its FIRST send this hour, not extended by every subsequent one). `CAP_WINDOW_SECONDS` is imported from `./email.ts` (P17 fix round F4) - the ONE window constant, never duplicated as a literal here. */
export function createRedisEmailCapCounter(redis: Redis): EmailCapCounter {
  return {
    async incrementAndGet(key: string): Promise<number> {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, CAP_WINDOW_SECONDS);
      }
      return count;
    },
  };
}

/** Builds the relay's `EmailFanoutPort` - real SMTP (mailpit in dev, `platform/mailer.ts`'s existing transport) and a real Redis-backed hourly cap counter. `env` is `config.NODE_ENV` (the same env segment `redis-bridge.ts`'s own wiring already threads into `tenantKey`). `mailer` is injectable (defaults to `createMailer()`) so a test can exercise this EXACT production wiring - including the tx-around-resolve-only shape below - with a recording fake instead of real SMTP (see `relay-email-fanout-transaction-shape.test.ts`). */
export function createRelayEmailFanoutPort(
  redis: Redis,
  env: string,
  mailer: Mailer = createMailer(),
): EmailFanoutPort {
  const dispatchPort = createEmailDispatchPort({
    mailer,
    capCounter: createRedisEmailCapCounter(redis),
    env,
  });

  return {
    async dispatchEmails(pool, rows: ClaimedEmailRow[]): Promise<void> {
      if (rows.length === 0) return;
      const notificationRows = rows.map((row) => ({
        id: row.id,
        clientId: row.clientId,
        instanceId: row.instanceId,
        kind: row.kind as NotificationKind,
        payload: row.payload,
      }));

      // STEP 1: resolve ONLY, on a short-lived wp_relay-scoped transaction -
      // the connection is released (module doc) BEFORE any SMTP call.
      const client = await pool.connect();
      let releaseError: unknown;
      let resolved;
      try {
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL ROLE wp_relay');
          resolved = await dispatchPort.resolve(client, notificationRows);
          await client.query('COMMIT');
        } catch (err) {
          try {
            await client.query('ROLLBACK');
            releaseError = undefined;
          } catch (rollbackErr) {
            releaseError = rollbackErr;
          }
          throw err;
        }
      } finally {
        if (releaseError !== undefined) {
          client.release(releaseError as Error);
        } else {
          client.release();
        }
      }

      // STEP 2: send, with NO database connection/transaction held at all.
      await dispatchPort.send(resolved);
    },
  };
}
