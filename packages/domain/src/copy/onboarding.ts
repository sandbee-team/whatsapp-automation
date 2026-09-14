/**
 * ONBOARDING_COPY - the SOLE source of every user-facing string the P04b
 * signup/verify/login/TOTP/onboarding-wizard UI renders (app/frontend). No
 * component may hand-roll a copy literal; every label/title/button/error
 * string is imported from here (invariant 6: honest product, no
 * restriction-avoidance claims - `scripts/check-copy.ts` scans this file
 * too).
 *
 * `safeModeDisclaimer` below is a template literal, not a re-export of
 * `SAFE_MODE_DISCLAIMER`, on purpose: `scripts/check-copy.ts` does a plain
 * substring match of each file's own text on disk, so the literal has to
 * live in THIS file's source bytes, not just be reachable through an
 * import. A test (`tests/copy/onboarding-copy.test.ts`) proves the two
 * stay byte-identical (drift guard) - see also the disclaimer's own
 * "why a template literal" note in disclosures.ts.
 *
 * `attestConsent.statements` (P29a step 10) are the same six plain-language
 * statements published in `website/content/legal/terms.mdx` §4, byte-
 * identical (`website/tests/legal.test.ts` proves both surfaces match).
 * `attestConsent.tosVersion` is `TOS_VERSION` (`./tos-version.js`) - the
 * dated terms version the backend records on the workspace when this step
 * is submitted.
 */

import { TOS_VERSION } from './tos-version.js';

const SAFE_MODE_DISCLAIMER_LITERAL = `Safe Mode paces your sending and watches your account's real signals. It reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold. It cannot prevent or guarantee against WhatsApp restrictions — bans also come from recipient reports, message content and account reputation, which no sender-side pacing can control.`;

/**
 * Ban-risk disclosure (consent step). Substance only, per canon open item
 * 23: linking a number carries real platform risk, WP has no appeal path
 * for a WhatsApp-side restriction, and Safe Mode only reduces sender-side
 * velocity risk - it is not a guarantee.
 */
const BAN_RISK_DISCLOSURE = `Connecting your WhatsApp number to WP links that number to this workspace for sending. WhatsApp may restrict or ban a number for any reason it determines, and WP has no appeal path for a WhatsApp-side restriction — we cannot get a number un-banned or reviewed on your behalf. Safe Mode only reduces the sender-side velocity risk (sending too fast or too cold); it has no effect on restrictions caused by recipient reports, message content or account reputation.`;

/** Consent attestation statement (checkbox copy, consent step). */
const CONSENT_ATTESTATION_STATEMENT = `I confirm that everyone I contact through WP has agreed to be contacted by this business, and I accept responsibility for the content of the messages I send.`;

/**
 * The six plain-language statements from `terms.mdx` §4, byte-identical
 * (see `website/tests/legal.test.ts`). Rendered as an ordered list ahead of
 * the ban-risk disclosure on the consent step so a workspace owner reads
 * the substance before attesting.
 */
const CONSENT_STATEMENTS = Object.freeze([
  'WP connects as a linked device to your WhatsApp account. The account, the number, and its standing with WhatsApp are yours.',
  "WhatsApp may restrict or ban any account. WP's pacing controls reduce the risk of triggering spam or rate-limit signals from sending too fast or too cold; they cannot prevent or guarantee against WhatsApp restrictions. Bans also come from recipient reports, content, and account reputation — none of which sender-side pacing controls.",
  'You are responsible for having permission to message every recipient. You attest to this on import.',
  'If WhatsApp signals a restriction, WP stops sending on that number, keeps your queued messages, and tells you. WP will not automatically resume, will not switch you to another number, and will not attempt to work around the restriction.',
  "WP is a linked device, so WP's servers process your message content in the clear. WhatsApp's end-to-end encryption protects messages between devices; it does not and cannot hide content from a linked device you authorised.",
  'Your data retention defaults are listed above. Changing them, exporting your data, or deleting your workspace is done by request to WP support in this release; self-service export and deletion are planned and this sentence will change when they ship.',
] as const);

/**
 * Signup duplicate-account error copy. Deliberately generic (23505
 * existence-oracle rule, core rule 4/tenant isolation): never names or
 * hints at which field collided or which other workspace already exists.
 */
const SIGNUP_DUPLICATE_ACCOUNT_ERROR = `This account is already part of a workspace. Try signing in instead, or use a different email and phone number.`;

/**
 * Shown when a wizard step submit fails with a CONFLICT (the step the
 * client posted to is no longer the server's current step - e.g. the
 * wizard state moved on in another tab). Deliberately neutral/honest: never
 * echoes the backend-authored error message (P04b FIXF, C1 MAJOR-2).
 */
const STEP_UNAVAILABLE_ERROR = `This step is not available right now. Refresh the page to see your current step.`;

/**
 * Shown when `connectInstance` fails for a reason other than "not built
 * yet" (e.g. an entitlement denial) - honest about the account not being
 * eligible yet, never implying the product itself is broken or unbuilt
 * (P04b FIXF, C1 MAJOR-3).
 */
const NOT_ENTITLED_BODY = `Your account is not yet eligible to connect a WhatsApp number. Check that your email is verified and your workspace setup is complete.`;

export const ONBOARDING_COPY = Object.freeze({
  /** Byte-identical to `SAFE_MODE_DISCLAIMER` from disclosures.ts - see module doc above. */
  safeModeDisclaimer: SAFE_MODE_DISCLAIMER_LITERAL,

  signup: Object.freeze({
    title: 'Create your workspace',
    fullNameLabel: 'Full name',
    emailLabel: 'Work email',
    phoneLabel: 'Phone number',
    companyNameLabel: 'Company name',
    passwordLabel: 'Password',
    passwordHint: 'At least 12 characters.',
    submitButton: 'Create account',
    loginLinkPrompt: 'Already have an account?',
    loginLinkLabel: 'Sign in',
    successTitle: 'Check your email',
    successBody: 'We sent a verification link to your email address. Open it to continue.',
    duplicateAccountError: SIGNUP_DUPLICATE_ACCOUNT_ERROR,
    genericError: 'Something went wrong. Please try again.',
  }),

  verifyEmail: Object.freeze({
    title: 'Verifying your email',
    pendingBody: 'Confirming your verification link…',
    verifiedTitle: 'Email verified',
    verifiedBody: 'Your email is verified. You can now sign in.',
    loginLinkLabel: 'Go to sign in',
    invalidTitle: 'This link is not valid',
    invalidBody: 'This verification link is expired or has already been used.',
  }),

  login: Object.freeze({
    title: 'Sign in',
    emailLabel: 'Email',
    passwordLabel: 'Password',
    submitButton: 'Sign in',
    signupLinkPrompt: "Don't have an account?",
    signupLinkLabel: 'Create one',
    invalidCredentialsError: 'Incorrect email or password.',
    accountLockedError: 'This account is temporarily locked. Please try again later.',
    emailNotVerifiedError: 'Please verify your email before signing in.',
    genericError: 'Something went wrong. Please try again.',
  }),

  totp: Object.freeze({
    enrolTitle: 'Turn on two-factor authentication',
    enrolBody: 'Scan this code with your authenticator app, or enter the setup key manually.',
    secretLabel: 'Setup key',
    confirmCodeLabel: 'Enter the 6-digit code from your app',
    confirmButton: 'Confirm',
    recoveryCodesTitle: 'Save your recovery codes',
    recoveryCodesBody:
      'Store these recovery codes somewhere safe. Each one can be used once if you lose access to your authenticator app.',
    continueButton: 'Continue',
    verifyTitle: 'Enter your authentication code',
    verifyCodeLabel: '6-digit code',
    verifyButton: 'Verify',
    invalidCodeError: 'That code is not valid. Please try again.',
    genericError: 'Something went wrong. Please try again.',
  }),

  wizard: Object.freeze({
    title: 'Finish setting up your workspace',
    loading: 'Loading…',
    genericError: 'Something went wrong. Please try again.',
    retryButton: 'Retry',

    verifyEmailPending: Object.freeze({
      title: 'Check your email',
      body: 'Please verify your email address to continue setting up your workspace.',
    }),

    chooseTimezone: Object.freeze({
      title: 'Choose your timezone',
      body: 'Your timezone is used for scheduling and pacing windows.',
      timezoneLabel: 'Timezone',
      submitButton: 'Save and continue',
      genericError: 'Something went wrong. Please try again.',
    }),

    acceptPacingProfile: Object.freeze({
      title: 'Safe Mode pacing',
      body: 'Safe Mode is the default pacing profile for every new workspace.',
      disclaimer: SAFE_MODE_DISCLAIMER_LITERAL,
      profileLabel: 'Safe Mode (default)',
      submitButton: 'Accept and continue',
      genericError: 'Something went wrong. Please try again.',
      stepUnavailableError: STEP_UNAVAILABLE_ERROR,
    }),

    attestConsent: Object.freeze({
      title: 'Consent and responsibility',
      statementsTitle: 'What you are agreeing to',
      statements: CONSENT_STATEMENTS,
      banRiskDisclosure: BAN_RISK_DISCLOSURE,
      attestationStatement: CONSENT_ATTESTATION_STATEMENT,
      checkboxLabel: 'I agree to the statement above.',
      submitButton: 'Accept and continue',
      genericError: 'Something went wrong. Please try again.',
      stepUnavailableError: STEP_UNAVAILABLE_ERROR,
      tosVersionLabel: 'Terms version',
      tosVersion: TOS_VERSION,
      tosLinkLabel: 'Read the full terms',
    }),

    connectWhatsapp: Object.freeze({
      title: 'Connect your WhatsApp number',
      body: 'Connect your WhatsApp number to start sending from your workspace.',
      connectButton: 'Connect WhatsApp',
      notAvailableTitle: 'Not available yet in this phase',
      notAvailableBody:
        'Connecting a WhatsApp number is not available yet in this phase. This step will be enabled in a later release.',
      notEntitledBody: NOT_ENTITLED_BODY,
      genericError: 'Something went wrong. Please try again.',
    }),

    done: Object.freeze({
      title: "You're set up",
      body: 'Your workspace setup is complete.',
    }),
  }),
});

export type OnboardingCopy = typeof ONBOARDING_COPY;
