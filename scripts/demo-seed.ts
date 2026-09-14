import { generate as otpGenerate } from 'otplib';
import {
  defaultDemoEmail,
  extractVerificationToken,
  generateDemoPassword,
  isProductionEnv,
} from './demo/demo-seed-helpers.js';
import {
  needsPlanInstructionBlock,
  resumeCredentialsFromEnv,
} from './demo/demo-seed-resume-helpers.js';
import { runPostAuthWalk, type WalkResult } from './demo/demo-seed-walk.js';

/**
 * scripts/demo-seed.ts (P26b U6/U6b, run as `pnpm demo:seed`) - walks the
 * REAL api role with `fetch` only (never touches Postgres/Redis directly)
 * to bring a workspace to a demo-ready state.
 *
 * TWO modes, chosen by env (`resumeCredentialsFromEnv`):
 *  - fresh (default): signup -> verify-email (via Mailpit) -> login -> TOTP
 *    enrol/confirm -> re-login with MFA.
 *  - resume (`WP_DEMO_EMAIL`+`WP_DEMO_PASSWORD`+`WP_DEMO_TOTP_SECRET` all
 *    set): skips signup/verify/enrol entirely, logs in (expects
 *    `mfa_required`), and verifies TOTP from the given secret - for
 *    continuing the SAME workspace after `db/seeds/demo-plan-assign.sql` was
 *    run by hand (this script never writes to Postgres/Redis itself).
 *
 * Both modes then share ONE post-auth walk (`demo-seed-walk.ts`):
 * onboarding-if-needed -> 12 sample contacts -> one instance admission
 * check -> one DRAFT fan-out (never started). Dev-only: refuses to run
 * against production. Idempotent per email: an email-taken conflict exits 2
 * without deleting anything (core invariant 5: never destroy queued/
 * existing work). When contacts or the instance check hit the `no_plan`
 * 409 (a fresh signup has no billing plan - P28 open item), this script
 * prints the exact two-step unblock and exits 3 rather than pretending to
 * be done.
 *
 * Every step logs one line to stderr; the final credentials/instruction
 * block is the ONLY thing printed to stdout and is never written to a
 * file - the caller is responsible for not persisting it either.
 */

const API_BASE = process.env.WP_API_BASE ?? 'http://127.0.0.1:3000';
const MAILPIT_BASE = process.env.WP_MAILPIT_BASE ?? 'http://127.0.0.1:8025';

interface ApiErrorBody {
  code: string;
  message: string;
}

function step(message: string): void {
  console.error(`[demo-seed] ${message}`);
}

async function callApi<T>(
  path: string,
  init: { method: 'POST' | 'GET'; body?: unknown; authToken?: string } = { method: 'GET' },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.authToken) headers.authorization = `Bearer ${init.authToken}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const json = (await response.json()) as { data?: T; error?: ApiErrorBody };
  if (!response.ok) {
    const error = json.error;
    throw new Error(
      `${init.method} ${path} -> ${String(response.status)}: ${error ? `${error.code} ${error.message}` : JSON.stringify(json)}`,
    );
  }
  return json.data as T;
}

interface MailpitSearchResult {
  messages: Array<{ ID: string }>;
}
interface MailpitMessage {
  Text: string;
  HTML: string;
}

async function waitForVerificationToken(email: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  let messageId = '';
  while (Date.now() < deadline) {
    const response = await fetch(
      `${MAILPIT_BASE}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    if (response.ok) {
      const body = (await response.json()) as MailpitSearchResult;
      if (body.messages.length > 0) {
        messageId = body.messages[0]!.ID;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!messageId) {
    throw new Error(`No verification mail arrived for ${email} within 20s`);
  }

  const messageResponse = await fetch(`${MAILPIT_BASE}/api/v1/message/${messageId}`);
  const message = (await messageResponse.json()) as MailpitMessage;
  const token = extractVerificationToken(message.Text || message.HTML);
  if (!token) {
    throw new Error(`No verification token found in message ${messageId} for ${email}`);
  }
  return token;
}

interface SignupOutput {
  userId: string;
  clientId: string;
  onboardingStep: string;
}
interface AuthenticatedResult {
  kind: 'authenticated';
  accessToken: string;
  user: { id: string; email: string; fullName: string };
}
interface MfaRequiredResult {
  kind: 'mfa_required';
  mfaToken: string;
}
type LoginResult = AuthenticatedResult | MfaRequiredResult;

/** Fresh-signup path: signup -> verify-email -> login -> TOTP enrol/confirm -> re-login with MFA. Returns the access token and the TOTP secret (printed once in the final block). */
async function signupAndEnrol(
  email: string,
  password: string,
  companyName: string,
): Promise<{ accessToken: string; totpSecret: string }> {
  step(`signup: ${email}`);
  const signupOutput = await callApi<SignupOutput>('/v1/auth/signup', {
    method: 'POST',
    body: { fullName: 'Demo Owner', email, phoneE164: '+919876543210', companyName, password },
  });
  step(`signup ok, onboardingStep=${signupOutput.onboardingStep}`);

  step('waiting for verification mail via mailpit');
  const token = await waitForVerificationToken(email);
  await callApi('/v1/auth/verify-email', { method: 'POST', body: { token } });
  step('email verified');

  step('login (plain)');
  const firstLogin = await callApi<LoginResult>('/v1/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  if (firstLogin.kind !== 'authenticated') {
    throw new Error('Expected an authenticated login before TOTP is enrolled.');
  }

  step('enrolling TOTP');
  const enrol = await callApi<{ otpauthUrl: string; secretShownOnce: string }>(
    '/v1/auth/totp/enrol',
    { method: 'POST', authToken: firstLogin.accessToken },
  );
  const enrolCode: string = await otpGenerate({ secret: enrol.secretShownOnce });
  await callApi('/v1/auth/totp/enrol/confirm', {
    method: 'POST',
    authToken: firstLogin.accessToken,
    body: { code: enrolCode },
  });
  step('TOTP enrolled and confirmed');

  step('re-login (expect mfa_required)');
  const secondLogin = await callApi<LoginResult>('/v1/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  if (secondLogin.kind !== 'mfa_required') {
    throw new Error('Expected mfa_required on the second login (TOTP is now enrolled).');
  }
  const verifyCode: string = await otpGenerate({ secret: enrol.secretShownOnce });
  const mfaResult = await callApi<AuthenticatedResult>('/v1/auth/totp/verify', {
    method: 'POST',
    body: { mfaToken: secondLogin.mfaToken, code: verifyCode },
  });
  return { accessToken: mfaResult.accessToken, totpSecret: enrol.secretShownOnce };
}

/** Resume path: login (expect mfa_required) -> TOTP verify from the given secret. Never signs up, never touches mailpit. */
async function resumeLogin(
  email: string,
  password: string,
  totpSecret: string,
): Promise<{ accessToken: string }> {
  step(`resume: login (expect mfa_required): ${email}`);
  const login = await callApi<LoginResult>('/v1/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  if (login.kind !== 'mfa_required') {
    throw new Error(
      'Expected mfa_required on resume login (this workspace should have TOTP enrolled already).',
    );
  }
  const code: string = await otpGenerate({ secret: totpSecret });
  const mfaResult = await callApi<AuthenticatedResult>('/v1/auth/totp/verify', {
    method: 'POST',
    body: { mfaToken: login.mfaToken, code },
  });
  step('MFA session established (resumed)');
  return { accessToken: mfaResult.accessToken };
}

function printReadyBlock(
  email: string,
  password: string,
  totpSecret: string,
  walk: WalkResult,
): void {
  console.log(
    [
      '',
      '=== Demo workspace ready ===',
      `Panel URL:        http://localhost:5173/login`,
      `Email:            ${email}`,
      `Password:         ${password}`,
      `TOTP secret:      ${totpSecret}`,
      `Onboarding step:  ${walk.onboardingStep}`,
      `Contacts created: ${String(walk.contactIds.length)}`,
      `Draft fan-out:    ${walk.broadcastId ?? 'not created (see log above)'}`,
      '',
      'Linking a number needs the session-worker running (npm run dev:worker in app/backend).',
      'Credentials above are printed once and never stored anywhere - copy them now.',
      '',
    ].join('\n'),
  );
}

async function run(): Promise<void> {
  if (isProductionEnv(process.env)) {
    console.error(
      '[demo-seed] refusing to run: WP_ENV or NODE_ENV is "production" - this script is dev-only.',
    );
    process.exit(1);
  }

  const resumeCreds = resumeCredentialsFromEnv(process.env);
  let email: string;
  let password: string;
  let totpSecret: string;
  let accessToken: string;

  if (resumeCreds) {
    ({ email, password, totpSecret } = resumeCreds);
    ({ accessToken } = await resumeLogin(email, password, totpSecret));
  } else {
    email = process.env.WP_DEMO_EMAIL ?? defaultDemoEmail(new Date());
    password =
      process.env.WP_DEMO_PASSWORD ??
      generateDemoPassword((max) => Math.floor(Math.random() * max));
    const companyName = process.env.WP_DEMO_COMPANY ?? 'Demo Textiles Co';
    try {
      ({ accessToken, totpSecret } = await signupAndEnrol(email, password, companyName));
    } catch (error) {
      if (error instanceof Error && /CONFLICT/.test(error.message)) {
        step(`email already taken: ${email} - exiting without changes.`);
        process.exit(2);
      }
      throw error;
    }
  }

  const walk = await runPostAuthWalk({ callApi, step }, accessToken);

  if (walk.needsPlan) {
    console.log(
      [
        '',
        '=== Demo workspace created but NOT ready (no plan assigned yet) ===',
        `Email:            ${email}`,
        `Password:         ${password}`,
        `TOTP secret:      ${totpSecret}`,
        'Credentials above are printed once and never stored anywhere - copy them now.',
      ].join('\n'),
    );
    console.log(needsPlanInstructionBlock(email));
    process.exit(3);
  }

  printReadyBlock(email, password, totpSecret, walk);
}

run().catch((error: unknown) => {
  console.error(`[demo-seed] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
