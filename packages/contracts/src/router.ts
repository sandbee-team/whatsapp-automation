import { oc } from '@orpc/contract';
import { z } from 'zod';
import { authContract } from './auth.js';
import { onboardingContract } from './onboarding.js';
import { instancesContract } from './instances.js';
import { realtimeContract } from './app/realtime.js';
import { webhooksContract } from './app/webhooks.js';
import { dashboardContract } from './app/dashboard.js';
import { walletContract } from './app/wallet.js';
import { notificationsContract } from './notifications.js';
import { instanceCardContractGroup } from './instance-card.js';
import { contactsContract } from './contacts.js';
import { contactImportsContract } from './contact-imports.js';
import { broadcastsContract } from './app/broadcasts.js';
import { successEnvelope } from './envelope.js';

/**
 * The oRPC contract router skeleton (real `@orpc/contract`, not a hand-rolled
 * fallback - its `oc.route(...).input(...).output(...)` builder works
 * browser-pure against a Zod v4 `Standard Schema`, so ADR 0002's oRPC choice
 * is honoured directly). Only `@orpc/contract` is a dependency here -
 * `@orpc/server` is Node-only wiring that belongs to `app/backend`, never to
 * this browser-shared package.
 */

const healthPingOutput = successEnvelope(
  z.object({
    ok: z.literal(true),
    version: z.string(),
  }),
);

export const healthPingContract = oc
  .route({ method: 'GET', path: '/v1/health/ping' })
  .output(healthPingOutput);

/**
 * `appContract` is the namespace future route groups hang off. One
 * commented example shows the future shape (a real route is added the day a
 * module needs it, per docs/CONVENTIONS.md §6.1 route naming and §3.3 of the
 * repo-structure research doc):
 *
 * export const appContract = {
 *   health: { ping: healthPingContract },
 *   app: {
 *     messages: {
 *       send: oc
 *         .route({ method: 'POST', path: '/v1/messages' })
 *         .input(SendMessageInput)
 *         .output(successEnvelope(MessageJobDTO)),
 *     },
 *   },
 * } as const;
 */
export const appContract = {
  health: {
    ping: healthPingContract,
  },
  auth: authContract,
  onboarding: onboardingContract,
  // P08 Unit U6c: the real instance link/park routes, replacing the P04b
  // 501-only stub (modules/instances/instances.routes.ts).
  instances: instancesContract,
  realtime: realtimeContract,
  webhooks: webhooksContract,
  dashboard: dashboardContract,
  // P19 Unit U2, step 3: the tenant wallet surface (GET /v1/wallet,
  // topup-requests). The STAFF wallet surface (internal/wallet.ts's
  // internalContract) is a separate route group, never hung off
  // appContract - it is mounted independently by the backend.
  wallet: walletContract,
  // P17 Unit U2, step 2: the notifications list/unread-count/mark-read
  // routes and the instance card / health-why routes.
  notifications: notificationsContract,
  instanceCard: instanceCardContractGroup,
  // P20 Unit U4, step 4: the tenant contacts + tags CRUD surface.
  contacts: contactsContract,
  // P20 Unit U6, step 5/7: the CSV import upload/create/poll/cancel/errors
  // surface, plus the export/erasure routes hung off the same contract group.
  contactImports: contactImportsContract,
  // P23 Unit U5, step 6: the tenant broadcast lifecycle surface.
  broadcasts: broadcastsContract,
} as const;

export type AppContract = typeof appContract;
