import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import {
  grantImpersonationInputSchema,
  mintImpersonationTokenInputSchema,
  elevateImpersonationInputSchema,
} from '@wp/contracts';
import { registerMutationProxy, type MutationProxyDeps } from './mutation-proxy.js';

/**
 * modules/mutations/impersonation.routes.ts (P28 Unit U4, step 8) - the
 * three impersonation mutations whose response must be SHAPED rather than
 * passed through, and the one place `APP_PANEL_BASE_URL` is used.
 *
 * TWO THINGS THIS MODULE EXISTS TO GET RIGHT:
 *
 * 1. `panelUrl` is assembled as `APP_PANEL_BASE_URL + panelEntryPath` - the
 *    TENANT panel's origin, never the admin panel's. The staff member is
 *    being sent into the customer's workspace; pointing this at the admin
 *    origin would be a confused-deputy problem, and hard-coding a host
 *    would break every non-production deployment.
 *
 * 2. THE RAW ACCESS TOKEN IS NEVER RETURNED IN THE ADMIN JSON BODY AS ITS
 *    OWN FIELD - it travels ONLY inside `panelUrl`'s `#token=` fragment.
 *    `/internal/v1/impersonation/:grantId/token` returns an `accessToken`
 *    (that is its job - app-backend mints it), but this proxy drops that
 *    field from what the admin panel sees and keeps only `grantId`,
 *    `expiresAt`, `scope` and the assembled `panelUrl` (exactly what
 *    `adminImpersonationTokenDataSchema` declares, and `.strict()` would
 *    reject an extra field anyway).
 *
 *    HONEST STATEMENT (C1 review round 2, MAJOR 2 - the prior wording here
 *    claimed the token "is not returned", which was false): `panelUrl`
 *    EMBEDS the same bearer token in its URL fragment
 *    (`/impersonate#token=...&exp=...`) - a 2-minute-lived credential for
 *    the tenant workspace, readable by any script running on the admin page
 *    and by anyone who can see the staff member's screen while the URL is
 *    visible (e.g. an address bar, before the panel strips the fragment on
 *    entry - see `admin/frontend/src/features/impersonation/`). It is NOT a
 *    silent credential leak: it is the intended handoff mechanism (the panel
 *    opens `panelUrl` in a new tab via `window.open(panelUrl, '_blank',
 *    'noopener')` and never renders or logs it as text), the grant is fully
 *    audited, time-boxed by the database, and revocable at any time
 *    (`docs/RUNBOOK.md`'s `## staff-accounts` and `docs/RUNNING-LOCALLY.md`'s
 *    "Admin console" section both restate this for anyone operating the
 *    system). What THIS module still guarantees: the token never appears as
 *    a bare top-level JSON field, never gets logged by `mutation-proxy.ts`,
 *    and a REPLAYED Idempotency-Key returns `panelUrl: null` (below) rather
 *    than re-emitting a live credential from `staff_audit_log.result` -
 *    `internal/impersonation.ts`'s `mintImpersonationTokenOutputSchema`
 *    makes the matching call one layer down.
 */

/**
 * The `panelEntryPath` the internal API returns, joined to the tenant
 * panel's base URL with exactly one slash between them (a doubled slash
 * breaks some reverse proxies' path matching).
 */
function joinPanelUrl(baseUrl: string, entryPath: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = entryPath.startsWith('/') ? entryPath : `/${entryPath}`;
  return `${base}${suffix}`;
}

export interface ImpersonationMutationDeps extends MutationProxyDeps {
  /** The TENANT panel's base URL (`APP_PANEL_BASE_URL`) - never the admin panel's. */
  appPanelBaseUrl: string;
}

interface ImpersonationResultLike {
  grantId?: unknown;
  expiresAt?: unknown;
  scope?: unknown;
  /** `null` on a replayed mint (see module header); a non-mint route (grant/elevate) never sets it. */
  panelEntryPath?: unknown;
  /** Present (non-null) on the mint response's WINNING call only; DELIBERATELY NOT forwarded as its own field - see module header. */
  accessToken?: unknown;
  replayed?: unknown;
}

export function registerImpersonationMutations(
  app: FastifyInstance,
  deps: ImpersonationMutationDeps,
  outputSchema: ZodType,
): void {
  const shape = (data: unknown): unknown => {
    const result = data as ImpersonationResultLike;
    // A replayed mint carries `panelEntryPath: null` (the internal route
    // never re-emits the token) - `panelUrl` must stay `null` too, never
    // fall back to the placeholder entry path, or a replay would silently
    // hand back a URL with no credential in it that still LOOKS like a
    // fresh grant.
    const panelUrl =
      result.replayed === true
        ? null
        : joinPanelUrl(
            deps.appPanelBaseUrl,
            typeof result.panelEntryPath === 'string'
              ? result.panelEntryPath
              : '/impersonation/enter',
          );
    return {
      grantId: result.grantId,
      expiresAt: result.expiresAt,
      scope: result.scope,
      panelUrl,
    };
  };

  registerMutationProxy(app, deps, {
    method: 'POST',
    path: '/admin/v1/clients/:id/impersonation',
    action: 'impersonation.grant',
    internalPath: (params) => `/internal/v1/clients/${params.id ?? ''}/impersonation`,
    inputSchema: grantImpersonationInputSchema,
    outputSchema,
    shapeResponse: shape,
  });

  registerMutationProxy(app, deps, {
    method: 'POST',
    path: '/admin/v1/impersonation/:grantId/token',
    // Minting a token for an existing grant is the same authority as
    // creating one - a `support` member who may grant may also enter.
    action: 'impersonation.grant',
    internalPath: (params) => `/internal/v1/impersonation/${params.grantId ?? ''}/token`,
    inputSchema: mintImpersonationTokenInputSchema,
    outputSchema,
    shapeResponse: shape,
  });

  registerMutationProxy(app, deps, {
    // `superadmin` only: this is the single path to a tenant's message
    // bodies, and the database caps the elevated grant at 15 minutes.
    method: 'POST',
    path: '/admin/v1/impersonation/:grantId/elevate',
    action: 'impersonation.elevate',
    internalPath: (params) => `/internal/v1/impersonation/${params.grantId ?? ''}/elevate`,
    inputSchema: elevateImpersonationInputSchema,
    outputSchema,
    shapeResponse: shape,
  });
}
