import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_CODE_TO_HTTP_STATUS,
  emailSchema,
  loginInputSchema,
  passwordSchema,
  phoneE164Schema,
  signupInputSchema,
  totpRecoveryInputSchema,
  authContract,
} from '../src/index.js';

describe('phone_e164 validate-and-replace', () => {
  it('a_spaced_national_number_with_country_code_is_replaced_with_canonical_e164', () => {
    expect(phoneE164Schema.parse('+91 98765 43210')).toBe('+919876543210');
  });

  it('a_local_format_number_with_the_default_IN_country_is_replaced_with_canonical_e164', () => {
    expect(phoneE164Schema.parse('098765 43210')).toBe('+919876543210');
  });

  it('a_non_numeric_string_is_rejected', () => {
    expect(phoneE164Schema.safeParse('abc').success).toBe(false);
  });

  it('a_too_short_number_with_a_country_code_is_rejected', () => {
    expect(phoneE164Schema.safeParse('+1 2').success).toBe(false);
  });
});

describe('email validate-and-replace', () => {
  it('is_trimmed_and_lowercased_by_parse', () => {
    expect(emailSchema.parse('  User@X.COM  ')).toBe('user@x.com');
  });

  it('rejects_an_invalid_email', () => {
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
  });

  it('rejects_a_100k_character_string_before_any_email_format_check', () => {
    const huge = `${'a'.repeat(100_000)}@example.com`;
    expect(emailSchema.safeParse(huge).success).toBe(false);
  });
});

describe('password rules', () => {
  it('rejects_11_characters', () => {
    expect(passwordSchema.safeParse('a'.repeat(11)).success).toBe(false);
  });

  it('accepts_12_characters', () => {
    expect(passwordSchema.safeParse('a'.repeat(12)).success).toBe(true);
  });

  it('rejects_129_characters', () => {
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  it('rejects_leading_whitespace', () => {
    expect(passwordSchema.safeParse(' starts-with-space').success).toBe(false);
  });
});

describe('signupInputSchema', () => {
  it('parses_a_valid_signup_payload_into_canonical_form', () => {
    const parsed = signupInputSchema.parse({
      fullName: '  Jane Doe  ',
      email: '  Jane@Example.COM ',
      phoneE164: '098765 43210',
      companyName: '  Acme Inc  ',
      password: 'correct-horse-battery',
    });

    expect(parsed).toEqual({
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      phoneE164: '+919876543210',
      companyName: 'Acme Inc',
      password: 'correct-horse-battery',
    });
  });
});

describe('loginInputSchema (M18, P04a FIXB)', () => {
  it('a_short_password_is_not_rejected_by_the_contract_before_the_dummy_verify', () => {
    // Login's password is not signup's 12-char policy - a short/legacy
    // password must reach login()'s timing-safe dummy-verify path, never
    // 400 at the contract boundary first.
    const parsed = loginInputSchema.safeParse({ email: 'user@example.com', password: 'short' });
    expect(parsed.success).toBe(true);
  });

  it('an_empty_password_is_still_rejected', () => {
    expect(loginInputSchema.safeParse({ email: 'user@example.com', password: '' }).success).toBe(
      false,
    );
  });

  it('a_129_character_password_is_still_rejected', () => {
    expect(
      loginInputSchema.safeParse({ email: 'user@example.com', password: 'a'.repeat(129) }).success,
    ).toBe(false);
  });
});

describe('totpRecoveryInputSchema (P04b Unit UB1a)', () => {
  it('accepts_a_trimmed_recovery_code_alongside_the_mfa_token', () => {
    const parsed = totpRecoveryInputSchema.safeParse({
      mfaToken: 'some.jwt.token',
      recoveryCode: '  A7K9QRZ2XM  ',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.recoveryCode).toBe('A7K9QRZ2XM');
    }
  });

  it('rejects_a_too_short_recovery_code', () => {
    expect(totpRecoveryInputSchema.safeParse({ mfaToken: 'x', recoveryCode: 'abc' }).success).toBe(
      false,
    );
  });

  it('is_wired_into_authContract', () => {
    expect(authContract.totpRecovery).toBeDefined();
  });
});

describe('new auth error codes', () => {
  it('ACCOUNT_LOCKED_MFA_REQUIRED_MFA_ENROLL_REQUIRED_EMAIL_NOT_VERIFIED_are_declared_with_status_codes', () => {
    expect(ERROR_CODES).toContain('ACCOUNT_LOCKED');
    expect(ERROR_CODES).toContain('MFA_REQUIRED');
    expect(ERROR_CODES).toContain('MFA_ENROLL_REQUIRED');
    expect(ERROR_CODES).toContain('EMAIL_NOT_VERIFIED');

    expect(ERROR_CODE_TO_HTTP_STATUS.ACCOUNT_LOCKED).toBe(403);
    expect(ERROR_CODE_TO_HTTP_STATUS.MFA_REQUIRED).toBe(401);
    expect(ERROR_CODE_TO_HTTP_STATUS.MFA_ENROLL_REQUIRED).toBe(403);
    expect(ERROR_CODE_TO_HTTP_STATUS.EMAIL_NOT_VERIFIED).toBe(403);
  });
});
