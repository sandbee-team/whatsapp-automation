import { describe, expect, it } from 'vitest';
import { INSTANCE_CARD_COPY } from './instance-card.js';
import { PARKED_COPY } from './instance-copy.js';

/**
 * copy/instance-card.test.ts (P17 Unit U2) - proves the parked string is
 * VERBATIM (character-for-character, reused from `instance-copy.ts`'s
 * `PARKED_COPY`, never restated), the countdown-slot `notSending` string
 * never claims an ETA, and the why-drawer honesty labels exist with the
 * exact required wording.
 */

describe('INSTANCE_CARD_COPY (P17 Unit U2)', () => {
  it('the_parked_string_is_verbatim_character_for_character', () => {
    expect(INSTANCE_CARD_COPY.parked).toBe(PARKED_COPY);
    expect(INSTANCE_CARD_COPY.parked).toBe(
      'Parked — not connected. This number is not receiving messages while parked. Messages ' +
        'people send you during this time may not appear after you reconnect. Queued messages ' +
        'are safe and will send when you reconnect.',
    );
  });

  it('the_not_sending_countdown_copy_never_calls_the_floor_an_eta', () => {
    const text = INSTANCE_CARD_COPY.notSending.toLowerCase();
    expect(text).not.toContain('eta');
    expect(text.length).toBeGreaterThan(0);
  });

  it('why_drawer_honesty_labels_are_exact', () => {
    expect(INSTANCE_CARD_COPY.signalNotScored).toBe(
      'Observed but not scored in v1 — shown for transparency, costing 0 points.',
    );
    expect(INSTANCE_CARD_COPY.signalNotEnoughData).toBe(
      'Not enough data yet — this is not a penalty.',
    );
  });
});
