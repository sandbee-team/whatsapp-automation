import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from '../envelope.js';

/**
 * admin/auth.ts (P28 Unit U4, step 9) - `/admin/v1/auth/*`.
 *
 * NOTHING in this file carries a refresh token. The refresh token exists
 * ONLY as the httpOnly + Secure + SameSite=Strict `wp_admin_rt` cookie,
 * path-scoped to `/admin/v1/auth`; it is deliberately absent from every
 * response BODY so no script on the page can ever read it, and so it cannot
 * end up in a log, a browser history entry, or an error report. The panel
 * never sees it and never needs to.
 *
 * `accessToken` IS in the body, because the panel must attach it as a
 * bearer header - and it is safe to hold in memory precisely because it
 * expires in 120 seconds (`expiresInSeconds`), which is why that field is
 * part of the contract rather than an implementation detail: the panel is
 * expected to schedule its refresh from it.
 */

export const staffRoleSchema = z.enum(['support', 'ops', 'superadmin']);
export type StaffRoleContract = z.infer<typeof staffRoleSchema>;

/**
 * All three fields REQUIRED. There is no password-only staff login in this
 * system: `totpCode` is not optional, at the contract level, so a panel
 * that forgot the field fails to compile rather than sending a request the
 * server will reject.
 */
export const staffLoginInputSchema = z
  .object({
    email: z.string().trim().min(3).max(320),
    password: z.string().min(1).max(1024),
    totpCode: z.string().trim().min(6).max(10),
  })
  .strict();
export type StaffLoginInput = z.infer<typeof staffLoginInputSchema>;

/**
 * `actions` is the server's OWN answer to "what may this staff member do",
 * derived from `canStaff`. The panel uses it to grey out controls - a UX
 * affordance only: every mutation re-checks RBAC server-side, so a panel
 * that ignored this list would gain nothing.
 */
export const staffSessionDataSchema = z
  .object({
    accessToken: z.string().min(1),
    /** Always 120 or less - the ceiling is enforced in admin-backend's config, not here. */
    expiresInSeconds: z.number().int().positive(),
    staffId: z.uuid(),
    fullName: z.string().min(1),
    role: staffRoleSchema,
    actions: z.array(z.string()),
  })
  .strict();
export type StaffSessionData = z.infer<typeof staffSessionDataSchema>;

export const staffSessionOutputSchema = successEnvelope(staffSessionDataSchema);
export type StaffSessionOutput = z.infer<typeof staffSessionOutputSchema>;

export const staffLoginContract = oc
  .route({ method: 'POST', path: '/admin/v1/auth/login' })
  .input(staffLoginInputSchema)
  .output(staffSessionOutputSchema);

/** Takes no input at all: the ONLY credential is the `wp_admin_rt` cookie. */
export const staffRefreshContract = oc
  .route({ method: 'POST', path: '/admin/v1/auth/refresh' })
  .output(staffSessionOutputSchema);

export const staffLogoutOutputSchema = successEnvelope(z.object({ ok: z.literal(true) }).strict());

export const staffLogoutContract = oc
  .route({ method: 'POST', path: '/admin/v1/auth/logout' })
  .output(staffLogoutOutputSchema);

export const staffMeDataSchema = z
  .object({
    staffId: z.uuid(),
    fullName: z.string().min(1),
    role: staffRoleSchema,
    actions: z.array(z.string()),
  })
  .strict();
export type StaffMeData = z.infer<typeof staffMeDataSchema>;

export const staffMeOutputSchema = successEnvelope(staffMeDataSchema);

export const staffMeContract = oc
  .route({ method: 'GET', path: '/admin/v1/auth/me' })
  .output(staffMeOutputSchema);

export const adminAuthContract = {
  login: staffLoginContract,
  refresh: staffRefreshContract,
  logout: staffLogoutContract,
  me: staffMeContract,
} as const;
