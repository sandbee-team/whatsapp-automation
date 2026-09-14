import { describe, expect, it } from 'vitest';
import { PARKED_COPY, PARKED_BUFFER_CAVEAT, maskPhoneE164 } from './instance-copy.js';

describe('instance-copy', () => {
  it('parked_copy_matches_adr_0018_verbatim', () => {
    expect(PARKED_COPY).toBe(
      'Parked — not connected. This number is not receiving messages while parked. Messages people send you during this time may not appear after you reconnect. Queued messages are safe and will send when you reconnect.',
    );
  });

  it('parked_buffer_caveat_is_a_single_honest_sentence', () => {
    expect(PARKED_BUFFER_CAVEAT).toBe(
      "WhatsApp's server-side buffer for an offline linked device is neither documented nor unlimited — we don't know how much is retained or for how long.",
    );
    // One sentence in spirit: exactly one terminal period, not mid-string.
    expect(PARKED_BUFFER_CAVEAT.trim().endsWith('.')).toBe(true);
  });

  describe('connected_label_masks_the_number', () => {
    const cases: readonly string[] = [
      '+919876543221',
      '+14155552671',
      '+447911123456',
      '+8613800138000',
    ];

    it('every input maps to the masked shape and never leaks more than 5 input digits', () => {
      const shape = /^\+\d{1,3}·····\d{2}$/u;
      for (const e164 of cases) {
        const masked = maskPhoneE164(e164);
        expect(masked).toMatch(shape);

        // Exactly five middle dots.
        const dotCount = [...masked].filter((ch) => ch === '·').length;
        expect(dotCount).toBe(5);

        // Strip the leading '+' and count digits actually present in the
        // masked output (country code prefix + last-two suffix) - must never
        // exceed 5 (a generous upper bound on country-code length 3 + 2).
        const digitsInOutput = (masked.match(/\d/gu) ?? []).length;
        expect(digitsInOutput).toBeLessThanOrEqual(5);

        // The masked output must never equal or contain the full original
        // digit run (no accidental pass-through).
        const originalDigits = e164.replace(/\D/gu, '');
        expect(masked).not.toContain(originalDigits);
      }
    });

    it('preserves the last two digits of the input', () => {
      expect(maskPhoneE164('+919876543221')).toMatch(/21$/u);
      expect(maskPhoneE164('+14155552671')).toMatch(/71$/u);
    });
  });
});
