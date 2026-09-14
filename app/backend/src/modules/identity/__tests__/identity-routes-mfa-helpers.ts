import type { FastifyInstance } from 'fastify';
import { generate as otpGenerate } from 'otplib';
import { STRONG_PASSWORD, uniqueEmail, uniqueIp } from './identity-routes-test-support.js';

/**
 * identity-routes-mfa-helpers.ts (P28 U5, item 1) - a trimmed, self-
 * contained copy of `modules/messages/enqueue-http-auth-helpers.ts`'s HTTP
 * signup->verify->login->MFA-enrol walk (same "per-module copy, never a
 * cross-module `__tests__/**` import" discipline that file's own header
 * comment documents - `no-deep-module-import` forbids reaching into another
 * module's `__tests__/**` directly). Stops at a real `session_mfa`-eligible
 * access token - `password.routes.integration.test.ts` is this file's only
 * caller.
 */

async function signupViaHttp(
  app: FastifyInstance,
  label: string,
): Promise<{ userId: string; clientId: string; email: string }> {
  const email = uniqueEmail(label);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: {
      fullName: `Password Routes ${label}`,
      email,
      phoneE164: '+919876543210',
      companyName: `Password Routes Co ${label}`,
      password: STRONG_PASSWORD,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`signup failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as { data: { userId: string; clientId: string } };
  return { userId: body.data.userId, clientId: body.data.clientId, email };
}

async function verifyEmailViaHttp(
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

async function enrolTotp(app: FastifyInstance, plainAccessToken: string): Promise<string> {
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
  return secretShownOnce;
}

// Every `mfaLoginViaHttp` call in a process alternates between the current
// and the next 30s step (`totpWindow=1`'s own +/-1 step tolerance accepts
// both) - two calls landing in the SAME real second would otherwise submit
// the identical code and the second is rejected as reused (totp.service.ts's
// used-code TTL); going further than one step out falls OUTSIDE that
// tolerance and is rejected as wrong instead.
let mfaLoginUseNextStep = false;

/** Logs in an already-TOTP-enrolled `email`, completing the MFA challenge - returns the resulting session's access token AND its `Set-Cookie` refresh header (the caller needs both to prove a SECOND, independent session). */
export async function mfaLoginViaHttp(
  app: FastifyInstance,
  email: string,
  totpSecret: string,
): Promise<{ accessToken: string; setCookieHeader: string }> {
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
  // See mfaLoginUseNextStep's own doc comment above - same `epoch` idiom
  // identity-routes-totp.integration.test.ts's own reuse test uses.
  mfaLoginUseNextStep = !mfaLoginUseNextStep;
  const verifyCode: string = await otpGenerate({
    secret: totpSecret,
    epoch: Math.floor(Date.now() / 1000) + (mfaLoginUseNextStep ? 30 : 0),
  });

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
  const setCookieHeader = verifyResponse.headers['set-cookie'];
  const rawCookie = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!rawCookie) throw new Error('totp verify response carried no Set-Cookie header');
  return { accessToken: verifyBody.data.accessToken, setCookieHeader: rawCookie };
}

export interface SignedUpClient {
  userId: string;
  clientId: string;
  email: string;
}

/** Full happy-path fixture: signup -> verify -> enrol+confirm TOTP -> mint a real session_mfa access token. `totpSecret` is returned so a caller can mint FURTHER independent MFA sessions via `mfaLoginViaHttp`. */
export async function onboardedMfaClient(
  app: FastifyInstance,
  sentVerificationUrls: Map<string, string>,
  label: string,
): Promise<{ client: SignedUpClient; mfaAccessToken: string; totpSecret: string }> {
  const client = await signupViaHttp(app, label);
  await verifyEmailViaHttp(app, sentVerificationUrls, client.email);
  const plainAccessToken = await loginViaHttp(app, client.email);
  const totpSecret = await enrolTotp(app, plainAccessToken);
  const { accessToken: mfaAccessToken } = await mfaLoginViaHttp(app, client.email, totpSecret);
  return { client, mfaAccessToken, totpSecret };
}
