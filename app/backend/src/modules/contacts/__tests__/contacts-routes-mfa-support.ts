import type { FastifyInstance } from 'fastify';
import { generate as otpGenerate } from 'otplib';

/**
 * contacts-routes-mfa-support.ts (P20 Unit U6, step 5/7) - the TOTP-mint
 * half of `contacts-routes-test-support.ts`, split out purely for that
 * file's own max-lines cap (same split idiom as `session-worker-discovery-
 * wiring.ts`) - needed here because `session_mfa` routes
 * (`export-erasure.routes.ts`) did not exist when that file was first
 * written for U4's `session`-only routes. Mirrors `wallet-routes-test-
 * support.ts`'s own MFA flow exactly (`no-deep-module-import` forbids
 * importing that one directly). NOT itself a test file.
 */

export interface SignedUpClientLike {
  userId: string;
  clientId: string;
  email: string;
}

/**
 * Logs in + completes the MFA continuation for an ALREADY-enrolled TOTP
 * secret - returns a REAL `mfa: true` access token. Re-mintable after a role
 * change (a fresh login re-reads `memberships.role`), unlike the plain
 * enrolment token which is baked in at issuance.
 *
 * `epochOffsetMs` (default 0) shifts the epoch (in MILLISECONDS - converted
 * to whole seconds before being passed to otplib, whose `epoch` option is
 * seconds-since-epoch, not ms) the verify code is generated for - a caller
 * re-minting a SECOND token in the same test (e.g. after a role downgrade)
 * must pass an offset of AT LEAST one full TOTP period (30000, i.e. 30s) so
 * a code from a DIFFERENT 30-second bucket is generated than the first
 * mint's own enrol/confirm+verify pair, or the SAME code is regenerated and
 * the server's per-`(userId, code)` replay guard (a Redis `SET NX`,
 * `totp.service.ts#verify`) rejects it as already-used. Must stay under
 * ~60000 to remain within `TOTP_WINDOW`'s default tolerance (1 step = 30s)
 * of the verifier's real "now" (proven empirically: 30000-59999 -> distinct
 * valid code at delta 1; 60000+ -> exceeds tolerance, invalid). This is an
 * INJECTED value, never a real wall-clock wait - core invariants doc,
 * "Tests must not assert on ambient state".
 */
export async function loginAndVerifyMfaViaHttp(
  app: FastifyInstance,
  email: string,
  password: string,
  secretShownOnce: string,
  uniqueIp: () => string,
  epochOffsetMs = 0,
): Promise<string> {
  const loginResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-forwarded-for': uniqueIp() },
    payload: { email, password },
  });
  if (loginResponse.statusCode !== 200) {
    throw new Error(`mfa login failed: ${loginResponse.statusCode} ${loginResponse.body}`);
  }
  const loginBody = loginResponse.json() as { data: { kind: string; mfaToken?: string } };
  if (loginBody.data.kind !== 'mfa_required' || !loginBody.data.mfaToken) {
    throw new Error(`expected mfa_required after TOTP enrolment: ${loginResponse.body}`);
  }
  const mfaToken = loginBody.data.mfaToken;
  // otplib's `epoch` option is SECONDS since epoch (not ms) - passing
  // `Date.now()` here generated a code for the wrong time step entirely and
  // failed verification every time (proven with a standalone otplib probe:
  // `generate({ secret, epoch: Date.now() })` !== `generate({ secret })`,
  // but `generate({ secret, epoch: Math.floor(Date.now() / 1000) })` matches).
  const verifyCode: string = await otpGenerate({
    secret: secretShownOnce,
    epoch: Math.floor((Date.now() + epochOffsetMs) / 1000),
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
  return verifyBody.data.accessToken;
}

/** Enrols + confirms TOTP, then logs in again through the MFA continuation - returns `{ secretShownOnce, accessToken }` (the secret lets a caller re-mint a fresh MFA token later, e.g. after a role change). */
export async function mintMfaAccessTokenViaHttp(
  app: FastifyInstance,
  email: string,
  plainAccessToken: string,
  password: string,
  uniqueIp: () => string,
): Promise<{ secretShownOnce: string; accessToken: string }> {
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

  const accessToken = await loginAndVerifyMfaViaHttp(
    app,
    email,
    password,
    secretShownOnce,
    uniqueIp,
  );
  return { secretShownOnce, accessToken };
}
