import { expect, type Page } from '@playwright/test';
import { generate as otpGenerate } from 'otplib';

/**
 * tests/e2e/support.ts (P04b UB3) - shared helpers for the signup/onboarding
 * acceptance e2e (kept out of the spec file to respect the workspace's
 * max-lines: 300 lint rule). Deterministic-by-construction: every wait here
 * is `expect.poll`/`waitForResponse`, never a fixed `sleep`.
 */

const MAILPIT_BASE_URL = 'http://127.0.0.1:8025';

export interface MailpitMessageSummary {
  ID: string;
}

export interface MailpitSearchResult {
  messages: MailpitMessageSummary[];
}

export interface MailpitMessage {
  Text: string;
  HTML: string;
}

/** Builds a unique-per-run email so repeated local/CI runs never collide on a real unique constraint. */
export function uniqueEmail(label: string): string {
  return `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

/** A syntactically valid Indian mobile number (phoneE164Schema parses with defaultCountry: 'IN'). */
export function uniquePhone(): string {
  const suffix = String(Math.floor(6000000000 + Math.random() * 999999999)).slice(0, 10);
  return `+91${suffix}`;
}

/**
 * Polls Mailpit's REST API for the newest message sent to `email` and
 * extracts the `http://localhost:5173/verify-email?token=<hex>` link from
 * its plain-text body (see platform/mailer.ts's `sendVerificationEmail`).
 */
export async function waitForVerificationLink(email: string): Promise<string> {
  let messageId = '';

  await expect
    .poll(
      async () => {
        const response = await fetch(
          `${MAILPIT_BASE_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
        );
        if (!response.ok) return 0;
        const body = (await response.json()) as MailpitSearchResult;
        if (body.messages.length > 0) {
          messageId = body.messages[0]!.ID;
        }
        return body.messages.length;
      },
      { timeout: 20_000, intervals: [250, 500, 1000] },
    )
    .toBeGreaterThan(0);

  const messageResponse = await fetch(`${MAILPIT_BASE_URL}/api/v1/message/${messageId}`);
  const message = (await messageResponse.json()) as MailpitMessage;

  const match = /https?:\/\/localhost:5173\/verify-email\?token=[0-9a-f]+/.exec(
    message.Text || message.HTML,
  );
  if (!match) {
    throw new Error(`No verification link found in message ${messageId} for ${email}`);
  }
  return match[0];
}

/**
 * Enrols TOTP on an already-authenticated (plain, non-MFA) session: reads
 * the base32 secret shown once on the enrol panel, generates the current
 * 30s code, and confirms - waiting for the recovery-codes screen. Returns
 * the secret so the caller can generate a second, later code for the
 * `/totp/verify` continuation (see `session_mfa` policy note in
 * `entitlement.service.ts` / `route-policy.ts`: enrolling TOTP does not by
 * itself upgrade the CURRENT session to `mfa: true` - only a fresh
 * login -> `mfa_required` -> `/totp/verify` cycle mints an `mfa: true`
 * access token).
 */
export async function confirmTotpEnrolment(page: Page): Promise<string> {
  const secret = await page.getByTestId('totp-secret').innerText();
  const code: string = await otpGenerate({ secret });
  await page.getByTestId('totp-enrol-code').fill(code);
  await page.getByTestId('totp-enrol-confirm').click();
  await expect(page.getByTestId('totp-recovery-codes')).toBeVisible();
  return secret;
}

/** Fills and submits the login form. Does not wait for the post-login redirect. */
export async function submitLoginForm(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
}

/** Completes the login-time `/totp/verify` continuation once `/totp?mfaToken=...` has loaded. */
export async function submitTotpVerify(page: Page, secret: string): Promise<void> {
  const code: string = await otpGenerate({ secret });
  await page.getByTestId('totp-verify-code').fill(code);
  await page.getByTestId('totp-verify-submit').click();
}
