/**
 * modules/tenancy - the ONLY public surface of this module (layering rule
 * §3.2: another module imports only this file, never a sibling directly;
 * enforced by dependency-cruiser's no-deep-module-import).
 */
export * as provisioningRepo from './provisioning.repo.js';

// P28 U5 (item 2): onboarding.repo.ts's send_test/done advance functions,
// used directly by markLinkedConnected (modules/instances/) and
// createMessage (modules/messages/) - re-exported here rather than through
// onboarding.service.ts, since neither call site needs the service's own
// pool/OnboardingCtx transaction wrapper (both already run inside their own
// caller's transaction/statement).
export { advanceToSendTestIfConnecting, advanceToDoneIfSendTest } from './onboarding.repo.js';

export {
  assertCanConnect,
  assertCanSend,
  EmailNotVerifiedError,
  EntitlementDeniedError,
  type EntitlementCtx,
  type EntitlementDbClient,
  type EntitlementDbPool,
  type EntitlementInput,
} from './entitlement.service.js';

export {
  getOnboardingStatus,
  setTimezone,
  setPacingProfile,
  setConsent,
  OnboardingOutOfOrderError,
  ClientNotFoundError,
  type OnboardingCtx,
  type OnboardingDbClient,
  type OnboardingDbPool,
  type OnboardingStatus,
} from './onboarding.service.js';

export { registerOnboardingRoutes, type OnboardingRoutesDeps } from './onboarding.routes.js';
