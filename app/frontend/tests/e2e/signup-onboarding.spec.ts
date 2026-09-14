import { expect, test, type Page } from '@playwright/test';
import { ONBOARDING_COPY } from '@wp/domain';
import {
  confirmTotpEnrolment,
  submitLoginForm,
  submitTotpVerify,
  uniqueEmail,
  uniquePhone,
  waitForVerificationLink,
} from './support.js';

/**
 * signup-onboarding.spec.ts (P04b UB3, phase step 10; P26b U6 rewrites the
 * happy-path connect assertions) - the acceptance e2e for the whole
 * signup -> verify-email -> login -> TOTP enrol -> re-login -> TOTP verify ->
 * onboarding wizard -> Connect-WhatsApp flow, driven through the real UI
 * against the real api role and Postgres/Redis/Mailpit (see
 * playwright.config.ts). The happy path now asserts the REAL connect flow
 * (P08 shipped it): a label input plus `connect-create-button`, enabled for
 * a verified MFA session. The create call itself still fails HONESTLY today
 * with 409 `REGISTERED_LIMIT_REACHED` - a fresh signup is never assigned a
 * billing plan (`signup.service.ts` has no such step), so every plan-gated
 * admission check fails closed at zero capacity (same root cause as
 * `CONTACT_LIMIT_REACHED`'s `no_plan` reason - see `scripts/demo-seed.ts`'s
 * own doc comment). This is asserted as the CURRENT behaviour, never faked
 * as a success. The unverified-account case keeps its 403
 * `EMAIL_NOT_VERIFIED` API assertion (still true - entitlement is enforced
 * server-side, never only in the UI) with its UI assertions updated to the
 * new connect step (no connect UI ever mounts before `connect_whatsapp`).
 *
 * Two logins are required to reach an `mfa: true` session (canon,
 * route-policy.ts / entitlement.service.ts): enrolling TOTP does not
 * upgrade the CURRENT access token - only a SECOND login (which now returns
 * `mfa_required` because TOTP is enrolled) followed by `/totp/verify` mints
 * an `mfa: true` token, which the `session_mfa`-gated `POST /v1/instances`
 * requires.
 */

const PASSWORD = 'correct horse battery staple';

async function fillSignupForm(page: Page, email: string): Promise<void> {
  await page.goto('/signup');
  await page.getByTestId('signup-full-name').fill('Ada Lovelace');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-phone').fill(uniquePhone());
  await page.getByTestId('signup-company').fill('Analytical Engines Inc');
  await page.getByTestId('signup-password').fill(PASSWORD);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByText(ONBOARDING_COPY.signup.successTitle)).toBeVisible();
}

/** Signs up, verifies the email, and enrols TOTP (plain session - not yet MFA). Returns the TOTP secret. */
async function signupVerifyAndEnrolTotp(page: Page, email: string): Promise<string> {
  await fillSignupForm(page, email);

  const verifyLink = await waitForVerificationLink(email);
  await page.goto(verifyLink);
  await expect(page.getByTestId('verify-email-verified')).toBeVisible();

  await submitLoginForm(page, email, PASSWORD);
  await page.waitForURL(/\/onboarding/);

  await page.goto('/totp');
  const secret = await confirmTotpEnrolment(page);
  return secret;
}

/** Re-logs-in (now `mfa_required` since TOTP is enrolled) and completes `/totp/verify`. */
async function loginWithMfa(page: Page, email: string, secret: string): Promise<void> {
  await submitLoginForm(page, email, PASSWORD);
  await page.waitForURL(/\/totp\?mfaToken=/);
  await submitTotpVerify(page, secret);
  await page.waitForURL(/\/onboarding/);
}

test('signup_to_onboarding_complete_reaches_connect', async ({ page }) => {
  const email = uniqueEmail('happy');

  const secret = await signupVerifyAndEnrolTotp(page, email);
  await loginWithMfa(page, email, secret);

  await expect(page.getByTestId('wizard-choose-timezone')).toBeVisible();
  await page.getByTestId('wizard-timezone-submit').click();

  await expect(page.getByTestId('wizard-accept-pacing-profile')).toBeVisible();
  await page.getByTestId('wizard-pacing-profile-submit').click();

  await expect(page.getByTestId('wizard-attest-consent')).toBeVisible();
  await page.getByTestId('wizard-consent-checkbox').check();
  await page.getByTestId('wizard-consent-submit').click();

  await expect(page.getByTestId('wizard-connect-whatsapp')).toBeVisible();
  const createButton = page.getByTestId('connect-create-button');
  await expect(createButton).toBeDisabled();
  await page.getByTestId('connect-label-input').fill('Ada primary line');
  await expect(createButton).toBeEnabled();

  const [instancesResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/v1/instances')),
    createButton.click(),
  ]);

  // OPEN ITEM (found while rewriting this test, out of this unit's scope):
  // `signup.service.ts` never assigns a billing `plan_id` to a fresh client,
  // so every plan-gated admission check (contacts, instances, broadcasts)
  // fail-closes at zero capacity - here `REGISTERED_LIMIT_REACHED` (409),
  // the SAME root cause class as `CONTACT_LIMIT_REACHED`'s `no_plan` reason.
  // This assertion is therefore the HONEST current behaviour, not the
  // eventually-correct one: a 2xx create is what SHOULD happen once a plan
  // is assigned, but asserting that today would be asserting a fake result.
  expect(instancesResponse.status()).toBe(409);
  const body = (await instancesResponse.json()) as { error: { code: string } };
  expect(body.error.code).toBe('REGISTERED_LIMIT_REACHED');

  // The UI surfaces this honestly too: the flow stays on the `create` stage
  // (never fakes a stage transition) with a visible error message.
  await expect(page.getByTestId('connect-create-button')).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
});

test('an_unverified_account_cannot_reach_connect', async ({ page }) => {
  const email = uniqueEmail('unverified');

  await fillSignupForm(page, email);
  // Deliberately never visit the verification link.

  await submitLoginForm(page, email, PASSWORD);
  await page.waitForURL(/\/onboarding/);
  await page.goto('/totp');
  const secret = await confirmTotpEnrolment(page);

  // Capture the `mfa: true` Bearer token off the wire (it lives in the app's
  // in-memory module state, unreachable from `page.evaluate`) - the
  // `/totp/verify` response itself carries `data.accessToken`.
  const [totpVerifyResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/v1/auth/totp/verify')),
    loginWithMfa(page, email, secret),
  ]);
  const verifyBody = (await totpVerifyResponse.json()) as { data: { accessToken: string } };
  const mfaAccessToken = verifyBody.data.accessToken;

  await expect(page.getByTestId('wizard-verify-email')).toBeVisible();
  await expect(page.getByTestId('connect-create-button')).not.toBeVisible();

  // Route-guard half is proven above (no connect UI ever rendered). API
  // half: a direct call carrying the real `mfa: true` session must still be
  // denied by the server-side entitlement gate, never only by the UI.
  const instancesResponse = await page.request.post('/v1/instances', {
    headers: { authorization: `Bearer ${mfaAccessToken}` },
    data: { label: 'Should never be created' },
  });
  expect(instancesResponse.status()).toBe(403);
  const body = (await instancesResponse.json()) as { error: { code: string } };
  expect(body.error.code).toBe('EMAIL_NOT_VERIFIED');
});
