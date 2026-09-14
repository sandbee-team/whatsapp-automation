import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { staffActionsFor } from '@wp/domain';
import { registerAdminRoute } from '../../platform/http/route-policy.js';
import { requestIdFor, sendSuccess } from '../../platform/http/error-mapper.js';
import type { StaffAuthDeps } from '../../platform/http/staff-auth-plugin.js';
import { staffLogin, type StaffLoginDeps } from './login.service.js';
import { staffLogout, staffRefresh, type StaffRefreshDeps } from './refresh.service.js';
import { StaffUnauthenticatedError } from './tokens.js';

/**
 * modules/staff-auth/routes.ts (P28 Unit U4, step 6) - `/admin/v1/auth/*`.
 *
 * THE REFRESH COOKIE: `wp_admin_rt`, `httpOnly` + `Secure` +
 * `SameSite=Strict`, path-scoped to `/admin/v1/auth`. All four matter:
 * `httpOnly` keeps it out of reach of any script on the page, `Secure`
 * keeps it off plaintext transport, `SameSite=Strict` means no cross-site
 * request can ever carry it (so a CSRF against the refresh endpoint cannot
 * mint a token), and the PATH scope means the cookie is not even sent on
 * the read endpoints that make up the rest of the panel - it travels only
 * to the three routes that need it.
 *
 * `login` and `refresh` are `policy: 'public'` in the fail-closed sense:
 * they are the routes that CREATE a session, so they cannot require one.
 * Their own gates (IP allow-list, per-IP window, password, MANDATORY TOTP,
 * account lockout, refresh-reuse detection) live in the two services.
 */

const REFRESH_COOKIE_NAME = 'wp_admin_rt';
const REFRESH_COOKIE_PATH = '/admin/v1/auth';

/**
 * All three fields are REQUIRED - there is no password-only staff login,
 * and a missing field is rejected here, before any database lookup or
 * argon2 hash (see `login.service.ts`'s ordered decision).
 */
const loginBodySchema = z
  .object({
    email: z.string().trim().min(3).max(320),
    password: z.string().min(1).max(1024),
    totpCode: z.string().trim().min(6).max(10),
  })
  .strict();

export interface StaffAuthRoutesDeps {
  login: StaffLoginDeps;
  refresh: StaffRefreshDeps;
  auth: StaffAuthDeps;
  /** `false` only for local http development; production always sets the Secure attribute. */
  cookieSecure: boolean;
}

function clientIpOf(req: FastifyRequest): string {
  return req.ip;
}

function userAgentOf(req: FastifyRequest): string | undefined {
  const header = req.headers['user-agent'];
  return typeof header === 'string' ? header : undefined;
}

export function registerStaffAuthRoutes(app: FastifyInstance, deps: StaffAuthRoutesDeps): void {
  const setRefreshCookie = (
    reply: Parameters<NonNullable<Parameters<typeof registerAdminRoute>[2]['handler']>>[1],
    raw: string,
    maxAgeSeconds: number,
  ): void => {
    reply.setCookie(REFRESH_COOKIE_NAME, raw, {
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: maxAgeSeconds,
    });
  };

  registerAdminRoute(app, deps.auth, {
    method: 'POST',
    path: '/admin/v1/auth/login',
    policy: 'public',
    handler: async (req, reply) => {
      const body = loginBodySchema.parse(req.body);
      const result = await staffLogin(deps.login, {
        email: body.email,
        password: body.password,
        totpCode: body.totpCode,
        ip: clientIpOf(req),
        userAgent: userAgentOf(req),
        requestId: requestIdFor(req),
      });
      setRefreshCookie(reply, result.refreshTokenRaw, deps.refresh.refreshTtlSeconds);
      sendSuccess(reply, requestIdFor(req), {
        accessToken: result.accessToken,
        expiresInSeconds: result.expiresInSeconds,
        staffId: result.staff.staffId,
        fullName: result.staff.fullName,
        role: result.staff.role,
        actions: staffActionsFor(result.staff.role),
      });
    },
  });

  registerAdminRoute(app, deps.auth, {
    method: 'POST',
    path: '/admin/v1/auth/refresh',
    policy: 'public',
    handler: async (req, reply) => {
      const raw = req.cookies[REFRESH_COOKIE_NAME];
      if (!raw) {
        throw new StaffUnauthenticatedError();
      }
      const result = await staffRefresh(deps.refresh, {
        refreshTokenRaw: raw,
        ip: clientIpOf(req),
        userAgent: userAgentOf(req),
        requestId: requestIdFor(req),
      });
      setRefreshCookie(reply, result.refreshTokenRaw, deps.refresh.refreshTtlSeconds);
      sendSuccess(reply, requestIdFor(req), {
        accessToken: result.accessToken,
        expiresInSeconds: result.expiresInSeconds,
        staffId: result.staff.staffId,
        fullName: result.staff.fullName,
        role: result.staff.role,
        actions: staffActionsFor(result.staff.role),
      });
    },
  });

  registerAdminRoute(app, deps.auth, {
    method: 'POST',
    path: '/admin/v1/auth/logout',
    policy: 'public',
    handler: async (req, reply) => {
      // Public on purpose: logging out must work with an already-expired
      // access token, and it is idempotent (see `staffLogout`).
      await staffLogout(deps.refresh, {
        refreshTokenRaw: req.cookies[REFRESH_COOKIE_NAME],
        ip: clientIpOf(req),
        requestId: requestIdFor(req),
      });
      reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
      sendSuccess(reply, requestIdFor(req), { ok: true });
    },
  });

  registerAdminRoute(app, deps.auth, {
    method: 'GET',
    path: '/admin/v1/auth/me',
    policy: 'staff',
    // The lowest-privilege action every role holds - `me` is readable by any
    // authenticated staff member, and declaring an action (rather than
    // allowing an action-less staff route) keeps the fail-closed rule intact.
    action: 'clients.read',
    handler: (req, reply) => {
      const staff = req.staff!;
      sendSuccess(reply, requestIdFor(req), {
        staffId: staff.staffId,
        fullName: staff.fullName,
        role: staff.role,
        actions: staffActionsFor(staff.role),
      });
    },
  });
}
