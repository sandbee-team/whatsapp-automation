import { describe, expect, it } from 'vitest';
import { classifySendError } from './error-map.js';

/**
 * error-map.test.ts (P11 Unit U2, step 4, written FIRST) - a case per
 * mapped category plus the fail-safe rule
 * (`an_unrecognised_provider_error_maps_to_unknown_and_never_to_transient`,
 * core invariant 2) and 429 `retryAfterMs` extraction.
 */

function boom(
  statusCode: number | undefined,
  opts: { message?: string; headers?: Record<string, unknown> } = {},
) {
  return {
    message: opts.message ?? 'boom',
    output: { statusCode, headers: opts.headers ?? {} },
  };
}

describe('classifySendError', () => {
  it('maps 400 to invalid_payload', () => {
    expect(classifySendError(boom(400))).toEqual({ sendErrorClass: 'invalid_payload' });
  });

  it('maps 401 to restricted', () => {
    expect(classifySendError(boom(401))).toEqual({ sendErrorClass: 'restricted' });
  });

  it('maps 403 to restricted', () => {
    expect(classifySendError(boom(403))).toEqual({ sendErrorClass: 'restricted' });
  });

  it('maps 408 to not_connected', () => {
    expect(classifySendError(boom(408))).toEqual({ sendErrorClass: 'not_connected' });
  });

  it('maps 428 connectionClosed to not_connected', () => {
    expect(classifySendError(boom(428))).toEqual({ sendErrorClass: 'not_connected' });
  });

  it('maps 500/502/503/504 to transient', () => {
    for (const code of [500, 502, 503, 504]) {
      expect(classifySendError(boom(code))).toEqual({ sendErrorClass: 'transient' });
    }
  });

  it('a_429_maps_to_rate_limited_and_extracts_retry_after_ms', () => {
    const result = classifySendError(boom(429, { headers: { 'retry-after': '5' } }));
    expect(result).toEqual({ sendErrorClass: 'rate_limited', retryAfterMs: 5000 });
  });

  it('a_429_with_no_retry_after_header_still_maps_to_rate_limited', () => {
    expect(classifySendError(boom(429))).toEqual({ sendErrorClass: 'rate_limited' });
  });

  it('maps the oversized-media message substring to invalid_payload with no statusCode', () => {
    const err = boom(undefined, { message: 'content length exceeded when encrypting "remote"' });
    expect(classifySendError(err)).toEqual({ sendErrorClass: 'invalid_payload' });
  });

  it('an_unrecognised_provider_error_maps_to_unknown_and_never_to_transient', () => {
    expect(classifySendError(boom(599))).toEqual({ sendErrorClass: 'unknown' });
    expect(classifySendError(new Error('some totally unrelated failure'))).toEqual({
      sendErrorClass: 'unknown',
    });
    expect(classifySendError(null)).toEqual({ sendErrorClass: 'unknown' });
    expect(classifySendError(undefined)).toEqual({ sendErrorClass: 'unknown' });
    expect(classifySendError('a plain string')).toEqual({ sendErrorClass: 'unknown' });
  });

  // --- P16 Unit C: @g.us authorisation carve-out ---------------------------

  it('a_403_targeting_a_group_jid_with_an_authorisation_reason_maps_to_group_forbidden', () => {
    const notAdmin = boom(403, { message: 'not-admin' });
    expect(classifySendError(notAdmin, { recipientJid: '120363012345678901@g.us' })).toEqual({
      sendErrorClass: 'group_forbidden',
    });

    const announceMode = boom(403, { message: 'announce-mode' });
    expect(classifySendError(announceMode, { recipientJid: '120363012345678901@g.us' })).toEqual({
      sendErrorClass: 'group_forbidden',
    });

    const notParticipant = boom(403, { message: 'not-participant' });
    expect(classifySendError(notParticipant, { recipientJid: '120363012345678901@g.us' })).toEqual({
      sendErrorClass: 'group_forbidden',
    });
  });

  it('a_403_on_a_group_jid_with_no_authorisation_reason_still_maps_to_restricted', () => {
    // The carve-out only applies to authorisation-shaped reasons - a plain
    // 403 with no recognised reason on a @g.us target stays 'restricted' so
    // it still contributes to the instance-level restriction signal.
    const plain403 = boom(403);
    expect(classifySendError(plain403, { recipientJid: '120363012345678901@g.us' })).toEqual({
      sendErrorClass: 'restricted',
    });
  });

  it('an_authorisation_shaped_403_on_a_non_group_jid_stays_restricted', () => {
    const notAdmin = boom(403, { message: 'not-admin' });
    expect(classifySendError(notAdmin, { recipientJid: '15550001234@s.whatsapp.net' })).toEqual({
      sendErrorClass: 'restricted',
    });
  });

  it('the_carve_out_never_applies_when_no_recipient_jid_is_supplied', () => {
    const notAdmin = boom(403, { message: 'not-admin' });
    expect(classifySendError(notAdmin)).toEqual({ sendErrorClass: 'restricted' });
  });
});
