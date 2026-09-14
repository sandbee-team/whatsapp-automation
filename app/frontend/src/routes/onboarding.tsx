import { createFileRoute, redirect } from '@tanstack/react-router';
import { OnboardingWizard } from '../features/onboarding/index.js';
import { ensureSession } from '../lib/api-client.js';

/**
 * `/onboarding` (2026-09-08 panel refresh defect fix) - this route sits
 * OUTSIDE `_authed` (the wizard runs before a client is fully onboarded) but
 * still needs a session: without a guard, a hard load with no in-memory
 * access token fired `GET /v1/onboarding` unauthenticated, got a 401, and
 * rendered a blank page. Mirrors `_authed.tsx`'s `beforeLoad` exactly: await
 * the shared one-shot refresh, redirect to `/login` on failure, before the
 * wizard (or its data fetches) ever renders.
 */
export const Route = createFileRoute('/onboarding')({
  beforeLoad: async () => {
    const authenticated = await ensureSession();
    if (!authenticated) {
      throw redirect({ to: '/login' });
    }
  },
  component: OnboardingWizard,
});
