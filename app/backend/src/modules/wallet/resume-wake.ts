import type { TenantQueryable } from '@wp/db';

/**
 * resume-wake.ts (P19 Unit U4, step 5) - `publishWakeForClient`, the
 * multi-instance fan-out wrapper over `engine/queue/wake.ts#publishWake`
 * for a credit that just moved a client's wallet out of a zero-claim state
 * (`empty|frozen -> active|low`). Exported from `modules/wallet/index.ts` so
 * P16 (instance resume)/P23 (campaign resume, unpark, plan-cap raise) reuse
 * this SAME publisher rather than forking a second one - see that module's
 * own header for the "there is no second wake publisher" rule.
 *
 * INJECTED-DEPENDENCY IDIOM (mirrors `modules/instances/resume.ts`'s
 * `ResumeInstanceDeps.publishWake` exactly): `deps.publishWake` is a single
 * `(clientId, instanceId) => Promise<void> | void` bound by the caller
 * (`roles/api.ts`) to the real `engine/queue/wake.ts#publishWake` over the
 * shared `redis-ctl` handle - this module never imports `ioredis` or
 * `platform/redis.ts` itself, and never builds a channel string (the
 * `wp/key-construction` lint rule forbids a raw `wp:` literal outside
 * `platform/redis/**` - `wakeChannel`/`publishWake` already own that).
 *
 * CALLER CONTRACT (core invariant "never hold a transaction open across a
 * Redis round trip"): `publishWakeForClient` must be called AFTER the
 * credit's own `withTenant` transaction has already committed, exactly the
 * `resume.ts:144` shape - this function opens no transaction of its own and
 * takes a plain `TenantQueryable` (a committed-scope read handle) purely to
 * list the client's instances.
 *
 * A publish failure is never thrown here: `engine/queue/wake.ts#publishWake`
 * already swallows a per-instance Redis error internally (the mandatory
 * safety poll is the backstop, per that module's own header) - this
 * function's own per-instance `try/catch` exists only to stop one
 * rejected/thrown publish call from aborting the fan-out loop for the
 * client's OTHER instances (defence in depth: `publishWake`'s contract
 * already says it never rejects, but this loop does not depend on that
 * remaining true forever). `deps.onPublishError`, if provided, is invoked
 * (never awaited) so a caller can count the failure on a metric - it is
 * never a reason to stop the loop or propagate an error to the credit path.
 */

export interface PublishWakeForClientDeps {
  /** Read handle used only to list the client's non-deleted instance ids. */
  db: TenantQueryable;
  /** `engine/queue/wake.ts#publishWake`, bound by the caller (see module doc). */
  publishWake: (clientId: string, instanceId: string) => Promise<void> | void;
  /** Optional failure counter - invoked, never awaited, never thrown from this function. */
  onPublishError?: (clientId: string, instanceId: string, err: unknown) => void;
}

interface InstanceIdRow extends Record<string, unknown> {
  id: string;
}

/**
 * Publishes one wake per non-deleted `whatsapp_instances` row belonging to
 * `clientId` - zero instances is a normal outcome (a wallet-only client with
 * no connected numbers yet) and simply publishes nothing. The instance list
 * query always carries `client_id = $1 AND deleted_at IS NULL` (tenant
 * isolation, core invariant 4).
 */
export async function publishWakeForClient(
  deps: PublishWakeForClientDeps,
  clientId: string,
): Promise<void> {
  const result = await deps.db.query<InstanceIdRow>(
    `SELECT id FROM whatsapp_instances WHERE client_id = $1 AND deleted_at IS NULL`,
    [clientId],
  );

  for (const row of result.rows) {
    try {
      await deps.publishWake(clientId, row.id);
    } catch (err) {
      deps.onPublishError?.(clientId, row.id, err);
    }
  }
}
