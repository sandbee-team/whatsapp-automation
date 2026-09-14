import type { TenantQueryable } from '@wp/db';
import type { provisioningRepo as provisioningRepoDefault } from '../tenancy/index.js';

/**
 * signup-client-insert.ts (P28 U5, split out of signup.service.ts for
 * max-lines) - the `clients` INSERT-with-one-slug-collision-retry dance.
 * Pure code motion: no behavior change from the original signup.service.ts.
 *
 * FIX 5 (P04a FIXA C1 review): a failed INSERT aborts the surrounding
 * Postgres transaction (any further statement errors 25P02 "current
 * transaction is aborted") until a ROLLBACK/ROLLBACK TO SAVEPOINT runs, so a
 * naive "retry once" attempt never actually reaches the database. A
 * SAVEPOINT scoped to just this INSERT gives the retry a real chance: on a
 * slug collision, roll back to the savepoint (undoing only the failed
 * INSERT, not the whole transaction) and try once more with a fresh suffix
 * before failing generic.
 *
 * Deliberately throws `SlugCollisionExhaustedError` (a LOCAL, lightweight
 * sentinel) rather than `signup.service.ts`'s own `SignupConflictError` -
 * that class stays defined in ITS module so this sibling never needs a
 * runtime (non-type-only) import back into signup.service.ts, which would
 * otherwise form a module-load cycle (signup.service.ts already imports
 * THIS file). `signup()` maps the sentinel to `SignupConflictError` itself.
 */

type ProvisioningRepo = typeof provisioningRepoDefault;

/** Thrown ONLY when both the original AND the retried slug both collide - `signup()` maps this to `SignupConflictError`. */
export class SlugCollisionExhaustedError extends Error {
  constructor() {
    super('Both slug attempts collided.');
    this.name = 'SlugCollisionExhaustedError';
  }
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505' &&
    (err as { constraint?: unknown }).constraint === constraint
  );
}

export interface InsertClientWithSlugRetryInput {
  clientId: string;
  companyName: string;
  ownerUserId: string;
  planId: string;
  buildSlug: () => string;
}

/**
 * Inserts one `clients` row, retrying ONCE with a fresh slug on a
 * `clients_slug_key` collision (astronomically unlikely, but the retry is a
 * real one - see the module doc comment). A second collision throws
 * `SlugCollisionExhaustedError`; any other constraint hit on either attempt
 * re-throws the raw driver error - never a silent retry loop.
 */
export async function insertClientWithSlugRetry(
  tx: TenantQueryable,
  provisioningRepo: ProvisioningRepo,
  input: InsertClientWithSlugRetryInput,
): Promise<void> {
  await tx.query('SAVEPOINT slug_try');
  try {
    await provisioningRepo.insertClient(tx, {
      id: input.clientId,
      companyName: input.companyName,
      slug: input.buildSlug(),
      ownerUserId: input.ownerUserId,
      planId: input.planId,
    });
    // S3 (P04a FIXC): release the subtransaction on the success path too -
    // otherwise it stays open (and its snapshot pinned) for every remaining
    // write in this transaction, not just the one INSERT it was scoped to
    // protect.
    await tx.query('RELEASE SAVEPOINT slug_try');
  } catch (err) {
    if (!isUniqueViolation(err, 'clients_slug_key')) {
      throw err;
    }
    // Astronomically-unlikely slug collision - retry once with a fresh
    // suffix inside this same transaction attempt, then fail generic.
    await tx.query('ROLLBACK TO SAVEPOINT slug_try');
    try {
      await provisioningRepo.insertClient(tx, {
        id: input.clientId,
        companyName: input.companyName,
        slug: input.buildSlug(),
        ownerUserId: input.ownerUserId,
        planId: input.planId,
      });
      await tx.query('RELEASE SAVEPOINT slug_try');
    } catch (retryErr) {
      if (isUniqueViolation(retryErr, 'clients_slug_key')) {
        throw new SlugCollisionExhaustedError();
      }
      throw retryErr;
    }
  }
}
