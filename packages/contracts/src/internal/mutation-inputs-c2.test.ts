import { describe, expect, it } from 'vitest';
import { internalMutationHeadersSchema, staffReasonSchema } from './common.js';
import { setClientLimitsInputSchema, setClientPricingInputSchema } from './clients.js';
import { adjustClientWalletInputSchema } from './wallet.js';

/**
 * mutation-inputs-c2.test.ts (P28 C2 hardening) - schema-boundary edge
 * cases for `/internal/v1` mutation inputs: an over-length `reason`, an
 * unknown `overrideItems` key, more than ten `overrides`, and the three
 * `amountMinor` shapes (`'0'`, `'-1'`, `'1e3'`) that must ALL be rejected
 * before any write, since `paiseAmountSchema` alone (`/^\d+$/`) admits
 * `'0'` and it is `adjustClientWalletInputSchema`'s own `refine(> 0n)` that
 * has to reject it. These are pure Zod `.safeParse` checks - the same
 * schemas the route handlers call before `withStaffMutation` is ever
 * entered, so a 400 here is provably a "before any write" 400.
 */

describe('internal mutation input schemas: boundary cases (P28 C2)', () => {
  it('a_reason_of_501_characters_is_rejected_by_staffReasonSchema', () => {
    const reason = 'x'.repeat(501);
    expect(staffReasonSchema.safeParse(reason).success).toBe(false);
    expect(staffReasonSchema.safeParse('x'.repeat(500)).success).toBe(true);
  });

  it('an_unknown_overrideItems_key_is_rejected', () => {
    const result = setClientPricingInputSchema.safeParse({
      reason: 'a pricing override with a bogus price key',
      overrideItems: { bogus_key: '10' },
    });
    expect(result.success).toBe(false);
  });

  it('an_overrides_array_of_eleven_entries_is_rejected_by_the_max_ten_bound', () => {
    const overrides = Array.from({ length: 11 }, (_, i) => ({
      limitKey: 'max_contacts' as const,
      limitValue: i,
    }));
    const result = setClientLimitsInputSchema.safeParse({
      reason: 'eleven overrides in one call, one over the cap',
      overrides,
    });
    expect(result.success).toBe(false);

    const tenIsFine = setClientLimitsInputSchema.safeParse({
      reason: 'exactly ten overrides in one call, at the cap',
      overrides: overrides.slice(0, 10),
    });
    expect(tenIsFine.success).toBe(true);
  });

  it('amountMinor_of_zero_or_negative_is_rejected_before_any_write', () => {
    const base = {
      reason: 'boundary amountMinor probe',
      externalRef: 'ext-ref-c2-probe',
    };
    for (const amountMinor of ['0', '-1']) {
      const result = adjustClientWalletInputSchema.safeParse({ ...base, amountMinor });
      expect(result.success).toBe(false);
    }
    // A genuinely positive integer string is fine - confirms the schema
    // itself is not simply rejecting everything.
    expect(adjustClientWalletInputSchema.safeParse({ ...base, amountMinor: '100' }).success).toBe(
      true,
    );
  });

  /**
   * P28 C2 FIX (Bug 3): `amountMinor: '1e3'` must fail VALIDATION cleanly
   * (a `safeParse` `success: false`, never a thrown `SyntaxError`).
   * Previously `adjustClientWalletInputSchema`'s `amountMinor` chained
   * `paiseAmountSchema.refine((value) => BigInt(value) > 0n, ...)` - in this
   * Zod 4 version a failing `.regex(/^\d+$/)` does not short-circuit the
   * chain, so the refine's predicate still ran against a value that had
   * already failed validation, and `BigInt('1e3')` threw a raw, uncaught
   * `SyntaxError` instead of the refine returning `false`. The fix
   * (`positivePaiseSchema` in `app/wallet.ts`) re-checks `/^\d+$/` INSIDE
   * the refine's own predicate before ever calling `BigInt`, so a
   * `safeParse` never throws - it always resolves to `success: false` for
   * an invalid `amountMinor`, which is what lets the route layer map it to
   * the 400 `VALIDATION_ERROR` every other malformed `amountMinor` already
   * produces, never a crash-shaped 500.
   */
  it('amountMinor_of_scientific_notation_fails_validation_cleanly_instead_of_throwing', () => {
    const base = {
      reason: 'boundary amountMinor probe (scientific notation)',
      externalRef: 'ext-ref-c2-probe-sci',
      amountMinor: '1e3',
    };
    let result: ReturnType<typeof adjustClientWalletInputSchema.safeParse> | undefined;
    expect(() => {
      result = adjustClientWalletInputSchema.safeParse(base);
    }).not.toThrow();
    expect(result?.success).toBe(false);
  });

  it('a_300_character_idempotency_key_header_is_rejected_by_the_255_char_bound', () => {
    const headers = {
      'idempotency-key': 'k'.repeat(300),
      'x-actor': 'staff:8f1c0000-0000-4000-8000-0000000000aa',
    };
    expect(internalMutationHeadersSchema.safeParse(headers).success).toBe(false);

    const withinBound = {
      ...headers,
      'idempotency-key': 'k'.repeat(255),
    };
    expect(internalMutationHeadersSchema.safeParse(withinBound).success).toBe(true);
  });
});
