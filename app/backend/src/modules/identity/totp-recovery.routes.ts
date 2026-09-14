import type { FastifyInstance } from 'fastify';
import { totpRecoveryInputSchema } from '@wp/contracts';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendSuccess, RateLimitedError } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import { sysKey } from '../../platform/redis.js';
import { AccountLockedError } from './login.service.js';
import { createSession, UnauthenticatedError } from './session.service.js';
import { verifyRecoveryCode, InvalidRecoveryCodeError } from './totp.service.js';
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
 * totp-recovery.routes.ts (P04b Unit UB1a, task 2) - the recovery-code login
 * continuation (`/v1/auth/totp/recovery`), a small new file (rather than
 * growing totp.routes.ts past its 300-line budget) mirroring `/totp/verify`'s
 * handler EXACTLY: same public-with-mfaToken policy/scope class, same
 * rate-limit keys (IP + hashed account, both fail-closed), same lockout-
 * ladder gate (locked denies even a correct recovery code), same generic
 * error shape on a wrong/already-used code (`InvalidRecoveryCodeError` maps
 * to the SAME `VALIDATION_ERROR` as `InvalidTotpCodeError` - see
 * routes-shared.ts's `mapServiceError` - no oracle distinguishing
 * "already used" from "wrong"). The one-time claim on the code itself lives
 * at the STORAGE layer (`totp.service.ts#verifyRecoveryCode` ->
 * `identity.repo.ts#claimMfaRecoveryCode`'s single conditional `UPDATE`),
 * never an in-memory check (core invariant 3).
 */
export function registerTotpRecoveryRoutes(
  app: FastifyInstance,
  deps: IdentityRoutesDeps,
  authDeps: AuthDeps,
): void {
  const env = deps.config.NODE_ENV;

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/auth/totp/recovery',
    policy: 'public',
    scope: 'auth:mfa',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const input = totpRecoveryInputSchema.parse(req.body);
        const { userId, jti, expSec } = await verifyMfaToken(deps, input.mfaToken);

        const ip = req.ip;
        const rl = await deps.rateLimiter.consume([
          {
            key: sysKey(env, 'rl', 'ip', ip, 'totp-recovery'),
            capacity: deps.config.RATE_LIMIT_AUTH_IP_CAPACITY,
            refillPerSec:
              deps.config.RATE_LIMIT_AUTH_IP_CAPACITY / deps.config.RATE_LIMIT_AUTH_IP_WINDOW_SEC,
            failClosed: true,
          },
          {
            key: sysKey(env, 'rl', 'acct', hashedAccountKey(userId), 'totp-recovery'),
            capacity: deps.config.RATE_LIMIT_AUTH_ACCOUNT_CAPACITY,
            refillPerSec:
              deps.config.RATE_LIMIT_AUTH_ACCOUNT_CAPACITY /
              deps.config.RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC,
            failClosed: true,
          },
        ]);
        if (!rl.allowed) throw new RateLimitedError(rl);

        const user = await fetchBasicUser(deps, userId);

        // Own BEGIN/COMMIT (users/mfa_recovery_codes carry no client_id/RLS,
        // same class as login.service.ts/totp.routes.ts's /totp/verify).
        const client = await deps.pool.connect();
        let lockoutEmailTo: string | null = null;
        try {
          await client.query('BEGIN');
          const loginRow = await identityRepo.findUserForLogin(client, user.email);
          if (!loginRow) {
            await client.query('ROLLBACK');
            throw new UnauthenticatedError();
          }
          // An account disabled DURING the mfaToken window must never
          // complete a session mint - checked BEFORE the code check, same
          // generic error as any other denial here (no status oracle).
          if (loginRow.status !== 'active') {
            await client.query('ROLLBACK');
            throw new UnauthenticatedError();
          }
          if (loginRow.lockedUntil && loginRow.lockedUntil.getTime() > Date.now()) {
            await client.query('ROLLBACK');
            throw new AccountLockedError(loginRow.lockedUntil);
          }

          let codeErr: InvalidRecoveryCodeError | null = null;
          try {
            await verifyRecoveryCode(totpCtxFrom(deps, client), userId, input.recoveryCode);
          } catch (err) {
            if (!(err instanceof InvalidRecoveryCodeError)) {
              await client.query('ROLLBACK');
              throw err;
            }
            codeErr = err;
          }

          if (codeErr) {
            // A wrong/already-used recovery code feeds the SAME lockout
            // ladder as a wrong TOTP code.
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

          // Single-use claim on the mfaToken's `jti` - BEFORE the counter
          // reset/session mint, so an already-consumed token can never reach
          // either.
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
            !(err instanceof InvalidRecoveryCodeError)
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
              // SMTP errors can embed the recipient address (PII) - log only
              // { name, code }, matching error-mapper.ts's own redaction
              // style, never `.message`.
              console.error(
                'totp/recovery: failed to send lockout notification email (non-fatal):',
                {
                  name: mailErr instanceof Error ? mailErr.name : 'Error',
                  code: (mailErr as { code?: unknown } | null)?.code,
                },
              );
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
}
