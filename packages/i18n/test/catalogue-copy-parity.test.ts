import { describe, expect, it } from 'vitest';
import {
  SAFE_MODE_DISCLAIMER,
  INSTANCE_CARD_COPY,
  BROADCAST_DISCLOSURE,
  BROADCAST_FREQUENCY_NOTE,
  BROADCAST_ESTIMATE_CAVEAT,
  GROUP_RISK_DISCLOSURE,
} from '@wp/domain';
import { en } from '../src/catalogues/en.js';
import { hi } from '../src/catalogues/hi.js';
import { BROADCAST_ACCOUNT_SAFE_MODE_DISCLAIMER_LITERAL as EN_ACCOUNT_SAFE_MODE_DISCLAIMER } from '../src/catalogues/en-broadcasts.js';
import { BROADCAST_ACCOUNT_SAFE_MODE_DISCLAIMER_LITERAL as HI_ACCOUNT_SAFE_MODE_DISCLAIMER } from '../src/catalogues/hi-broadcasts.js';

/**
 * catalogue-copy-parity.test.ts (P17 U5; extended P23 U2 step 3, P23a U3
 * step 1) - drift guard: the `en` catalogue's `instances.card.
 * safeModeDisclaimer`, `instances.card.parked`, `broadcasts.disclosure`,
 * `broadcasts.frequencyLine` and `broadcasts.estimateCaveat` values must stay
 * byte-identical to their `@wp/domain` source (`SAFE_MODE_DISCLAIMER`,
 * `INSTANCE_CARD_COPY.parked`, `BROADCAST_DISCLOSURE`,
 * `BROADCAST_FREQUENCY_NOTE`, `BROADCAST_ESTIMATE_CAVEAT`) - `en.ts`/
 * `en-broadcasts.ts` carry their own copy of the literal (never an import:
 * `@wp/i18n` has zero dependencies, ADR 0007) so `scripts/check-copy.ts`'s
 * plain substring match over the file's own text on disk still sees the
 * disclaimer/disclosure. `hi.ts` keeps `broadcasts.disclosure` in English too
 * (same convention as `safeModeDisclaimer`'s own English-only literal) and
 * IS asserted byte-identical here, unlike `parked` which is a faithful Hindi
 * translation. P24 groups-messaging Unit U2 extends this with
 * `groups.disclosure` ↔ `GROUP_RISK_DISCLOSURE`, same treatment.
 */
describe('en catalogue copy parity with @wp/domain', () => {
  it('en_safe_mode_disclaimer_is_byte_identical_to_the_domain_constant', () => {
    expect(en['instances.card.safeModeDisclaimer']).toBe(SAFE_MODE_DISCLAIMER);
  });

  it('en_parked_string_is_byte_identical_to_the_domain_constant', () => {
    expect(en['instances.card.parked']).toBe(INSTANCE_CARD_COPY.parked);
  });

  it('en_broadcast_disclosure_is_byte_identical_to_the_domain_constant', () => {
    expect(en['broadcasts.disclosure']).toBe(BROADCAST_DISCLOSURE);
  });

  it('hi_broadcast_disclosure_is_byte_identical_to_the_domain_constant', () => {
    expect(hi['broadcasts.disclosure']).toBe(BROADCAST_DISCLOSURE);
  });

  it('en_broadcast_frequency_line_is_byte_identical_to_the_domain_constant', () => {
    expect(en['broadcasts.frequencyLine']).toBe(BROADCAST_FREQUENCY_NOTE);
  });

  it('en_broadcast_estimate_caveat_is_byte_identical_to_the_domain_constant', () => {
    expect(en['broadcasts.estimateCaveat']).toBe(BROADCAST_ESTIMATE_CAVEAT);
  });

  it('en_broadcast_account_safe_mode_disclaimer_is_byte_identical_to_the_domain_constant', () => {
    expect(EN_ACCOUNT_SAFE_MODE_DISCLAIMER).toBe(SAFE_MODE_DISCLAIMER);
  });

  it('hi_broadcast_account_safe_mode_disclaimer_is_byte_identical_to_the_domain_constant', () => {
    expect(HI_ACCOUNT_SAFE_MODE_DISCLAIMER).toBe(SAFE_MODE_DISCLAIMER);
  });

  it('en_group_disclosure_is_byte_identical_to_the_domain_constant', () => {
    expect(en['groups.disclosure']).toBe(GROUP_RISK_DISCLOSURE);
  });

  it('hi_group_disclosure_is_byte_identical_to_the_domain_constant', () => {
    expect(hi['groups.disclosure']).toBe(GROUP_RISK_DISCLOSURE);
  });
});
