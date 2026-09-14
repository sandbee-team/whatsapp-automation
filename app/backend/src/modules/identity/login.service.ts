import type { TenantQueryable } from '@wp/db';
import * as identityRepoDefault from './identity.repo.js';
import { hashPassword, needsRehash, verifyPassword, type Argon2Params } from './password.js';

/**
 * login.service.ts (P04a Unit A4) - the login use-case. `users` carries no
 * `client_id`/RLS (identity is global), so this runs its OWN
 * BEGIN/COMMIT/ROLLBACK against a plain pool connection instead of
 * `TenantDb.withTenant` (see identity.repo.ts's header comment on the same
 * point).
 *
 * Canon (binding, see the phase task):
 *  - Unknown email performs a DUMMY VERIFY against a precomputed hash (made
 *    once per cost-profile, at first use) and throws the SAME
 *    `AuthenticationError` as a wrong password - no shortcut path, so an
 *    attacker cannot use response timing/shape to enumerate emails.
 *  - Lockout ladder: every 5th (configurable) consecutive failure locks the
 *    account, doubling the duration each time (15m -> 30m -> 60m -> ...,
 *    capped). While locked, ANY attempt (even a correct password) is denied
 *    with `AccountLockedError`, and the failure counter is NOT incremented.
 *  - Entering lockout writes ONE audit_logs row in the SAME transaction as
 *    the counter update, and notifies the user by email AFTER commit (mail
 *    failure logged, never thrown - core invariant: a provider/mail call
 *    never happens inside a DB transaction, and never undoes committed work).
 */

export class AuthenticationError extends Error {
  readonly code = 'UNAUTHENTICATED';

  constructor() {
    super('Invalid email or password.');
    this.name = 'AuthenticationError';
  }
}

export class AccountLockedError extends Error {
  readonly code = 'ACCOUNT_LOCKED';

  readonly lockedUntil: Date;

  constructor(lockedUntil: Date) {
    super('This account is temporarily locked due to repeated failed login attempts.');
    this.name = 'AccountLockedError';
    this.lockedUntil = lockedUntil;
  }
}

/**
 * The minimal pool surface `login` needs - deliberately NOT `pg.Pool`
 * itself: `pg` is not a direct app-backend dependency (only `@wp/db` depends
 * on it), so a structural interface built on `TenantQueryable` (already
 * exported by `@wp/db`) keeps this module free of an unresolvable import
 * while staying satisfied by a real `pg.Pool`'s `.connect()` result.
 */
export interface LoginDbClient extends TenantQueryable {
  release(err?: unknown): void;
}

export interface LoginDbPool {
  connect(): Promise<LoginDbClient>;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  id: string;
  email: string;
  fullName: string;
  emailVerifiedAt: Date | null;
  mfaEnabledAt: Date | null;
  tokenEpoch: number;
}

type IdentityRepo = typeof identityRepoDefault;

export interface LoginCtx {
  pool: LoginDbPool;
  argon2Params: Argon2Params;
  lockoutThreshold: number;
  lockoutBaseMinutes: number;
  lockoutMaxHours: number;
  /** Mailer port - called AFTER commit only; a failure here is logged, never thrown. */
  sendLockoutEmail: (to: string) => Promise<void>;
  now?: () => Date;
  /** Test-double injection point - never used in production wiring. */
  identityRepo?: Partial<IdentityRepo>;
}

const DUMMY_VERIFY_PASSWORD = 'wp-login-dummy-verify-password-never-a-real-account';
const dummyHashCache = new Map<string, Promise<string>>();

/**
 * The dummy hash a not-found-email login verifies against, cached per
 * cost-profile so only the FIRST dummy verify pays the hash cost - every
 * later call (in either the unknown-email or wrong-password path) does
 * exactly one `verifyPassword` call, which is what keeps their timing
 * comparable.
 */
function getDummyHash(params: Argon2Params): Promise<string> {
  const key = `${String(params.memoryCost)}:${String(params.timeCost)}:${String(params.parallelism)}`;
  let cached = dummyHashCache.get(key);
  if (!cached) {
    cached = hashPassword(DUMMY_VERIFY_PASSWORD, params);
    dummyHashCache.set(key, cached);
  }
  return cached;
}

/**
 * `floor(failedCount / threshold) - 1` is the lockout ladder's index (0 at
 * the first lockout, 1 at the second, ...) - the phase task's own formula
 * for deriving the doubling without a new column. Capped at `maxHours`.
 *
 * P04b Unit UB1a (dedup): this is now the ONE canonical implementation - it
 * used to be duplicated verbatim in routes-shared.ts (as
 * `totpLockoutDurationMs`, for the wrong-TOTP-code lockout ladder), which
 * re-exports THIS function under that name rather than keeping its own
 * formula body, so a wrong-password lockout and a wrong-TOTP-code lockout
 * can never silently diverge for the same failure count again. Exported
 * (rather than kept private) purely so routes-shared.ts can import it - see
 * that file's re-export comment.
 */
export function lockoutDurationMs(
  failedCount: number,
  threshold: number,
  baseMinutes: number,
  maxHours: number,
): number {
  const lockoutIndex = Math.floor(failedCount / threshold) - 1;
  const minutes = Math.min(baseMinutes * 2 ** lockoutIndex, maxHours * 60);
  return minutes * 60_000;
}

export async function login(ctx: LoginCtx, input: LoginInput): Promise<LoginResult> {
  const identityRepo: IdentityRepo = { ...identityRepoDefault, ...ctx.identityRepo };
  const now = ctx.now ?? (() => new Date());
  const client = await ctx.pool.connect();

  let notifyLockoutEmail: string | null = null;

  try {
    await client.query('BEGIN');

    const user = await identityRepo.findUserForLogin(client, input.email);
    if (!user) {
      await client.query('ROLLBACK');
      await verifyPassword(await getDummyHash(ctx.argon2Params), input.password);
      throw new AuthenticationError();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > now().getTime()) {
      await client.query('ROLLBACK');
      throw new AccountLockedError(user.lockedUntil);
    }

    let passwordOk: boolean;
    if (user.passwordHash) {
      passwordOk = await verifyPassword(user.passwordHash, input.password);
    } else {
      // No password set (future passkey-only account) - still dummy-verify
      // so this path costs the same as a real mismatch.
      await verifyPassword(await getDummyHash(ctx.argon2Params), input.password);
      passwordOk = false;
    }

    if (!passwordOk) {
      const newCount = await identityRepo.incrementFailedLoginCount(client, user.id);
      if (newCount > 0 && newCount % ctx.lockoutThreshold === 0) {
        const durationMs = lockoutDurationMs(
          newCount,
          ctx.lockoutThreshold,
          ctx.lockoutBaseMinutes,
          ctx.lockoutMaxHours,
        );
        const lockedUntil = new Date(now().getTime() + durationMs);
        await identityRepo.setLockout(client, user.id, lockedUntil);
        // FIX 1 (P04a FIXA C1 review): resolve the tenant BEFORE the audit
        // write and set the app.client_id GUC for it - under wp_app + FORCE
        // RLS, an audit_logs INSERT with the GUC unset violates the
        // tenant_isolation policy's WITH CHECK and rolls back this whole
        // 5th-failure transaction (the lockout itself would be lost).
        const clientId = await identityRepo.findClientIdForUser(client, user.id);
        if (clientId) {
          await identityRepo.setAppClientId(client, clientId);
        }
        await identityRepo.insertLockoutAuditLog(client, { userId: user.id, clientId });
        notifyLockoutEmail = user.email;
      }
      await client.query('COMMIT');
      throw new AuthenticationError();
    }

    // FIX 6 (P04a FIXA C1 review): a non-'active' status is denied with the
    // SAME generic error as a bad password - checked AFTER the real password
    // verify above (never before) so a disabled account's timing is
    // indistinguishable from a live wrong-password attempt (no status
    // oracle). Deliberately does not touch failed_login_count/lockout: this
    // is a status gate, not a credential failure.
    if (user.status !== 'active') {
      await client.query('ROLLBACK');
      throw new AuthenticationError();
    }

    // passwordOk can only be true here when user.passwordHash was set (see
    // the passwordOk branch above - the no-hash path always dummy-verifies
    // and sets passwordOk = false).
    let passwordHash = user.passwordHash!;
    if (needsRehash(passwordHash, ctx.argon2Params)) {
      passwordHash = await hashPassword(input.password, ctx.argon2Params);
      await identityRepo.updatePasswordHash(client, user.id, passwordHash, now());
    }
    await identityRepo.resetFailedLoginAndRecordSuccess(client, user.id, now());
    await client.query('COMMIT');

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      emailVerifiedAt: user.emailVerifiedAt,
      mfaEnabledAt: user.mfaEnabledAt,
      tokenEpoch: user.tokenEpoch,
    };
  } catch (err) {
    // AuthenticationError/AccountLockedError paths above already
    // COMMIT/ROLLBACK explicitly; anything else must still roll back
    // whatever this transaction left open (e.g. a driver error mid-write).
    if (!(err instanceof AuthenticationError) && !(err instanceof AccountLockedError)) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is what must propagate, not a rollback failure.
      }
    }
    throw err;
  } finally {
    client.release();
    if (notifyLockoutEmail) {
      try {
        await ctx.sendLockoutEmail(notifyLockoutEmail);
      } catch (err) {
        // S2 (P04a FIXC): SMTP errors can embed the recipient address (PII) -
        // log only { name, code }, matching error-mapper.ts's own redaction
        // style, never `.message`.
        console.error('login: failed to send lockout notification email (non-fatal):', {
          name: err instanceof Error ? err.name : 'Error',
          code: (err as { code?: unknown } | null)?.code,
        });
      }
    }
  }
}
