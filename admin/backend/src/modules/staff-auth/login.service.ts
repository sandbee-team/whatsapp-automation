import { verify as argon2Verify, hash as argon2Hash, type Algorithm } from '@node-rs/argon2';
import { isIpAllowed } from '@wp/server-kit/auth';
import type { StaffRole } from '@wp/domain';
import {
  withStaffRoleTx,
  writeStaffAuditEvent,
  type PlatformReadDeps,
} from '../../platform/platform-read.js';
import {
  computeLockedUntil,
  priorLockoutsFor,
  shouldLock,
  type IpAttemptWindow,
} from './lockout.js';
import { StaffInvalidTotpError, verifyStaffTotp, type StaffTotpParams } from './totp.js';
import type { UsedTotpCodes } from './totp.js';
import {
  createStaffSession,
  findStaffUserByEmail,
  recordLoginFailure,
  recordLoginSuccess,
  type StaffUserRow,
} from './sessions.js';
import { generateRefreshToken, hashUserAgent, signStaffAccessToken } from './tokens.js';

/**
 * modules/staff-auth/login.service.ts (P28 Unit U4, step 6) - the staff
 * login decision, in a fixed order that is itself part of the security
 * design:
 *
 *  1. SHAPE: email + password + totpCode are ALL mandatory. A missing field
 *     is a 400 raised BEFORE any lookup, so an incomplete request never
 *     costs a database round trip or an argon2 hash.
 *  2. IP ALLOW-LIST FIRST, before anything else touches the database. An
 *     off-list caller learns nothing except that they are off-list. The
 *     list defaults to EMPTY, and empty means NOBODY logs in - a deployment
 *     that has not configured its ranges gets a locked panel, not an open
 *     one (`isIpAllowed` never implies allow-all).
 *  3. PER-IP WINDOW, still before the password hash - see `lockout.ts` for
 *     why (argon2 at 19456 KiB is otherwise a cheap DoS lever).
 *  4. ACCOUNT LOOKUP with a CONSTANT-TIME shape: when the email is unknown
 *     we still run one argon2 verify against a throwaway hash, so response
 *     timing cannot enumerate which staff emails exist.
 *  5. LOCKOUT before password verification - a locked account is refused
 *     without spending the hash.
 *  6. PASSWORD, then TOTP. TOTP IS MANDATORY: an account with no
 *     `mfa_enabled_at` gets 403 `MFA_ENROLL_REQUIRED` and no session,
 *     ever - there is no password-only staff login in this system.
 *  7. On success: counters reset, `last_login_at` stamped, a 2-minute
 *     access token minted, and a refresh session row created.
 *
 * Every branch is audited (`staff.login.success` / `.failure` / `.locked`),
 * including the ones that never reach the database, so an operator can see
 * an attack on the panel even when no account was touched.
 */

/** `Algorithm.Argon2id` - `verbatimModuleSyntax` forbids value access to that ambient const enum (TS2748), same cast as app-backend's `password.ts`. */
const ARGON2ID = 2 as Algorithm;

/** OWASP baseline, matching app-backend's tenant-side defaults exactly. */
export const STAFF_ARGON2_PARAMS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A fixed argon2id hash of a value nobody knows, verified against on the
 * unknown-email path purely to spend comparable time. It is a HASH, not a
 * password: there is no plaintext that produces a session from it.
 */
const DUMMY_HASH_PLAINTEXT = 'staff-login-timing-equaliser';
let dummyHashPromise: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= argon2Hash(DUMMY_HASH_PLAINTEXT, {
    algorithm: ARGON2ID,
    ...STAFF_ARGON2_PARAMS,
  });
  return dummyHashPromise;
}

export class StaffLoginForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(message = 'This request is not permitted from your network.') {
    super(message);
    this.name = 'StaffLoginForbiddenError';
  }
}

export class StaffLoginRateLimitedError extends Error {
  readonly code = 'RATE_LIMITED';
  constructor() {
    super('Too many login attempts - please try again later.');
    this.name = 'StaffLoginRateLimitedError';
  }
}

export class StaffAccountLockedError extends Error {
  readonly code = 'ACCOUNT_LOCKED';
  constructor() {
    super('This account is temporarily locked after repeated failed logins.');
    this.name = 'StaffAccountLockedError';
  }
}

export class StaffInvalidCredentialsError extends Error {
  readonly code = 'UNAUTHENTICATED';
  constructor() {
    super('Invalid email, password or verification code.');
    this.name = 'StaffInvalidCredentialsError';
  }
}

export interface StaffLoginDeps extends PlatformReadDeps {
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTtlSeconds: number;
  allowedCidrs: string;
  totpParams: StaffTotpParams;
  totpWindow: number;
  ipWindow: IpAttemptWindow;
  usedTotpCodes: UsedTotpCodes;
  now: () => Date;
}

export interface StaffLoginInput {
  email: string;
  password: string;
  totpCode: string;
  ip: string;
  userAgent?: string;
  requestId: string;
}

/**
 * The login transaction's verdict, as an explicit DISCRIMINATED UNION rather
 * than an inferred one: the `ok` case is the only one carrying a staff row
 * and a refresh token, and stating that in the type means the success path
 * below cannot compile against a refusal case by accident.
 */
type LoginOutcome =
  | { kind: 'invalid'; staffId: string | null }
  | { kind: 'locked'; staffId: string }
  | { kind: 'just_locked'; staffId: string }
  | { kind: 'ok'; staff: StaffUserRow; refreshRaw: string };

export interface StaffLoginResult {
  accessToken: string;
  expiresInSeconds: number;
  refreshTokenRaw: string;
  staff: { staffId: string; fullName: string; role: StaffRole };
}

/** Executes the ordered decision in this module's header. Throws a typed error on every refusal; never returns a partial session. */
export async function staffLogin(
  deps: StaffLoginDeps,
  input: StaffLoginInput,
): Promise<StaffLoginResult> {
  const now = deps.now();
  const auditBase = { requestId: input.requestId, ip: input.ip };

  // (2) IP allow-list - before any database contact.
  if (!isIpAllowed(input.ip, deps.allowedCidrs)) {
    await writeStaffAuditEvent(deps, {
      ...auditBase,
      action: 'staff.login.failure',
      staffId: null,
      metadata: { cause: 'ip_not_allowed' },
    });
    throw new StaffLoginForbiddenError();
  }

  // (3) Per-IP sliding window - before the argon2 hash.
  if (!deps.ipWindow.record(input.ip, now)) {
    await writeStaffAuditEvent(deps, {
      ...auditBase,
      action: 'staff.login.failure',
      staffId: null,
      metadata: { cause: 'ip_rate_limited' },
    });
    throw new StaffLoginRateLimitedError();
  }

  const outcome: LoginOutcome = await withStaffRoleTx<LoginOutcome>(deps.pool, async (db) => {
    // (4) Lookup, with a constant-time unknown-email path.
    const staff = await findStaffUserByEmail(db, input.email);
    if (!staff || staff.status !== 'active') {
      await argon2Verify(await dummyHash(), input.password).catch(() => false);
      return { kind: 'invalid' as const, staffId: null };
    }

    // (5) Lockout, before spending the hash.
    if (staff.lockedUntil && staff.lockedUntil.getTime() > now.getTime()) {
      return { kind: 'locked' as const, staffId: staff.id };
    }

    // (6a) Password.
    const passwordOk = await argon2Verify(staff.passwordHash, input.password).catch(() => false);
    if (!passwordOk) {
      const failedCount = staff.failedLoginCount + 1;
      const lockedUntil = shouldLock(failedCount)
        ? computeLockedUntil(now, priorLockoutsFor(failedCount))
        : null;
      await recordLoginFailure(db, { staffId: staff.id, lockedUntil });
      return {
        kind: lockedUntil ? ('just_locked' as const) : ('invalid' as const),
        staffId: staff.id,
      };
    }

    // (6b) TOTP - MANDATORY. A `StaffTotpRequiredError` (no enrolment) is
    // NOT a credential failure and deliberately does not increment the
    // lockout counter: the operator must enrol the account, and locking it
    // would only obstruct that.
    try {
      await verifyStaffTotp({
        staffId: staff.id,
        code: input.totpCode,
        secretEnc: staff.mfaTotpSecretEnc,
        mfaEnabledAt: staff.mfaEnabledAt,
        params: deps.totpParams,
        window: deps.totpWindow,
        now,
        usedCodes: deps.usedTotpCodes,
      });
    } catch (err) {
      if (err instanceof StaffInvalidTotpError) {
        const failedCount = staff.failedLoginCount + 1;
        const lockedUntil = shouldLock(failedCount)
          ? computeLockedUntil(now, priorLockoutsFor(failedCount))
          : null;
        await recordLoginFailure(db, { staffId: staff.id, lockedUntil });
        return {
          kind: lockedUntil ? ('just_locked' as const) : ('invalid' as const),
          staffId: staff.id,
        };
      }
      throw err;
    }

    // (7) Success.
    await recordLoginSuccess(db, { staffId: staff.id, now });
    const refresh = generateRefreshToken();
    await createStaffSession(db, {
      staffId: staff.id,
      refreshTokenHash: refresh.hash,
      ip: input.ip,
      userAgentHash: hashUserAgent(input.userAgent),
      expiresAt: new Date(now.getTime() + deps.refreshTtlSeconds * 1000),
    });
    return { kind: 'ok' as const, staff, refreshRaw: refresh.raw };
  });

  if (outcome.kind === 'locked' || outcome.kind === 'just_locked') {
    await writeStaffAuditEvent(deps, {
      ...auditBase,
      action: 'staff.login.locked',
      staffId: outcome.staffId,
      metadata: { cause: outcome.kind },
    });
    throw new StaffAccountLockedError();
  }
  if (outcome.kind === 'invalid') {
    await writeStaffAuditEvent(deps, {
      ...auditBase,
      action: 'staff.login.failure',
      staffId: outcome.staffId,
      metadata: { cause: 'invalid_credentials' },
    });
    throw new StaffInvalidCredentialsError();
  }

  await writeStaffAuditEvent(deps, {
    ...auditBase,
    action: 'staff.login.success',
    staffId: outcome.staff.id,
    metadata: { role: outcome.staff.role },
  });

  return {
    accessToken: await signStaffAccessToken({
      secret: deps.jwtSecret,
      claims: {
        staffId: outcome.staff.id,
        role: outcome.staff.role,
        epoch: outcome.staff.tokenEpoch,
      },
      ttlSeconds: deps.accessTokenTtlSeconds,
      now,
    }),
    expiresInSeconds: deps.accessTokenTtlSeconds,
    refreshTokenRaw: outcome.refreshRaw,
    staff: {
      staffId: outcome.staff.id,
      fullName: outcome.staff.fullName,
      role: outcome.staff.role,
    },
  };
}
