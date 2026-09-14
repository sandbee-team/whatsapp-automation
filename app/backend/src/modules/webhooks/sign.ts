import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * sign.ts (P15 U5, step 7) - the Standard-Webhooks-shaped signature this
 * module's dispatcher attaches to every outbound delivery: `X-WP-Signature:
 * v1,t=<unix>,s=<hex hmac-sha256(t + "." + body)>`, verified receiver-side
 * with a 5-minute timestamp window. `t` is included in the signed material
 * so a captured (signature, body) pair cannot be replayed indefinitely -
 * the receiver's own `X-WP-Timestamp` header carries the same value the
 * dispatcher used to build `s`, and `X-WP-Event-Id` (attached by the caller,
 * not this module) is what a receiver dedupes on for at-least-once delivery.
 * Pure, no I/O - `now` is always caller-injected, never `Date.now()`.
 */

const SIGNATURE_WINDOW_SECONDS = 5 * 60;

/** `hex(hmac-sha256(secret, "${timestamp}.${body}"))` - the ONE place the signed material is assembled. */
export function signWebhookBody(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex');
}

/** `v1,t=<unix>,s=<hex>` - byte-for-byte the documented header value. */
export function buildSignatureHeader(timestamp: number, signature: string): string {
  return `v1,t=${String(timestamp)},s=${signature}`;
}

export interface VerifyWebhookSignatureInput {
  secret: string;
  timestamp: number;
  signature: string;
  body: string;
  now: Date;
}

/**
 * True only when the signature matches AND `now` is within
 * `SIGNATURE_WINDOW_SECONDS` of `timestamp` (either direction - a clock
 * running slightly ahead is as valid a delivery as one running behind).
 * Constant-time comparison (`timingSafeEqual`) on the digest bytes, never a
 * plain `===` on the hex strings.
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const ageSeconds = Math.abs(nowSeconds - input.timestamp);
  if (ageSeconds > SIGNATURE_WINDOW_SECONDS) {
    return false;
  }

  const expected = signWebhookBody(input.secret, input.timestamp, input.body);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(input.signature, 'hex');
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}
