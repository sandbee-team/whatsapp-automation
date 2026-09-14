import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerIdentityRoutes, type IdentityRoutesDeps } from '../../modules/identity/index.js';
import {
  registerOnboardingRoutes,
  type OnboardingRoutesDeps,
} from '../../modules/tenancy/index.js';
import {
  registerInstancesRoutes,
  registerResumeRoute,
  registerCardRoutes,
  type InstancesRoutesDeps,
  type ResumeRoutesDeps,
  type CardRoutesDeps,
} from '../../modules/instances/index.js';
import { registerMessagesRoutes, type MessagesRoutesDeps } from '../../modules/messages/index.js';
import { registerRealtimeRoutes, type RealtimeRoutesDeps } from '../../modules/realtime/index.js';
import { registerUnresolvedRoutes, type UnresolvedRoutesDeps } from '../../modules/queue/index.js';
import {
  registerAckFanoutRoutes,
  registerWhyRoutes,
  type AckFanoutRoutesDeps,
  type WhyRoutesDeps,
} from '../../modules/pacing/index.js';
import {
  registerDashboardRoutes,
  type DashboardRoutesDeps,
} from '../../modules/dashboard/index.js';
import { registerWebhooksRoutes, type WebhooksRoutesDeps } from '../../modules/webhooks/index.js';
import { registerApiKeysRoutes, type ApiKeysRoutesDeps } from '../../modules/api-keys/index.js';
import { registerMediaRoutes, type MediaRoutesDeps } from '../../modules/media/index.js';
import {
  registerContactsRoutes,
  registerContactExportErasureRoutes,
  registerContactImportRoutes,
  type ContactsRoutesDeps,
  type ContactImportRoutesDeps,
} from '../../modules/contacts/index.js';
import {
  registerNotificationsRoutes,
  type NotificationsRoutesDeps,
} from '../../modules/notifications/index.js';
import {
  registerBroadcastRoutes,
  type BroadcastRoutesDeps,
} from '../../modules/broadcasts/index.js';
import { registerGroupsRoutes, type GroupRoutesDeps } from '../../modules/groups/index.js';
import {
  registerWalletRoutes,
  registerQueueStatusRoutes,
  type WalletRoutesDeps,
  type QueueStatusRoutesDeps,
} from '../../modules/wallet/index.js';
import { registerInternalRoutes, type InternalRoutesDeps } from '../../modules/internal/index.js';
import { assertRoutePolicyConfig, registerRoute } from './route-policy.js';
import { assertImpersonationAllowListRegistered } from './impersonation-write-guard.js';
import type { AuthDeps } from './auth-plugin.js';
import { requestIdFor, sendSuccess } from './error-mapper.js';

/**
 * platform/http/server.ts (P04a Unit UA6; extended P04b Unit UB1b with the
 * onboarding step-machine routes and the stub Connect-WhatsApp endpoint) -
 * assembles the Fastify app: the cookie plugin (refresh-token cookie,
 * `identity.routes.ts`), the public health-ping route, every identity auth
 * route, the onboarding routes, and the instances stub - ALL registered
 * through `route-policy.ts#registerRoute` (fail-closed routing, canon: no
 * route reaches Fastify any other way).
 */

export interface BuildAppDeps {
  identity: IdentityRoutesDeps;
  onboarding: OnboardingRoutesDeps;
  instances: InstancesRoutesDeps;
  messages: MessagesRoutesDeps;
  realtime: RealtimeRoutesDeps;
  unresolved: UnresolvedRoutesDeps;
  /**
   * Optional (P14 Unit U7) - the duplicate fan-out ack routes. Optional and
   * defaulting to "not registered" so the existing production caller
   * (`roles/api.ts`, outside this unit's file scope) keeps compiling
   * unchanged until a later unit wires a real `publishWake` binding through
   * it - same "optional dep, no route/no-op until wired" idiom
   * `messages.service.ts`'s `onEnqueued` already established.
   */
  pacing?: AckFanoutRoutesDeps;
  /** Optional (P15 Unit U5, step 8) - same "optional, not-registered until wired" idiom as `pacing` above. */
  webhooks?: WebhooksRoutesDeps;
  /** Optional (P16 Unit D, step 8) - `POST /v1/instances/:id/resume`, same "optional, not-registered until wired" idiom as `pacing`/`webhooks` above. */
  resume?: ResumeRoutesDeps;
  /** Optional (P17 Unit U6, step 6) - the in-app notifications API, same "optional, not-registered until wired" idiom as `pacing`/`webhooks`/`resume` above. */
  notifications?: NotificationsRoutesDeps;
  /** Optional (P17 close) - `GET /v1/instances/:id/card`. Same optional-dep idiom; `roles/api.ts` wires it in production. */
  card?: CardRoutesDeps;
  /** Optional (P17 close) - `GET /v1/instances/:id/health/why`. */
  healthWhy?: WhyRoutesDeps;
  /** Optional (P17 close, carried P05 item) - `GET /v1/dashboard/summary`. */
  dashboard?: DashboardRoutesDeps;
  /** Optional (P19 Unit U4, step 7) - the tenant wallet + top-up API. Same "optional, not-registered until wired" idiom as `pacing`/`webhooks`/`resume`/`notifications`/`card`/`healthWhy`/`dashboard` above. */
  wallet?: WalletRoutesDeps;
  /** Optional (P19 Unit U5, step 9) - `GET /v1/queue-status`. Same optional-dep idiom as `wallet` above. */
  queueStatus?: QueueStatusRoutesDeps;
  /** Optional (P19 Unit U5, step 8; P28 Unit U3a, step 4 - the real `/internal/v1` staff surface). Absent (not just false) when `INTERNAL_API_ENABLED` is off - `roles/api.ts` never passes this dep in that case, so the routes are entirely ABSENT (404), not merely forbidden. Same optional-dep idiom as `wallet`/`queueStatus` above. */
  internal?: InternalRoutesDeps;
  /** Optional (P20 Unit U4, step 4) - the tenant contacts + tags CRUD API. Same "optional, not-registered until wired" idiom as `wallet`/`webhooks` above. */
  contacts?: ContactsRoutesDeps;
  /** Optional (P20 Unit U6, step 5) - the CSV import upload/create/poll/cancel/errors surface. Same optional-dep idiom as `contacts` above; registered only when `contacts` is also present (export/erasure routes hang off the SAME `contacts` dep - see the registration call below). */
  contactImports?: ContactImportRoutesDeps;
  /** Optional (P23 Unit U5, step 6) - the tenant broadcast lifecycle API. Same "optional, not-registered until wired" idiom as `contacts`/`wallet` above. */
  broadcasts?: BroadcastRoutesDeps;
  /** Optional (P24 Unit U3, step 4/5) - the tenant groups API (list/enable-disable/leave). Same "optional, not-registered until wired" idiom as `broadcasts`/`contacts` above. */
  groups?: GroupRoutesDeps;
  /** Optional (go-live Unit U4) - the tenant `api_keys` CRUD API. Same "optional, not-registered until wired" idiom as `webhooks`/`groups` above. */
  apiKeys?: ApiKeysRoutesDeps;
  /** Optional (P34 U-upload, ADR 0052 accepted scope) - the outbound media upload/metadata API. Same "optional, not-registered until wired" idiom as `apiKeys`/`groups` above. */
  media?: MediaRoutesDeps;
  /** Shared `AuthDeps` for the non-identity route groups above (onboarding/instances/messages/realtime/unresolved/pacing/webhooks) - same shape identity.routes.ts builds via `authDepsFrom`. */
  authDeps: AuthDeps;
}

/** A minimal `AuthDeps` for routes that never need it (e.g. the public health check). */
function noAuthDeps(): AuthDeps {
  return {
    tokenEpochCtx: {
      redis: undefined as never,
      db: undefined as never,
      jwtSecret: '',
      epochCacheTtlSec: 0,
      env: '',
    },
    db: undefined as never,
    hasTotpEnrolled: async () => false,
  };
}

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  // FIX 9 (P04a FIXB): `trustProxy` is config-driven (default false) - a
  // hard-coded `true` let any caller spoof `req.ip` via X-Forwarded-For and
  // defeat every IP-scoped rate limit (cheap DoS on the public argon2 hash
  // path). See platform/config.ts's TRUST_PROXY doc comment.
  // `TRUST_PROXY`'s int-hop-count form is a real `proxy-addr`/Fastify runtime
  // option (used for exactly-N-trusted-hops deployments) that this Fastify
  // version's own types don't declare - cast, not a behavior change.
  const app = Fastify({
    trustProxy: deps.identity.config.TRUST_PROXY as string | boolean | string[],
  });
  await app.register(cookie);

  // M19 (P04a FIXB): fail-closed routing, made mechanical rather than
  // conventional - ANY route reaching Fastify without a `policy`/`scope` in
  // its `config` throws AT REGISTRATION TIME, even one that bypassed
  // `registerRoute` entirely (e.g. a bare `app.get(...)`).
  app.addHook('onRoute', assertRoutePolicyConfig);

  registerRoute(app, noAuthDeps(), {
    method: 'GET',
    path: '/v1/health/ping',
    policy: 'public',
    scope: 'health:ping',
    handler: (req, reply) => {
      sendSuccess(reply, requestIdFor(req), { ok: true, version: '0.0.0' });
    },
  });

  registerIdentityRoutes(app, deps.identity);
  registerOnboardingRoutes(app, deps.onboarding, deps.authDeps);
  registerInstancesRoutes(app, deps.instances, deps.authDeps);
  if (deps.resume) {
    registerResumeRoute(app, deps.resume, deps.authDeps);
  }
  registerMessagesRoutes(app, deps.messages, deps.authDeps);
  registerRealtimeRoutes(app, deps.realtime, deps.authDeps);
  registerUnresolvedRoutes(app, deps.unresolved, deps.authDeps);
  if (deps.pacing) {
    registerAckFanoutRoutes(app, deps.pacing, deps.authDeps);
  }
  if (deps.webhooks) {
    registerWebhooksRoutes(app, deps.webhooks, deps.authDeps);
  }
  if (deps.notifications) {
    registerNotificationsRoutes(app, deps.notifications, deps.authDeps);
  }
  if (deps.card) {
    registerCardRoutes(app, deps.card, deps.authDeps);
  }
  if (deps.healthWhy) {
    registerWhyRoutes(app, deps.healthWhy, deps.authDeps);
  }
  if (deps.dashboard) {
    registerDashboardRoutes(app, deps.dashboard, deps.authDeps);
  }
  if (deps.wallet) {
    registerWalletRoutes(app, deps.wallet, deps.authDeps);
  }
  if (deps.queueStatus) {
    registerQueueStatusRoutes(app, deps.queueStatus, deps.authDeps);
  }
  if (deps.internal) {
    registerInternalRoutes(app, deps.internal, deps.authDeps);
  }
  if (deps.contacts) {
    registerContactsRoutes(app, deps.contacts, deps.authDeps);
    registerContactExportErasureRoutes(app, deps.contacts, deps.authDeps);
  }
  if (deps.contactImports) {
    registerContactImportRoutes(app, deps.contactImports, deps.authDeps);
  }
  if (deps.broadcasts) {
    registerBroadcastRoutes(app, deps.broadcasts, deps.authDeps);
  }
  if (deps.groups) {
    registerGroupsRoutes(app, deps.groups, deps.authDeps);
  }
  if (deps.apiKeys) {
    registerApiKeysRoutes(app, deps.apiKeys, deps.authDeps);
  }
  if (deps.media) {
    registerMediaRoutes(app, deps.media, deps.authDeps);
  }

  // C1 review round 2 MINOR fix: proves every impersonation-write-guard
  // allow-list entry names a route Fastify actually registered - run once,
  // after every route above has registered, so a typo'd/renamed template
  // throws at boot instead of silently protecting nothing. The two
  // `/v1/notifications/*` entries are skipped when `deps.notifications` was
  // never passed - every existing test harness (and some future partial
  // build) legitimately wires only a subset of modules; a REAL production
  // `buildApp()` always wires `notifications`, so the check stays strict
  // there.
  assertImpersonationAllowListRegistered(
    app,
    (entry) => !deps.notifications && entry.startsWith('POST /v1/notifications/'),
  );

  return app;
}
