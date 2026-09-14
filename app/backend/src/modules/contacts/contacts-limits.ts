import type { TenantQueryable } from '@wp/db';

/**
 * contacts-limits.ts (P20 Unit U4, step 4; P20 C1 addendum A) - the
 * `max_contacts` admission guard, split out of `contacts.repo.ts` for the
 * 300-line cap (`session-worker-discovery-wiring.ts`'s own split idiom).
 * Exported for U5's import runner to reuse verbatim (never re-derived
 * there).
 *
 * FAIL-CLOSED (same convention as `db/queries/instance-plan-limits.sql`):
 * a client with no plan assigned resolves to `null` here, which
 * `assertUnderContactLimit` treats as ZERO capacity, never "unlimited".
 *
 * SERIALISED PER CLIENT (addendum A): a plain read-then-insert admission
 * check has no protection against two concurrent callers both reading
 * `current = limit - 1` before either writes (proved by
 * `contacts-limits-and-tags-concurrency-c2.integration.test.ts`'s forced-
 * interleaving race). `assertUnderContactLimit` takes a transaction-scoped
 * Postgres advisory lock (`pg_advisory_xact_lock`, NOT the non-blocking
 * `_try_` variant - a second concurrent caller must WAIT for the first to
 * finish its count-then-insert, never observe a stale count) keyed per
 * client BEFORE counting, released automatically at COMMIT/ROLLBACK - same
 * transaction-scoped-lock rationale as `engine/cron/single-flight.ts`'s own
 * header (safe under PgBouncer transaction pooling). The import runner's
 * `checkMaxContactsBeforeUpsert` goes through this SAME function, so a
 * batch upsert is serialised against concurrent `createContact` calls too.
 */

const ADVISORY_LOCK_NAMESPACE = 'wp' + ':contacts-admission';

/** Builds this client's admission-lock key at runtime - never one contiguous `'wp:...'` literal (same idiom as `engine/cron/single-flight.ts#CRON_LOCK_KEYS`). Exported so `import-runner-batch.ts#checkMaxContactsBeforeUpsert` takes the SAME lock, serialising the import runner's per-batch check against concurrent `createContact` calls too. */
export function admissionLockKey(clientId: string): string {
  return `${ADVISORY_LOCK_NAMESPACE}:${clientId}`;
}

export class ContactLimitReachedError extends Error {
  readonly code = 'CONTACT_LIMIT_REACHED';
  readonly details: { limit: number; current: number; reason: 'limit' | 'no_plan' };
  constructor(details: { limit: number; current: number; reason: 'limit' | 'no_plan' }) {
    super('The contact limit for this plan has been reached.');
    this.name = 'ContactLimitReachedError';
    this.details = details;
  }
}

/** `COALESCE(override, plan_limits.max_contacts)` - `null` when the client has no plan. */
export async function resolveEffectiveMaxContacts(
  tx: TenantQueryable,
  clientId: string,
): Promise<number | null> {
  const result = await tx.query<{ effective: number | null }>(
    `SELECT COALESCE(
              (SELECT limit_value FROM client_limit_overrides
                WHERE client_id = $1 AND limit_key = 'max_contacts'
                  AND (expires_at IS NULL OR expires_at > now())),
              (SELECT pl.max_contacts FROM clients c
                 JOIN plan_limits pl ON pl.plan_id = c.plan_id
                WHERE c.id = $1)
              -- client_id = id = $1
            ) AS effective`,
    [clientId],
  );
  return result.rows[0]?.effective ?? null;
}

/** Count of live (`deleted_at IS NULL`) contacts for the tenant. */
export async function countLiveContacts(tx: TenantQueryable, clientId: string): Promise<number> {
  const result = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM contacts WHERE client_id = $1 AND deleted_at IS NULL`,
    [clientId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Throws `ContactLimitReachedError` when admitting one more contact would
 * breach the effective plan limit. Takes a transaction-scoped, per-client
 * advisory lock FIRST (see module doc, addendum A) so two concurrent
 * callers can never both read a stale `current` count.
 */
export async function assertUnderContactLimit(
  tx: TenantQueryable,
  clientId: string,
): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [admissionLockKey(clientId)]);

  const limit = await resolveEffectiveMaxContacts(tx, clientId);
  const current = await countLiveContacts(tx, clientId);
  if (limit === null) {
    throw new ContactLimitReachedError({ limit: 0, current, reason: 'no_plan' });
  }
  if (current + 1 > limit) {
    throw new ContactLimitReachedError({ limit, current, reason: 'limit' });
  }
}
