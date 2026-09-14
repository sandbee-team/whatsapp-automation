import { expect, test } from '@playwright/test';

/**
 * lead-form.spec.ts (P29 U4b) - the marketing contact form against a REAL
 * admin-backend (real Postgres, real bot guard, real rate limiter). The
 * `waitForTimeout(3500)` is not an assertion - it exists because the bot
 * guard's minimum elapsed form time is 3000 ms, and a real click faster
 * than that WOULD be correctly rejected as a bot.
 */

test('a_lead_submission_reaches_admin_backend_and_returns_a_confirmation', async ({ page }) => {
  await page.goto('/contact/');
  await page.getByLabel('Name').fill('Ada Lovelace');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Message').fill('We would like to learn more.');

  await page.waitForTimeout(3500);

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/public/v1/leads') && res.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Send' }).click(),
  ]);

  expect(response.status()).toBe(202);
  const body = await response.json();
  expect(body.data.accepted).toBe(true);
  await expect(
    page.getByText('Thanks — we have your details and will reply by email.'),
  ).toBeVisible();
});

test('the_lead_form_never_posts_to_the_customer_api_origin', async ({ page }) => {
  const requestUrls: string[] = [];
  page.on('request', (request) => requestUrls.push(request.url()));

  await page.goto('/contact/');
  await page.getByLabel('Name').fill('Ada Lovelace');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Message').fill('We would like to learn more.');
  await page.waitForTimeout(3500);

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/public/v1/leads') && res.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Send' }).click(),
  ]);
  expect(response.status()).toBe(202);

  const postUrls = requestUrls.filter((url) => url.includes('/public/v1/leads'));
  expect(postUrls).toHaveLength(1);
  expect(postUrls[0]).toBe('http://127.0.0.1:3001/public/v1/leads');

  for (const url of requestUrls) {
    expect(url).not.toContain(':3000');
    const parsed = new URL(url);
    if (parsed.port !== '3001') {
      expect(/\/v1\//.test(parsed.pathname) && !parsed.pathname.includes('/public/')).toBe(false);
    }
  }
});
