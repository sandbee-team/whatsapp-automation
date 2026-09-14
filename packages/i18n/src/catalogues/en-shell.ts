import type { Catalogue } from './catalogue-type.js';

/** English strings for the P26b U2 app shell, auth and onboarding (filled by that unit only; hi-shell.ts mirrors every key). */
export const enShell = {
  'nav.overview': 'Overview',
  'nav.messaging': 'Messaging',
  'nav.audience': 'Audience',
  'nav.messages': 'Send',
  'nav.webhooks': 'Webhooks',
  'nav.apiKeys': 'API keys',
  'nav.wallet': 'Wallet',
  'nav.security': 'Security',

  'shell.theme.label': 'Theme',
  'shell.theme.system': 'System',
  'shell.theme.light': 'Light',
  'shell.theme.dark': 'Dark',
  'shell.sidebar.collapse': 'Collapse',
  'shell.userMenu.trigger': 'Open account menu',
  'shell.topBar.openNav': 'Open navigation',
  'shell.commandPalette.placeholder': 'Search pages…',
  'shell.commandPalette.empty': 'No matching pages.',
  'shell.commandPalette.inputLabel': 'Search pages',

  'shell.authLayout.tagline': 'Reliable WhatsApp messaging for your whole team.',
  'shell.authLayout.bulletDurable': 'Every message starts as a durable job - nothing is lost.',
  'shell.authLayout.bulletHealth': 'Live health monitoring for every connected number.',
  'shell.authLayout.bulletTenant': 'Your workspace data stays isolated from every other tenant.',

  'shell.notFound.title': 'Page not found',
  'shell.notFound.body': "The page you're looking for doesn't exist or may have moved.",
  'shell.notFound.homeLink': 'Go to dashboard',

  'shell.errorBoundary.title': 'Something went wrong',
  'shell.errorBoundary.body': 'This page could not be loaded. Please try again.',
  'shell.errorBoundary.retryButton': 'Retry',

  'shell.stepper.completed': 'Completed',
  'shell.stepper.current': 'Current step',
  'shell.stepper.upcoming': 'Upcoming',

  'shell.wizard.stepVerifyEmail': 'Verify email',
  'shell.wizard.stepTimezone': 'Time zone',
  'shell.wizard.stepPacingProfile': 'Pacing profile',
  'shell.wizard.stepConsent': 'Consent',
  'shell.wizard.stepConnect': 'Connect a number',
  'shell.wizard.continueToDashboard': 'Continue to dashboard',
  'shell.wizard.connectSecureAccountTitle': 'Secure your account first',
  'shell.wizard.connectSecureAccountBody':
    "Two-factor authentication is required before you can connect a number. You'll need to sign in again once it's set up.",

  'shell.auth.showPassword': 'Show password',
  'shell.auth.hidePassword': 'Hide password',
  'shell.auth.passwordStrength': 'Password strength',
  'shell.auth.passwordStrength.weak': 'Weak',
  'shell.auth.passwordStrength.fair': 'Fair',
  'shell.auth.passwordStrength.good': 'Good',
  'shell.auth.passwordStrength.strong': 'Strong',
  'shell.auth.signupLoginLink': 'Sign in',
  'shell.auth.loginSignupLink': 'Create one',
  'shell.auth.devMailpitHint': 'Development: open Mailpit to view the verification email.',
  'shell.auth.backToSignIn': 'Back to sign in',
  'shell.auth.forgotPasswordLink': 'Forgot your password?',
  'shell.auth.recoveryCodesCopyHint': 'Copy each code before you continue - they are shown once.',
  'shell.auth.totpEnrolContinueButton': 'Sign in again to activate two-factor',

  'settings.security.title': 'Security',
  'settings.security.email.title': 'Email',
  'settings.security.email.verified': 'Verified',
  'settings.security.email.notVerified': 'Not verified',
  'settings.security.mfa.title': 'Two-factor authentication',
  'settings.security.mfa.notSetUp': 'Not set up',
  'settings.security.mfa.enabledSince': 'Enabled since {date}',
  'settings.security.mfa.reenrolNotAvailable':
    'Recovery codes were shown once at setup. Re-enrolling two-factor is not available in the panel yet.',
  'settings.security.password.title': 'Password',
  'settings.security.password.currentLabel': 'Current password',
  'settings.security.password.newLabel': 'New password',
  'settings.security.password.newDescription': 'At least 12 characters.',
  'settings.security.password.confirmLabel': 'Confirm new password',
  'settings.security.password.confirmMismatch': 'Passwords do not match.',
  'settings.security.password.submitButton': 'Change password',
  'settings.security.password.successToast': 'Your password has been changed.',
  'settings.security.password.otherSessionsRevoked':
    'Your other sessions were signed out for your security.',
  'settings.security.password.wrongCurrentPassword': 'That current password is incorrect.',
  'settings.security.password.genericError': 'Something went wrong. Please try again.',
  'settings.security.session.title': 'Session',

  'shell.auth.forgotPassword.title': 'Forgot your password?',
  'shell.auth.forgotPassword.description':
    "Enter your account email and we'll send you a link to reset your password.",
  'shell.auth.forgotPassword.emailLabel': 'Email',
  'shell.auth.forgotPassword.submitButton': 'Send reset link',
  'shell.auth.forgotPassword.confirmation':
    "If an account exists for that email, we've sent a link. It expires in 30 minutes.",
  'shell.auth.forgotPassword.backToSignIn': 'Back to sign in',

  'shell.auth.resetPassword.title': 'Reset your password',
  'shell.auth.resetPassword.description': 'Choose a new password for your account.',
  'shell.auth.resetPassword.newLabel': 'New password',
  'shell.auth.resetPassword.confirmLabel': 'Confirm new password',
  'shell.auth.resetPassword.confirmMismatch': 'Passwords do not match.',
  'shell.auth.resetPassword.submitButton': 'Reset password',
  'shell.auth.resetPassword.successToast': 'Your password has been reset. Please sign in.',
  'shell.auth.resetPassword.invalidTokenTitle': 'This link is not valid',
  'shell.auth.resetPassword.invalidTokenBody':
    'This reset link is expired or has already been used.',
  'shell.auth.resetPassword.requestNewLinkButton': 'Request a new link',

  'impersonation.banner.active': 'Support session · {staffLabel} · {scope} · ends in {countdown}',
  'impersonation.banner.ended': 'Support session ended',
  'impersonation.banner.scopeMetadataOnly': 'Account metadata only',
  'impersonation.banner.scopeWithBodies': 'Message content access granted',
  'impersonation.banner.endSessionButton': 'End session',

  'impersonation.entry.invalidTitle': 'This support session link is not valid',
  'impersonation.entry.invalidBody':
    'This link is missing or has expired. Please request a new one.',
  'impersonation.entry.returnToLoginButton': 'Return to login',
} as const satisfies Catalogue;
