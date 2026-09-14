import { createHash } from 'node:crypto';
import type { TenantQueryable } from '@wp/db';
import * as identityRepoDefault from './identity.repo.js';

/**
 * verify-email.service.ts (P04a Unit A5a) - consumes an
 * `email_verification_tokens` row. Idempotency lives entirely at the
 * storage layer (core invariant 3): `identityRepo.consumeEmailVerificationToken`
 * is a single conditional `UPDATE ... RETURNING`, never a check-then-write -
 * a replay or an expired token both yield zero rows, which this service
 * turns into the SAME generic typed error (never revealing whether the
 * token ever existed - same "no existence oracle" shape as
 * signup.service.ts's `SignupConflictError`).
 */

export class InvalidVerificationTokenError extends Error {
  readonly code = 'INVALID_TOKEN';

  constructor() {
    super('This verification link is invalid or has expired.');
    this.name = 'InvalidVerificationTokenError';
  }
}

export interface VerifyEmailDbClient extends TenantQueryable {
  release(err?: unknown): void;
}

export interface VerifyEmailDbPool {
  connect(): Promise<VerifyEmailDbClient>;
}

type IdentityRepo = typeof identityRepoDefault;

export interface VerifyEmailCtx {
  pool: VerifyEmailDbPool;
  now?: () => Date;
  /** Test-double injection point - never used in production wiring. */
  identityRepo?: Partial<IdentityRepo>;
}

export interface VerifyEmailResult {
  userId: string;
}

/**
 * `rawToken` is the hex string carried in the verify URL (see
 * signup.service.ts's `rawToken.toString('hex')`) - hashed back to the raw
 * bytes it was generated from before the lookup, exactly mirroring how the
 * token was stored at signup time.
 */
export async function verifyEmail(
  ctx: VerifyEmailCtx,
  rawToken: string,
): Promise<VerifyEmailResult> {
  const identityRepo: IdentityRepo = { ...identityRepoDefault, ...ctx.identityRepo };
  const now = ctx.now ?? (() => new Date());
  const tokenHash = createHash('sha256').update(Buffer.from(rawToken, 'hex')).digest();

  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    const verifiedAt = now();
    const userId = await identityRepo.consumeEmailVerificationToken(client, tokenHash, verifiedAt);
    if (!userId) {
      await client.query('ROLLBACK');
      throw new InvalidVerificationTokenError();
    }

    await identityRepo.setEmailVerifiedAt(client, userId, verifiedAt);

    // FIX 1 (P04a FIXA C1 review): the onboarding-step UPDATE touches
    // `clients`, an RLS-protected tenant table - resolve the owning client
    // (bypasses RLS via the wp_client_id_for_user SECURITY DEFINER helper,
    // migration 0015) and set the app.client_id GUC before it, or the
    // UPDATE matches zero rows under wp_app with no GUC set (a silent
    // no-op, not the loud failure it should be).
    const clientId = await identityRepo.findClientIdForUser(client, userId);
    if (clientId) {
      await identityRepo.setAppClientId(client, clientId);

      // P04b Unit UB1a, task 5: activates the client (pending_verification ->
      // active) in the SAME transaction as the onboarding-step advance below -
      // conditional on the current status (fail-safe: a suspended/closed
      // client is never resurrected). A `false` result is never an error
      // here (already-active replay or a suspended/closed client are both
      // fine outcomes - see activateClientIfPending's doc comment).
      await identityRepo.activateClientIfPending(client, clientId);

      const advanced = await identityRepo.advanceOnboardingStepAfterEmailVerification(
        client,
        clientId,
      );
      if (!advanced) {
        // Zero rows: either a benign replay (the client already moved past
        // verify_email - idempotent, fine) or a genuine, unexpected failure
        // (permission/RLS denial) - distinguished by re-checking the
        // client's CURRENT step in the same transaction, never assumed.
        const currentStep = await identityRepo.getClientOnboardingStep(client, clientId);
        if (currentStep === 'verify_email') {
          throw new Error(
            `verify-email: failed to advance onboarding_step for client ${clientId} (still on verify_email)`,
          );
        }
      }
    }

    await client.query('COMMIT');

    return { userId };
  } catch (err) {
    if (!(err instanceof InvalidVerificationTokenError)) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is what must propagate, not a rollback failure.
      }
    }
    throw err;
  } finally {
    client.release();
  }
}
