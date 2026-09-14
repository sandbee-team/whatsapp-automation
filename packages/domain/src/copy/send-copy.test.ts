import { describe, expect, it } from 'vitest';
import { BANNED_CLAIMS } from './banned-claims.js';
import { PARKED_COPY } from './instance-copy.js';
import { COMPOSER_QUEUED_COPY, INSTANCE_OFFLINE_COPY } from './send-copy.js';

describe('send-copy', () => {
  it('composer_queued_copy_matches_the_honest_wording_verbatim', () => {
    expect(COMPOSER_QUEUED_COPY).toBe('Queued — will send from your connected number');
  });

  it('composer_queued_copy_contains_no_banned_claim', () => {
    const lower = COMPOSER_QUEUED_COPY.toLowerCase();
    for (const claim of BANNED_CLAIMS) {
      expect(lower.includes(claim.toLowerCase())).toBe(false);
    }
  });

  it('composer_queued_copy_makes_no_delivery_time_or_instant_promise', () => {
    const lower = COMPOSER_QUEUED_COPY.toLowerCase();
    expect(lower.includes('instant')).toBe(false);
    expect(lower.includes('immediately')).toBe(false);
    expect(lower.includes('guarantee')).toBe(false);
  });

  it('instance_offline_copy_reuses_the_parked_wording_from_domain', () => {
    expect(INSTANCE_OFFLINE_COPY).toBe(PARKED_COPY);
  });

  it('instance_offline_copy_contains_no_banned_claim', () => {
    const lower = INSTANCE_OFFLINE_COPY.toLowerCase();
    for (const claim of BANNED_CLAIMS) {
      expect(lower.includes(claim.toLowerCase())).toBe(false);
    }
  });
});
