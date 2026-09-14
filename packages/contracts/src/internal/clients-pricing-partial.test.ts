import { describe, expect, it } from 'vitest';
import { setClientPricingInputSchema } from './clients.js';

/**
 * clients-pricing-partial.test.ts (P28 Unit U3b, step 5) - pins the
 * `overrideItems` PARTIAL semantics `setClientPricingInputSchema`'s own doc
 * comment promises ("an empty object clears every override").
 *
 * Regression guard: the schema originally used `z.record(z.enum([...]), ...)`,
 * which in Zod 4 is EXHAUSTIVE over the key enum - so `{ text: '90' }` (the
 * single most common staff pricing change) was rejected as a 400 with
 * "expected string, received undefined" for the three keys the caller had
 * deliberately left alone. Fixed to `z.partialRecord`; these cases are what
 * stop it regressing.
 */

const REASON = 'negotiated enterprise rate card for this account';

describe('setClientPricingInputSchema overrideItems is partial', () => {
  it('a_single_key_override_parses_and_leaves_the_other_three_keys_absent', () => {
    const parsed = setClientPricingInputSchema.parse({
      reason: REASON,
      overrideItems: { text: '90' },
    });
    expect(parsed.overrideItems).toEqual({ text: '90' });
  });

  it('an_empty_override_items_object_parses_as_the_clear_everything_case', () => {
    const parsed = setClientPricingInputSchema.parse({ reason: REASON, overrideItems: {} });
    expect(parsed.overrideItems).toEqual({});
  });

  it('all_four_keys_together_still_parse', () => {
    const overrideItems = { text: '90', media: '150', group_text: '80', group_media: '140' };
    const parsed = setClientPricingInputSchema.parse({ reason: REASON, overrideItems });
    expect(parsed.overrideItems).toEqual(overrideItems);
  });

  it('an_unknown_price_key_is_still_rejected', () => {
    const result = setClientPricingInputSchema.safeParse({
      reason: REASON,
      overrideItems: { sms: '90' },
    });
    expect(result.success).toBe(false);
  });

  it('a_non_paise_value_is_still_rejected', () => {
    const result = setClientPricingInputSchema.safeParse({
      reason: REASON,
      overrideItems: { text: '9.5' },
    });
    expect(result.success).toBe(false);
  });
});
