import { createFileRoute, redirect } from '@tanstack/react-router';
import { onboardingStepSchema } from '@wp/contracts';
import { getOnboardingStatus } from '../../features/onboarding/index.js';
import { DashboardPage } from '../../features/dashboard/index.js';

/**
 * `/` (P05 U5, phase step 9; P26b U3 replaces the zero-state-only page with
 * the real dashboard) - the authed dashboard's default child route. The
 * client is admitted to the dashboard once `onboardingStep` reaches
 * `connect_whatsapp` (the backend's own entitlement threshold, R-56,
 * decided 2026-09-07) rather than waiting for the wizard's terminal `done`:
 * `connect_whatsapp`/`send_test`/`done` all render the dashboard (the
 * "Getting started" checklist on the page itself carries the remaining
 * steps), anything BEFORE `connect_whatsapp` in `onboardingStepSchema`'s
 * own declared order redirects to `/onboarding` to resume the wizard.
 */
const CONNECT_WHATSAPP_STEP_INDEX = onboardingStepSchema.options.indexOf('connect_whatsapp');

export const Route = createFileRoute('/_authed/')({
  beforeLoad: async () => {
    const status = await getOnboardingStatus();
    const stepIndex = onboardingStepSchema.options.indexOf(status.step);
    if (stepIndex < CONNECT_WHATSAPP_STEP_INDEX) {
      throw redirect({ to: '/onboarding' });
    }
  },
  component: DashboardPage,
});
