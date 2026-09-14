import type { FastifyInstance } from 'fastify';
import { loginInputSchema, signupInputSchema, verifyEmailInputSchema } from '@wp/contracts';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendSuccess, RateLimitedError } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import { sysKey } from '../../platform/redis.js';
import { hashPassword } from './password.js';
import { signup } from './signup.service.js';
import { verifyEmail } from './verify-email.service.js';
import { login } from './login.service.js';
import {
  createSession,
  logout as logoutSession,
  refresh as refreshSession,
  UnauthenticatedError,
} from './session.service.js';
import { meImpersonationFieldFor } from './impersonation-session-routes.js';
import {
  type IdentityRoutesDeps,
  guarded,
  setRefreshCookie,
  clearRefreshCookie,
  loginCtxFrom,
  sessionCtxFrom,
  fetchMeRow,
  hashedAccountKey,
  signMfaToken,
  REFRESH_COOKIE_NAME,
} from './routes-shared.js';

/**
 * auth.routes.ts (P04a FIXD, split out of identity.routes.ts for max-lines)
 * - signup/verify-email/login/refresh/logout/me, ALL through
 * `route-policy.ts#registerRoute` (fail-closed routing, canon). Pure code
 * motion: no behavior change from the original identity.routes.ts.
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  deps: IdentityRoutesDeps,
  authDeps: AuthDeps,
): void {
  const env = deps.config.NODE_ENV;

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/auth/signup',
    policy: 'public',
    scope: 'auth:signup',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const ip = req.ip;
        const rl = await deps.rateLimiter.consume([
          {
            key: sysKey(env, 'rl', 'ip', ip, 'signup'),
            capacity: deps.config.RATE_LIMIT_AUTH_IP_CAPACITY,
            refillPerSec:
              deps.config.RATE_LIMIT_AUTH_IP_CAPACITY / deps.config.RATE_LIMIT_AUTH_IP_WINDOW_SEC,
            failClosed: true,
          },
        ]);
        if (!rl.allowed) throw new RateLimitedError(rl);

        const input = signupInputSchema.parse(req.body);
        const passwordHash = await hashPassword(input.password, {
          memoryCost: deps.config.ARGON2_MEMORY_KIB,
          timeCost: deps.config.ARGON2_TIME_COST,
          parallelism: deps.config.ARGON2_PARALLELISM,
        });

        const result = await signup(
          {
            tenantDb: deps.tenantDb,
            sendVerificationEmail: deps.mailer.sendVerificationEmail,
            publicBaseUrl: deps.config.PUBLIC_BASE_URL,
            signupCreditMinor: deps.config.SIGNUP_CREDIT_MINOR,
            lowBalanceThresholdMinor: deps.config.WALLET_LOW_BALANCE_THRESHOLD_MINOR,
          },
          {
            fullName: input.fullName,
            email: input.email,
            phoneE164: input.phoneE164,
            companyName: input.companyName,
            passwordHash,
          },
        );

        sendSuccess(
          reply,
          requestId,
          { userId: result.userId, clientId: result.clientId, onboardingStep: 'verify_email' },
          201,
        );
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/auth/verify-email',
    policy: 'public',
    scope: 'auth:verify',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const input = verifyEmailInputSchema.parse(req.body);
        await verifyEmail({ pool: deps.pool }, input.token);
        sendSuccess(reply, requestId, { ok: true, onboardingStep: 'choose_timezone' });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/auth/login',
    policy: 'public',
    scope: 'auth:login',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const input = loginInputSchema.parse(req.body);
        const ip = req.ip;
        const rl = await deps.rateLimiter.consume([
          {
            key: sysKey(env, 'rl', 'ip', ip, 'login'),
            capacity: deps.config.RATE_LIMIT_AUTH_IP_CAPACITY,
            refillPerSec:
              deps.config.RATE_LIMIT_AUTH_IP_CAPACITY / deps.config.RATE_LIMIT_AUTH_IP_WINDOW_SEC,
            failClosed: true,
          },
          {
            key: sysKey(env, 'rl', 'acct', hashedAccountKey(input.email), 'login'),
            capacity: deps.config.RATE_LIMIT_AUTH_ACCOUNT_CAPACITY,
            refillPerSec:
              deps.config.RATE_LIMIT_AUTH_ACCOUNT_CAPACITY /
              deps.config.RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC,
            failClosed: true,
          },
        ]);
        if (!rl.allowed) throw new RateLimitedError(rl);

        const result = await login(loginCtxFrom(deps), input);

        if (result.mfaEnabledAt) {
          const mfaToken = await signMfaToken(deps, result.id);
          sendSuccess(reply, requestId, { kind: 'mfa_required', mfaToken });
          return;
        }

        const tokens = await createSession(sessionCtxFrom(deps), { userId: result.id });
        setRefreshCookie(reply, tokens.refreshToken, deps.config.REFRESH_TOKEN_TTL_DAYS);
        sendSuccess(reply, requestId, {
          kind: 'authenticated',
          accessToken: tokens.accessToken,
          user: { id: result.id, email: result.email, fullName: result.fullName },
        });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/auth/refresh',
    policy: 'public',
    scope: 'auth:refresh',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const cookies = req.cookies as Record<string, string | undefined>;
        const raw = cookies[REFRESH_COOKIE_NAME];
        if (!raw) throw new UnauthenticatedError();

        const tokens = await refreshSession(sessionCtxFrom(deps), { refreshToken: raw });
        setRefreshCookie(reply, tokens.refreshToken, deps.config.REFRESH_TOKEN_TTL_DAYS);
        sendSuccess(reply, requestId, { accessToken: tokens.accessToken });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/auth/logout',
    policy: 'session',
    scope: 'auth:logout',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        await logoutSession(sessionCtxFrom(deps), { sessionId: auth.sessionId });
        clearRefreshCookie(reply);
        sendSuccess(reply, requestId, { ok: true });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/auth/me',
    policy: 'session',
    scope: 'auth:me',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const row = await fetchMeRow(deps, auth.userId);
        // P28 U3c: `impersonation` is present only while this session is a
        // staff-minted impersonation token - re-read fresh (never trusted
        // from the token's own claims), same tenant-scoped transaction
        // discipline as `fetchMeRow` itself.
        const impersonation = auth.imp
          ? await deps.tenantDb.withTenant(auth.clientId, (tx) => meImpersonationFieldFor(tx, auth))
          : undefined;
        sendSuccess(reply, requestId, impersonation ? { ...row, impersonation } : row);
      });
    },
  });
}
