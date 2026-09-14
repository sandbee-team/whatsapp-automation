import type { Catalogue } from './catalogue-type.js';

/**
 * English strings for the 2026-09-08 onboarding + auth layout refresh;
 * hi-onboarding.ts mirrors every key. Covers the wizard rail eyebrow/step
 * counter/reassurance line, the per-step one-line descriptions shown next to
 * the vertical `Stepper`, and the done-step ring's accessible label - every
 * other wizard string still comes from `@wp/domain`'s `ONBOARDING_COPY`
 * (unchanged, read-only from this unit).
 */
export const enOnboarding = {
  'onboarding.authLayout.footerLine': 'Built for teams that send responsibly.',
  'onboarding.wizard.railEyebrow': 'Workspace setup',
  'onboarding.wizard.stepOf': 'Step {current} of {total}',
  'onboarding.wizard.reassurance': 'You can change any of this later in Settings.',
  'onboarding.wizard.doneRingLabel': 'Setup complete',
  'onboarding.wizard.stepDescription.verifyEmail': 'Confirm it is really you.',
  'onboarding.wizard.stepDescription.timezone': 'Used for scheduling and pacing windows.',
  'onboarding.wizard.stepDescription.pacingProfile': 'Review your default sending pace.',
  'onboarding.wizard.stepDescription.consent': 'Confirm your sending responsibilities.',
  'onboarding.wizard.stepDescription.connect': 'Link your WhatsApp number.',
} as const satisfies Catalogue;
