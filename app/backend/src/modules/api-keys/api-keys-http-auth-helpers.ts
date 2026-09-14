import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generate as otpGenerate } from 'otplib';

/**
 * api-keys-http-auth-helpers.ts (go-live 2026-09-14) - a self-contained copy
 * of `modules/messages/enqueue-http-auth-helpers.ts`'s signup -> verify ->
 * login -> MFA-enrol walk, ending at a real `session_mfa`-eligible access
 * token. It is a COPY on purpose: `no-deep-module-import` forbids reaching
 * into another backend module's internals, and this file is exactly the
 * `modules/identity/__tests__/identity-routes-mfa-helpers.ts` precedent (the
 * same trimmed per-module copy, for the same reason). Its three fixture
 * constants are local for the same reason. NOT itself a test file.
 */

const STRONG_PASSWORD = 'Correct-Horse-Battery-Staple-9!';

function uniqueEmail(label: string): string {
  return `api-keys-${label}-${randomUUID()}@example.test`;
}

function uniqueIp(): string {
  const n = (): string => String(1 + Math.floor(Math.random() * 254));
  return `10.${n()}.${n()}.${n()}`;
}

export interface SignedUpClient {
  userId: string;
  clientId: string;
  email: string;
}

async function signupClientViaHttp(app: FastifyInstance, label: string): Promise<SignedUpClient> {
  const email = uniqueEmail(label);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: {
      fullName: `API Keys Test ${label}`,
      email,
      phoneE164: '+919876543210',
      companyName: `API Keys Test Co ${label}`,
      password: STRONG_PASSWORD,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`signup failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as { data: { userId: string; clientId: string } };
  return { userId: body.data.userId, clientId: body.data.clientId, email };
}

async function verifyClientEmailViaHttp(
  app: FastifyInstance,
  sentVerificationUrls: Map<string, string>,
  email: string,
): Promise<void> {
  const verifyUrl = sentVerificationUrls.get(email);
  if (!verifyUrl) throw new Error(`no captured verification URL for ${email}`);
  const rawToken = new URL(verifyUrl).searchParams.get('token');
  if (!rawToken) throw new Error(`verification URL for ${email} carried no token`);

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: rawToken },
  });
  if (response.statusCode !== 200) {
    throw new Error(`verify-email failed: ${response.statusCode} ${response.body}`);
  }
}

async function loginViaHttp(app: FastifyInstance, email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: { email, password: STRONG_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as { data: { kind: string; accessToken?: string } };
  if (body.data.kind !== 'authenticated' || !body.data.accessToken) {
    throw new Error(`login did not return an authenticated session: ${response.body}`);
  }
  return body.data.accessToken;
}

async function mintMfaAccessTokenViaHttp(
  app: FastifyInstance,
  email: string,
  plainAccessToken: string,
): Promise<string> {
  const enrolResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/totp/enrol',
    headers: { authorization: `Bearer ${plainAccessToken}` },
  });
  if (enrolResponse.statusCode !== 200) {
    throw new Error(`totp enrol failed: ${enrolResponse.statusCode} ${enrolResponse.body}`);
  }
  const enrolBody = enrolResponse.json() as { data: { secretShownOnce: string } };
  const secretShownOnce = enrolBody.data.secretShownOnce;
  const enrolCode: string = await otpGenerate({ secret: secretShownOnce });

  const confirmResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/totp/enrol/confirm',
    headers: { authorization: `Bearer ${plainAccessToken}` },
    payload: { code: enrolCode },
  });
  if (confirmResponse.statusCode !== 200) {
    throw new Error(`totp confirm failed: ${confirmResponse.statusCode} ${confirmResponse.body}`);
  }

  const loginResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: { email, password: STRONG_PASSWORD },
  });
  if (loginResponse.statusCode !== 200) {
    throw new Error(`mfa login failed: ${loginResponse.statusCode} ${loginResponse.body}`);
  }
  const loginBody = loginResponse.json() as { data: { kind: string; mfaToken?: string } };
  if (loginBody.data.kind !== 'mfa_required' || !loginBody.data.mfaToken) {
    throw new Error(`expected mfa_required after TOTP enrolment: ${loginResponse.body}`);
  }
  const mfaToken = loginBody.data.mfaToken;
  const verifyCode: string = await otpGenerate({ secret: secretShownOnce });

  const verifyResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/totp/verify',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: { mfaToken, code: verifyCode },
  });
  if (verifyResponse.statusCode !== 200) {
    throw new Error(`totp verify failed: ${verifyResponse.statusCode} ${verifyResponse.body}`);
  }
  const verifyBody = verifyResponse.json() as { data: { accessToken: string } };
  return verifyBody.data.accessToken;
}

async function walkOnboardingToConnectWhatsapp(
  app: FastifyInstance,
  mfaAccessToken: string,
): Promise<void> {
  const tzResponse = await app.inject({
    method: 'POST',
    url: '/v1/onboarding/timezone',
    headers: { authorization: `Bearer ${mfaAccessToken}` },
    payload: { timezone: 'Asia/Kolkata' },
  });
  if (tzResponse.statusCode !== 200) {
    throw new Error(`timezone update failed: ${tzResponse.statusCode} ${tzResponse.body}`);
  }

  const pacingResponse = await app.inject({
    method: 'POST',
    url: '/v1/onboarding/pacing-profile',
    headers: { authorization: `Bearer ${mfaAccessToken}` },
    payload: { profileKey: 'standard' },
  });
  if (pacingResponse.statusCode !== 200) {
    throw new Error(
      `pacing profile update failed: ${pacingResponse.statusCode} ${pacingResponse.body}`,
    );
  }

  const consentResponse = await app.inject({
    method: 'POST',
    url: '/v1/onboarding/consent',
    headers: { authorization: `Bearer ${mfaAccessToken}` },
    payload: { accepted: true },
  });
  if (consentResponse.statusCode !== 200) {
    throw new Error(`consent update failed: ${consentResponse.statusCode} ${consentResponse.body}`);
  }
}

/** Full happy-path fixture: signup -> verify -> mint mfa -> walk onboarding -> ready to call POST /v1/messages. */
export async function onboardedMfaClient(
  app: FastifyInstance,
  sentVerificationUrls: Map<string, string>,
  label: string,
): Promise<{ client: SignedUpClient; mfaAccessToken: string }> {
  const client = await signupClientViaHttp(app, label);
  await verifyClientEmailViaHttp(app, sentVerificationUrls, client.email);
  const plainAccessToken = await loginViaHttp(app, client.email);
  const mfaAccessToken = await mintMfaAccessTokenViaHttp(app, client.email, plainAccessToken);
  await walkOnboardingToConnectWhatsapp(app, mfaAccessToken);
  return { client, mfaAccessToken };
}
