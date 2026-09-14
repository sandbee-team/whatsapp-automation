import type { FastifyInstance } from 'fastify';
import { totpEnrolConfirmInputSchema, totpVerifyInputSchema } from '@wp/contracts';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendSuccess, RateLimitedError } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import { sysKey } from '../../platform/redis.js';
import { AccountLockedError } from './login.service.js';
import { createSession, UnauthenticatedError } from './session.service.js';
import {
  enrolConfirm,
  enrolStart,
  verify as verifyTotp,
  InvalidTotpCodeError,
} from './totp.service.js';
import * as identityRepo from './identity.repo.js';
import {
  type IdentityRoutesDeps,
  guarded,
  setRefreshCookie,
  sessionCtxFrom,
  totpCtxFrom,
  fetchBasicUser,
  hashedAccountKey,
  totpLockoutDurationMs,
  verifyMfaToken,
  claimMfaJtiOrThrow,
} from './routes-shared.js';

/**
 * totp.routes.ts (P04a FIXD, split out of identity.routes.ts for max-lines)
 * - the TOTP MFA continuation of login (`/totp/verify`) plus enrolment
 * (`/totp/enrol`, `/totp/enrol/confirm`), ALL through
 * `route-policy.ts#registerRoute` (fail-closed routing, canon). Pure code
 * motion: no behavior change from the original identity.routes.ts.
 */
export function registerTotpRoutes(
  app: FastifyInstance,
  deps: IdentityRoutesDeps,
  authDeps: AuthDeps,
): void {
  const env = deps.config.NODE_ENV;

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/auth/totp/verify',
    policy: 'public',
    scope: 'auth:mfa',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const input = totpVerifyInputSchema.parse(req.body);
        const { userId, jti, expSec } = await verifyMfaToken(deps, input.mfaToken);

        // FIX 10a (P04a FIXB): rate-limited like login - per-IP AND
        // per-account (hashed userId, FIX 12), both fail-closed.
        const ip = req.ip;
        const rl = await deps.rateLimiter.consume([
          {
            key: sysKey(env, 'rl', 'ip', ip, 'totp-verify'),
            capacity: deps.config.RATE_LIMIT_AUTH_IP_CAPACITY,
            refillPerSec:
              deps.config.RATE_LIMIT_AUTH_IP_CAPACITY / deps.config.RATE_LIMIT_AUTH_IP_WINDOW_SEC,
            failClosed: true,
          },
          {
            key: sysKey(env, 'rl', 'acct', hashedAccountKey(userId), 'totp-verify'),
            capacity: deps.config.RATE_LIMIT_AUTH_ACCOUNT_CAPACITY,
            refillPerSec:
              deps.config.RATE_LIMIT_AUTH_ACCOUNT_CAPACITY /
              deps.config.RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC,
            failClosed: true,
          },
        ]);
        if (!rl.allowed) throw new RateLimitedError(rl);

        const user = await fetchBasicUser(deps, userId);

        // FIX 10c (P04a FIXB): wrong TOTP codes feed the SAME lockout ladder
        // login.service.ts uses - own BEGIN/COMMIT (users/mfa_recovery_codes
        // carry no client_id/RLS, same class as login.service.ts), GUC set
        // via setAppClientId only for the lockout audit write.
        const client = await deps.pool.connect();
        let lockoutEmailTo: string | null = null;
        try {
          await client.query('BEGIN');
          const loginRow = await identityRepo.findUserForLogin(client, user.email);
          if (!loginRow) {
            await client.query('ROLLBACK');
            throw new UnauthenticatedError();
          }
          // W2 (P04a FIXC): an account disabled DURING the 5-min mfaToken
          // window (after `login()` returned `mfa_required`, before this
          // continuation) must never be allowed to complete a session mint -
          // checked BEFORE the code check, same generic error as any other
          // denial here (no status oracle).
          if (loginRow.status !== 'active') {
            await client.query('ROLLBACK');
            throw new UnauthenticatedError();
          }
          if (loginRow.lockedUntil && loginRow.lockedUntil.getTime() > Date.now()) {
            await client.query('ROLLBACK');
            throw new AccountLockedError(loginRow.lockedUntil);
          }

          let codeErr: InvalidTotpCodeError | null = null;
          try {
            await verifyTotp(totpCtxFrom(deps, client), userId, input.code);
          } catch (err) {
            if (!(err instanceof InvalidTotpCodeError)) {
              await client.query('ROLLBACK');
              throw err;
            }
            codeErr = err;
          }

          if (codeErr) {
            const newCount = await identityRepo.incrementFailedLoginCount(client, userId);
            if (newCount > 0 && newCount % deps.config.AUTH_LOCKOUT_THRESHOLD === 0) {
              const durationMs = totpLockoutDurationMs(
                newCount,
                deps.config.AUTH_LOCKOUT_THRESHOLD,
                deps.config.AUTH_LOCKOUT_BASE_MINUTES,
                deps.config.AUTH_LOCKOUT_MAX_HOURS,
              );
              const lockedUntil = new Date(Date.now() + durationMs);
              await identityRepo.setLockout(client, userId, lockedUntil);
              const auditClientId = await identityRepo.findClientIdForUser(client, userId);
              if (auditClientId) {
                await identityRepo.setAppClientId(client, auditClientId);
              }
              await identityRepo.insertLockoutAuditLog(client, { userId, clientId: auditClientId });
              lockoutEmailTo = user.email;
            }
            await client.query('COMMIT');
            throw codeErr;
          }

          // FIX 10b (P04a FIXB): single-use claim on the mfaToken's `jti` -
          // BEFORE the counter reset/session mint, so an already-consumed
          // token can never reach either.
          try {
            await claimMfaJtiOrThrow(deps, jti, expSec);
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }

          await identityRepo.resetFailedLoginAndRecordSuccess(client, userId, new Date());
          await client.query('COMMIT');
        } catch (err) {
          if (
            !(err instanceof UnauthenticatedError) &&
            !(err instanceof AccountLockedError) &&
            !(err instanceof InvalidTotpCodeError)
          ) {
            try {
              await client.query('ROLLBACK');
            } catch {
              // The original error is what must propagate, not a rollback failure.
            }
          }
          throw err;
        } finally {
          client.release();
          if (lockoutEmailTo) {
            try {
              await deps.mailer.sendLockoutEmail(lockoutEmailTo);
            } catch (mailErr) {
              // S2 (P04a FIXC): SMTP errors can embed the recipient address
              // (PII) - log only { name, code }, matching error-mapper.ts's
              // own redaction style, never `.message`.
              console.error('totp/verify: failed to send lockout notification email (non-fatal):', {
                name: mailErr instanceof Error ? mailErr.name : 'Error',
                code: (mailErr as { code?: unknown } | null)?.code,
              });
            }
          }
        }

        const tokens = await createSession(sessionCtxFrom(deps), { userId, mfa: true });
        setRefreshCookie(reply, tokens.refreshToken, deps.config.REFRESH_TOKEN_TTL_DAYS);
        sendSuccess(reply, requestId, {
          kind: 'authenticated',
          accessToken: tokens.accessToken,
          user,
        });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/auth/totp/enrol',
    policy: 'session',
    scope: 'auth:mfa-enrol',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const user = await fetchBasicUser(deps, auth.userId);
        const result = await enrolStart(totpCtxFrom(deps), auth.userId, user.email);
        sendSuccess(reply, requestId, result);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/auth/totp/enrol/confirm',
    policy: 'session',
    scope: 'auth:mfa-enrol',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const input = totpEnrolConfirmInputSchema.parse(req.body);
        const result = await enrolConfirm(totpCtxFrom(deps), auth.userId, input.code);
        sendSuccess(reply, requestId, result);
      });
    },
  });
}
