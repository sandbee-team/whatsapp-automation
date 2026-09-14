import { describe, expect, it } from 'vitest';
import { signWebhookBody, verifyWebhookSignature, buildSignatureHeader } from './sign.js';

/**
 * sign.test.ts (P15 U5, step 7) - the `X-WP-Signature: v1,t=<unix>,s=<hex
 * hmac-sha256(t + "." + body)>` shape, byte-for-byte, plus the receiver's own
 * 5-minute timestamp window. Pure, no I/O, no fake clock library - `now`
 * is always an injected `Date`.
 */

const SECRET = 'whsec_test_secret_do_not_use_in_prod';
const BODY = '{"id":"evt_1","type":"message.job.status_changed"}';

describe('signWebhookBody / verifyWebhookSignature', () => {
  it('a_tampered_body_fails_verification', () => {
    const now = new Date('2026-09-02T12:00:00.000Z');
    const timestamp = Math.floor(now.getTime() / 1000);
    const signature = signWebhookBody(SECRET, timestamp, BODY);

    const tamperedBody = BODY.slice(0, -1) + (BODY.endsWith('}') ? ']' : '}');
    expect(tamperedBody).not.toBe(BODY);

    const ok = verifyWebhookSignature({
      secret: SECRET,
      timestamp,
      signature,
      body: tamperedBody,
      now,
    });
    expect(ok).toBe(false);
  });

  it('the_header_matches_the_documented_v1_format_byte_for_byte', () => {
    const now = new Date('2026-09-02T12:00:00.000Z');
    const timestamp = Math.floor(now.getTime() / 1000);
    const signature = signWebhookBody(SECRET, timestamp, BODY);

    const header = buildSignatureHeader(timestamp, signature);
    expect(header).toBe(`v1,t=${String(timestamp)},s=${signature}`);
    // hex hmac-sha256 is exactly 64 lowercase hex chars.
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a_six_minute_old_signature_is_rejected_and_a_four_minute_one_is_accepted', () => {
    const signedAt = new Date('2026-09-02T12:00:00.000Z');
    const timestamp = Math.floor(signedAt.getTime() / 1000);
    const signature = signWebhookBody(SECRET, timestamp, BODY);

    const sixMinutesLater = new Date(signedAt.getTime() + 6 * 60 * 1000);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        signature,
        body: BODY,
        now: sixMinutesLater,
      }),
    ).toBe(false);

    const fourMinutesLater = new Date(signedAt.getTime() + 4 * 60 * 1000);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        signature,
        body: BODY,
        now: fourMinutesLater,
      }),
    ).toBe(true);
  });

  it('exactly_300_seconds_is_accepted_and_301_is_rejected_in_either_direction', () => {
    const signedAt = new Date('2026-09-02T12:00:00.000Z');
    const timestamp = Math.floor(signedAt.getTime() / 1000);
    const signature = signWebhookBody(SECRET, timestamp, BODY);

    // Forward direction (receiver clock ahead of the signer): exactly 300s
    // is the INCLUSIVE boundary (`ageSeconds > 300` rejects, so 300 itself
    // must pass) - never a bound like "recent enough", the exact second.
    const exactly300Later = new Date(signedAt.getTime() + 300 * 1000);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        signature,
        body: BODY,
        now: exactly300Later,
      }),
    ).toBe(true);

    const exactly301Later = new Date(signedAt.getTime() + 301 * 1000);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        signature,
        body: BODY,
        now: exactly301Later,
      }),
    ).toBe(false);

    // Backward direction (receiver clock BEHIND the signer, i.e. `now` is
    // earlier than `timestamp`) - `Math.abs` makes the window symmetric,
    // asserted at the same exact boundary, not just the forward direction.
    const exactly300Earlier = new Date(signedAt.getTime() - 300 * 1000);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        signature,
        body: BODY,
        now: exactly300Earlier,
      }),
    ).toBe(true);

    const exactly301Earlier = new Date(signedAt.getTime() - 301 * 1000);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        signature,
        body: BODY,
        now: exactly301Earlier,
      }),
    ).toBe(false);
  });
});
