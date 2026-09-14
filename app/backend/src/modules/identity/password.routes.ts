import type { FastifyInstance } from 'fastify';
import {
  changePasswordInputSchema,
  forgotPasswordInputSchema,
  resetPasswordInputSchema,
} from '@wp/contracts';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendSuccess, RateLimitedError } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import { sysKey } from '../../platform/redis.js';
import { changePassword, forgotPassword, resetPassword } from './password.service.js';
import { type IdentityRoutesDeps, guarded, hashedAccountKey } from './routes-shared.js';

/**
 * password.routes.ts (P28 U5, item 1) - `POST /v1/auth/password/{change,
 * forgot,reset}`, a NEW sibling of auth.routes.ts (already close to the
 * 300-line cap) registered from identity.routes.ts, same idiom as
 * `impersonation-session-routes.ts`. `changePasswordContract`'s route policy
 * is `session_mfa` (a fresh MFA-verified session, or the `session_mfa` policy's
 * own non-owner-no-totp carve-out - see route-policy.ts's canon doc); forgot/
 * reset are `public` (unauthenticated by definition).
 */

const CHANGE_PASSWORD_RATE_LIMIT_CAPACITY = 5;
const CHANGE_PASSWORD_RATE_LIMIT_WINDOW_SEC = 15 * 60;
const FORGOT_PASSWORD_RATE_LIMIT_CAPACITY = 3;
const FORGOT_PASSWORD_RATE_LIMIT_WINDOW_SEC = 60 * 60;
const RESET_TOKEN_TTL_MINUTES = 30;

export function registerPasswordRoutes(
  app: FastifyInstance,
  deps: IdentityRoutesDeps,
  authDeps: AuthDeps,
): void {
  const env = deps.config.NODE_ENV;

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/auth/password/change',
    policy: 'session_mfa',
    scope: 'auth:password:change',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const rl = await deps.rateLimiter.consume([
          {
            key: sysKey(env, 'rl', 'acct', hashedAccountKey(auth.userId), 'password-change'),
            capacity: CHANGE_PASSWORD_RATE_LIMIT_CAPACITY,
            refillPerSec:
              CHANGE_PASSWORD_RATE_LIMIT_CAPACITY / CHANGE_PASSWORD_RATE_LIMIT_WINDOW_SEC,
            failClosed: true,
          },
        ]);
        if (!rl.allowed) throw new RateLimitedError(rl);

        const input = changePasswordInputSchema.parse(req.body);
        const result = await changePassword(
          {
            pool: deps.pool,
            argon2Params: {
              memoryCost: deps.config.ARGON2_MEMORY_KIB,
              timeCost: deps.config.ARGON2_TIME_COST,
              parallelism: deps.config.ARGON2_PARALLELISM,
            },
            publicBaseUrl: deps.config.PUBLIC_BASE_URL,
            resetTokenTtlMinutes: RESET_TOKEN_TTL_MINUTES,
            redisEpochCtx: {
              redis: deps.redis,
              env: deps.config.NODE_ENV,
              epochCacheTtlSec: deps.config.EPOCH_CACHE_TTL_SEC,
            },
            sendPasswordResetEmail: deps.mailer.sendPasswordResetEmail,
          },
          {
            userId: auth.userId,
            currentSessionId: auth.sessionId,
            currentPassword: input.currentPassword,
            newPassword: input.newPassword,
          },
        );

        sendSuccess(reply, requestId, {
          changed: true,
          otherSessionsRevoked: result.otherSessionsRevoked,
        });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/auth/password/forgot',
    policy: 'public',
    scope: 'auth:password:forgot',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const input = forgotPasswordInputSchema.parse(req.body);
        const ip = req.ip;
        const rl = await deps.rateLimiter.consume([
          {
            key: sysKey(env, 'rl', 'ip', ip, 'password-forgot'),
            capacity: deps.config.RATE_LIMIT_AUTH_IP_CAPACITY,
            refillPerSec:
              deps.config.RATE_LIMIT_AUTH_IP_CAPACITY / deps.config.RATE_LIMIT_AUTH_IP_WINDOW_SEC,
            failClosed: true,
          },
          {
            key: sysKey(env, 'rl', 'acct', hashedAccountKey(input.email), 'password-forgot'),
            capacity: FORGOT_PASSWORD_RATE_LIMIT_CAPACITY,
            refillPerSec:
              FORGOT_PASSWORD_RATE_LIMIT_CAPACITY / FORGOT_PASSWORD_RATE_LIMIT_WINDOW_SEC,
            failClosed: true,
          },
        ]);
        if (!rl.allowed) throw new RateLimitedError(rl);

        await forgotPassword(
          {
            pool: deps.pool,
            argon2Params: {
              memoryCost: deps.config.ARGON2_MEMORY_KIB,
              timeCost: deps.config.ARGON2_TIME_COST,
              parallelism: deps.config.ARGON2_PARALLELISM,
            },
            publicBaseUrl: deps.config.PUBLIC_BASE_URL,
            resetTokenTtlMinutes: RESET_TOKEN_TTL_MINUTES,
            redisEpochCtx: {
              redis: deps.redis,
              env: deps.config.NODE_ENV,
              epochCacheTtlSec: deps.config.EPOCH_CACHE_TTL_SEC,
            },
            sendPasswordResetEmail: deps.mailer.sendPasswordResetEmail,
          },
          { email: input.email },
        );

        // ALWAYS 202 accepted - never reveals whether the account exists.
        sendSuccess(reply, requestId, { accepted: true }, 202);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/auth/password/reset',
    policy: 'public',
    scope: 'auth:password:reset',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const input = resetPasswordInputSchema.parse(req.body);
        const ip = req.ip;
        const rl = await deps.rateLimiter.consume([
          {
            key: sysKey(env, 'rl', 'ip', ip, 'password-reset'),
            capacity: deps.config.RATE_LIMIT_AUTH_IP_CAPACITY,
            refillPerSec:
              deps.config.RATE_LIMIT_AUTH_IP_CAPACITY / deps.config.RATE_LIMIT_AUTH_IP_WINDOW_SEC,
            failClosed: true,
          },
        ]);
        if (!rl.allowed) throw new RateLimitedError(rl);

        await resetPassword(
          {
            pool: deps.pool,
            argon2Params: {
              memoryCost: deps.config.ARGON2_MEMORY_KIB,
              timeCost: deps.config.ARGON2_TIME_COST,
              parallelism: deps.config.ARGON2_PARALLELISM,
            },
            publicBaseUrl: deps.config.PUBLIC_BASE_URL,
            resetTokenTtlMinutes: RESET_TOKEN_TTL_MINUTES,
            redisEpochCtx: {
              redis: deps.redis,
              env: deps.config.NODE_ENV,
              epochCacheTtlSec: deps.config.EPOCH_CACHE_TTL_SEC,
            },
            sendPasswordResetEmail: deps.mailer.sendPasswordResetEmail,
          },
          { token: input.token, newPassword: input.newPassword },
        );

        sendSuccess(reply, requestId, { reset: true });
      });
    },
  });
}
