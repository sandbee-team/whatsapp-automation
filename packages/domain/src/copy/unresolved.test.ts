import { describe, expect, it } from 'vitest';
import { BANNED_CLAIMS } from './banned-claims.js';
import {
  UNRESOLVED_DISCARD_BUTTON_COPY,
  UNRESOLVED_EXPLANATION_COPY,
  UNRESOLVED_RETRY_BUTTON_COPY,
} from './unresolved.js';

describe('unresolved-copy', () => {
  it('unresolved_copy_contains_no_banned_claims_and_states_both_risks', () => {
    const all = [
      UNRESOLVED_RETRY_BUTTON_COPY,
      UNRESOLVED_DISCARD_BUTTON_COPY,
      UNRESOLVED_EXPLANATION_COPY,
    ].join(' ');
    const lower = all.toLowerCase();

    for (const claim of BANNED_CLAIMS) {
      expect(lower.includes(claim.toLowerCase())).toBe(false);
    }

    // Both button strings verbatim from the blueprint (canon, byte for byte).
    expect(UNRESOLVED_RETRY_BUTTON_COPY).toBe('Retry (may duplicate)');
    expect(UNRESOLVED_DISCARD_BUTTON_COPY).toBe('Discard (may have been delivered)');

    // The explanation states both risks honestly - retry may duplicate,
    // discard may leave it unsent - and makes no delivery-time or
    // reliability promise.
    expect(lower.includes('twice')).toBe(true);
    expect(lower.includes('unsent')).toBe(true);
    expect(lower.includes('guarantee')).toBe(false);
    expect(lower.includes('never lost')).toBe(false);
  });

  it('unresolved_explanation_copy_matches_the_honest_wording_verbatim', () => {
    expect(UNRESOLVED_EXPLANATION_COPY).toBe(
      'We could not confirm delivery of this message. WhatsApp did not acknowledge it before the connection dropped. Retrying may deliver it twice. Discarding may leave it unsent.',
    );
  });
});
