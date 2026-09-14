import type { FastifyInstance } from 'fastify';
import { generate as otpGenerate } from 'otplib';
import type { Sentinels } from './pii-workload-sentinels.js';

/**
 * pii-workload-onboard.ts (P25 U7 Part B) - the sentinel signup -> verify ->
 * login -> mint MFA -> onboarding-walk HTTP sequence, split out of
 * `pii-workload.ts` purely for that file's own max-lines cap (same split
 * idiom as `enqueue-http-auth-helpers.ts`/`enqueue-test-support.ts`). NOT
 * itself a test file (no `.test.ts` suffix).
 */

interface HttpJsonBody {
  data: Record<string, unknown>;
}

function expectOk(response: { statusCode: number; body: string }, label: string): HttpJsonBody {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${label} failed: ${response.statusCode} ${response.body}`);
  }
  return JSON.parse(response.body) as HttpJsonBody;
}

export interface OnboardedSentinelClient {
  userId: string;
  clientId: string;
  mfaAccessToken: string;
}

/** Signup -> verify -> login -> mint MFA -> walk onboarding to connect_whatsapp, all with sentinel-bearing values. */
export async function onboardSentinelClient(
  app: FastifyInstance,
  sentVerificationUrls: Map<string, string>,
  sentinels: Sentinels,
): Promise<OnboardedSentinelClient> {
  const signup = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers: { 'x-forwarded-for': '10.5.5.5' },
    payload: {
      fullName: sentinels.fullName,
      email: sentinels.email,
      phoneE164: sentinels.phoneE164,
      companyName: sentinels.companyName,
      password: 'Correct-Horse-Battery-Staple-9!',
    },
  });
  const signupBody = expectOk(signup, 'sentinel signup');
  const userId = signupBody.data.userId as string;
  const clientId = signupBody.data.clientId as string;

  const verifyUrl = sentVerificationUrls.get(sentinels.email);
  if (!verifyUrl) throw new Error(`no captured verification URL for ${sentinels.email}`);
  const rawToken = new URL(verifyUrl).searchParams.get('token');
  expectOk(
    await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: rawToken },
    }),
    'sentinel verify-email',
  );

  const login1 = expectOk(
    await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': '10.5.5.5' },
      payload: { email: sentinels.email, password: 'Correct-Horse-Battery-Staple-9!' },
    }),
    'sentinel first login',
  );
  const plainAccessToken = login1.data.accessToken as string;

  const enrol = expectOk(
    await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/enrol',
      headers: { authorization: `Bearer ${plainAccessToken}` },
    }),
    'sentinel totp enrol',
  );
  const secretShownOnce = enrol.data.secretShownOnce as string;
  const enrolCode: string = await otpGenerate({ secret: secretShownOnce });
  expectOk(
    await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/enrol/confirm',
      headers: { authorization: `Bearer ${plainAccessToken}` },
      payload: { code: enrolCode },
    }),
    'sentinel totp confirm',
  );

  const login2 = expectOk(
    await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': '10.5.5.5' },
      payload: { email: sentinels.email, password: 'Correct-Horse-Battery-Staple-9!' },
    }),
    'sentinel mfa login',
  );
  const mfaToken = login2.data.mfaToken as string;
  const verifyCode: string = await otpGenerate({ secret: secretShownOnce });
  const verify = expectOk(
    await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/verify',
      headers: { 'x-forwarded-for': '10.5.5.5' },
      payload: { mfaToken, code: verifyCode },
    }),
    'sentinel totp verify',
  );
  const mfaAccessToken = verify.data.accessToken as string;

  expectOk(
    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/timezone',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { timezone: 'Asia/Kolkata' },
    }),
    'sentinel onboarding timezone',
  );
  expectOk(
    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/pacing-profile',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { profileKey: 'standard' },
    }),
    'sentinel onboarding pacing-profile',
  );
  expectOk(
    await app.inject({
      method: 'POST',
      url: '/v1/onboarding/consent',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { accepted: true },
    }),
    'sentinel onboarding consent',
  );

  return { userId, clientId, mfaAccessToken };
}
