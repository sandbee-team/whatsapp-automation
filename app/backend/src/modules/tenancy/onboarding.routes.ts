import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  setConsentInputSchema,
  setPacingProfileInputSchema,
  setTimezoneInputSchema,
} from '@wp/contracts';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import {
  getOnboardingStatus,
  setConsent,
  setPacingProfile,
  setTimezone,
  type OnboardingCtx,
} from './onboarding.service.js';

/**
 * onboarding.routes.ts (P04b Unit UB1b, phase step 8) - binds
 * `@wp/contracts`'s `onboardingContract` to `onboarding.service.ts`. All
 * routes are `policy: 'session'` (any authenticated caller may read/advance
 * their OWN client's onboarding state; entitlement gating is a SEPARATE
 * concern - see `platform/http/guards.ts` - applied only to routes that need
 * it, like the Connect-WhatsApp stub).
 */

export interface OnboardingRoutesDeps {
  onboardingCtx: OnboardingCtx;
}

async function guarded(
  reply: Parameters<typeof sendError>[0],
  requestId: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const mapped =
      err instanceof z.ZodError ? new ValidationMappedError('Invalid request body.') : err;
    sendError(reply, requestId, mapped);
  }
}

class ValidationMappedError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationMappedError';
  }
}

export function registerOnboardingRoutes(
  app: FastifyInstance,
  deps: OnboardingRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/onboarding',
    policy: 'session',
    scope: 'onboarding:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const status = await getOnboardingStatus(deps.onboardingCtx, auth.clientId);
        sendSuccess(reply, requestId, status);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/onboarding/timezone',
    policy: 'session',
    scope: 'onboarding:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const input = setTimezoneInputSchema.parse(req.body);
        const result = await setTimezone(deps.onboardingCtx, {
          clientId: auth.clientId,
          timezone: input.timezone,
        });
        sendSuccess(reply, requestId, result);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/onboarding/pacing-profile',
    policy: 'session',
    scope: 'onboarding:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const input = setPacingProfileInputSchema.parse(req.body);
        const result = await setPacingProfile(deps.onboardingCtx, {
          clientId: auth.clientId,
          profileKey: input.profileKey,
        });
        sendSuccess(reply, requestId, result);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/onboarding/consent',
    policy: 'session',
    scope: 'onboarding:write',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        setConsentInputSchema.parse(req.body);
        const result = await setConsent(deps.onboardingCtx, {
          clientId: auth.clientId,
          userId: auth.userId,
        });
        sendSuccess(reply, requestId, result);
      });
    },
  });
}
