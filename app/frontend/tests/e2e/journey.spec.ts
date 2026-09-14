import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  confirmTotpEnrolment,
  submitLoginForm,
  submitTotpVerify,
  uniqueEmail,
  uniquePhone,
  waitForVerificationLink,
} from './support.js';
import {
  NAV_ROUTES,
  ensureShotDir,
  resolveShotDir,
  shotLightAndDark,
  shotMobile,
  waitForSettled,
} from './journey-support.js';

/**
 * journey.spec.ts (P26b U6) - `full_product_journey`: signs up, verifies via
 * mailpit, logs in, enrols TOTP, re-logs in with MFA, completes onboarding
 * through consent, attempts to connect a number (fails honestly today with
 * 409 `REGISTERED_LIMIT_REACHED` - a fresh signup has no billing plan, see
 * `signup-onboarding.spec.ts`'s own doc comment), asserts the dashboard shell, then
 * walks every `NAV_GROUPS` route capturing light/dark/mobile screenshots
 * into `docs/evidence/P26b-ui/after/`, opening one dialog per data screen
 * where a preserved test id exists, and finishes by logging out. Every wait
 * is `expect`/`waitForURL`/`expect.poll` - never a fixed `sleep`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolveShotDir(HERE);
const PASSWORD = 'correct horse battery staple';

async function completeAuthAndOnboarding(page: Page, email: string): Promise<void> {
  await shot(page, '01-signup');
  await page.getByTestId('signup-full-name').fill('Demo Owner');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-phone').fill(uniquePhone());
  await page.getByTestId('signup-company').fill('Demo Workspace');
  await page.getByTestId('signup-password').fill(PASSWORD);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('signup-submit')).toBeHidden();
  await shot(page, '02-signup-success');

  const verifyLink = await waitForVerificationLink(email);
  await page.goto(verifyLink);
  await expect(page.getByTestId('verify-email-verified')).toBeVisible();
  await shot(page, '03-verify-email');

  await page.goto('/login');
  await shot(page, '04-login');
  await submitLoginForm(page, email, PASSWORD);
  await page.waitForURL(/\/onboarding/);

  await page.goto('/totp');
  await expect(page.getByTestId('totp-secret')).toBeVisible();
  await shot(page, '05-totp-enrol');
  const secret = await confirmTotpEnrolment(page);
  await shot(page, '06-totp-recovery-codes');

  await submitLoginForm(page, email, PASSWORD);
  await page.waitForURL(/\/totp\?mfaToken=/);
  await shot(page, '07-totp-verify');
  await submitTotpVerify(page, secret);
  await page.waitForURL(/\/onboarding/);

  await expect(page.getByTestId('wizard-choose-timezone')).toBeVisible();
  await shot(page, '08-onboarding-timezone');
  await page.getByTestId('wizard-timezone-submit').click();
  await expect(page.getByTestId('wizard-accept-pacing-profile')).toBeVisible();
  await shot(page, '09-onboarding-pacing-profile');
  await page.getByTestId('wizard-pacing-profile-submit').click();
  await expect(page.getByTestId('wizard-attest-consent')).toBeVisible();
  await shot(page, '10-onboarding-consent');
  await page.getByTestId('wizard-consent-checkbox').check();
  await page.getByTestId('wizard-consent-submit').click();
  await expect(page.getByTestId('wizard-connect-whatsapp')).toBeVisible();
  await shot(page, '11-onboarding-connect');

  // OPEN ITEM (see `signup-onboarding.spec.ts`'s own doc comment and
  // `scripts/demo-seed.ts`): a fresh signup has no billing plan assigned, so
  // `POST /v1/instances` fails closed with 409 `REGISTERED_LIMIT_REACHED`
  // today. This screenshot captures that HONEST state (the create stage
  // stays visible with an error alert), never a faked method-stage success.
  await page.getByTestId('connect-label-input').fill('Demo number');
  const [instancesResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/v1/instances')),
    page.getByTestId('connect-create-button').click(),
  ]);
  expect(instancesResponse.status()).toBe(409);
  await expect(page.getByRole('alert')).toBeVisible();
  await shot(page, '12-onboarding-connect-method');
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
}

/** Opens the one preserved dialog trigger for a data screen (if present at this stage), screenshots it, then closes with Escape. */
async function openAndCloseDialog(
  page: Page,
  triggerTestId: string,
  dialogTestId: string,
): Promise<void> {
  const trigger = page.getByTestId(triggerTestId);
  if ((await trigger.count()) === 0) return;
  await trigger.click();
  await expect(page.getByTestId(dialogTestId)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(dialogTestId)).toBeHidden();
}

const DIALOG_TRIGGERS: Readonly<Record<string, { trigger: string; dialog: string }>> = {
  contacts: { trigger: 'contacts-add-button', dialog: 'contact-form' },
  'settings-webhooks': { trigger: 'webhooks-add-button', dialog: 'webhook-endpoint-form' },
};

/** `broadcasts-new-button` navigates to `/broadcasts/new` (a route, not a modal) - screenshot it then navigate back. */
async function openAndReturnFromBroadcastComposer(page: Page): Promise<void> {
  const trigger = page.getByTestId('broadcasts-new-button');
  if ((await trigger.count()) === 0) return;
  await trigger.click();
  await expect(page.getByTestId('broadcast-composer')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('broadcasts-screen')).toBeVisible();
}

test('full_product_journey', async ({ page }) => {
  test.setTimeout(300_000);
  ensureShotDir(SHOT_DIR);
  await page.setViewportSize({ width: 1280, height: 800 });
  const email = uniqueEmail('journey');

  await page.goto('/signup');
  await completeAuthAndOnboarding(page, email);

  await page.getByTestId('wizard-continue-to-dashboard').click();
  await page.waitForURL('/');
  await waitForSettled(page, 'dashboard-screen');
  await expect(page.getByTestId('nav-dashboard')).toBeVisible();
  await shotLightAndDark(page, SHOT_DIR, '13-dashboard');
  await shotMobile(page, SHOT_DIR, '13-dashboard');
  await page.setViewportSize({ width: 1280, height: 800 });

  let index = 14;
  for (const route of NAV_ROUTES) {
    if (route.name === 'dashboard') continue;
    await page.getByTestId(route.navTestId).click();
    await waitForSettled(page, route.screenTestId);
    const shotName = `${String(index).padStart(2, '0')}-${route.name}`;
    await shotLightAndDark(page, SHOT_DIR, shotName);

    const dialogSpec = DIALOG_TRIGGERS[route.name];
    if (dialogSpec) {
      await openAndCloseDialog(page, dialogSpec.trigger, dialogSpec.dialog);
    }
    if (route.name === 'broadcasts') {
      await openAndReturnFromBroadcastComposer(page);
    }

    await shotMobile(page, SHOT_DIR, shotName);
    await page.setViewportSize({ width: 1280, height: 800 });
    index += 1;
  }

  await page.getByTestId('logout-button').click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.waitForURL('/login');
});
