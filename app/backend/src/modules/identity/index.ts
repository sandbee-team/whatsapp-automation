/**
 * modules/identity - the ONLY public surface of this module (layering rule:
 * other modules import only this file, never a sibling file directly). The
 * route-registration function plus the typed error classes a caller might
 * reasonably need to branch on.
 */
export {
  registerIdentityRoutes,
  type IdentityRoutesDeps,
  type IdentityMailerDeps,
} from './identity.routes.js';
export {
  signup,
  SignupConflictError,
  DefaultPriceListMissingError,
  NoDefaultPlanError,
  type SignupCtx,
  type SignupInput,
  type SignupResult,
} from './signup.service.js';
export { AuthenticationError, AccountLockedError } from './login.service.js';
export { InvalidVerificationTokenError } from './verify-email.service.js';
export { UnauthenticatedError } from './session.service.js';
export {
  MfaNotEnrolledError,
  InvalidTotpCodeError,
  InvalidRecoveryCodeError,
  MfaAlreadyEnrolledError,
} from './totp.service.js';
export { getUserTotpState, type UserTotpState } from './mfa.repo.js';
export {
  type AccessTokenClaims,
  type ImpersonationClaims,
  type TokenEpochCtx,
  writeEpochCache,
} from './token-epoch.js';
export { getUserTokenEpoch, bumpTokenEpoch } from './identity.repo.js';
export {
  signImpersonationToken,
  IMPERSONATION_TOKEN_TTL_SEC,
  type SignImpersonationTokenInput,
} from './impersonation-token.js';
export { impersonationOf, isMetadataOnly, redactMessageBodies } from './impersonation-principal.js';
