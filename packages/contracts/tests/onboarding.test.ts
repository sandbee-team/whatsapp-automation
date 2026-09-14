import { describe, expect, it } from 'vitest';
import { onboardingStepSchema, timezoneSchema, setPacingProfileInputSchema } from '../src/index.js';

describe('onboardingStepSchema', () => {
  it('the_7_step_labels_match_the_db_enum_exactly_and_in_order', () => {
    expect(onboardingStepSchema.options).toEqual([
      'verify_email',
      'choose_timezone',
      'accept_pacing_profile',
      'attest_consent',
      'connect_whatsapp',
      'send_test',
      'done',
    ]);
  });
});

describe('timezoneSchema', () => {
  it('accepts_a_valid_IANA_zone', () => {
    expect(timezoneSchema.safeParse('Asia/Kolkata').success).toBe(true);
  });

  it('rejects_an_unknown_zone_name', () => {
    expect(timezoneSchema.safeParse('Not/AZone').success).toBe(false);
  });

  it('rejects_a_fixed_offset_string', () => {
    expect(timezoneSchema.safeParse('UTC+5').success).toBe(false);
  });
});

describe('setPacingProfileInputSchema', () => {
  it('accepts_the_wizard_own_safe_default_key', () => {
    expect(setPacingProfileInputSchema.safeParse({ profileKey: 'safe_default' }).success).toBe(
      true,
    );
  });

  it('rejects_a_key_containing_a_control_character', () => {
    const controlCharKey = 'standard' + String.fromCharCode(0) + 'profile';
    expect(setPacingProfileInputSchema.safeParse({ profileKey: controlCharKey }).success).toBe(
      false,
    );
  });

  it('rejects_a_key_over_64_chars', () => {
    expect(setPacingProfileInputSchema.safeParse({ profileKey: 'a'.repeat(65) }).success).toBe(
      false,
    );
  });

  it('rejects_an_empty_key', () => {
    expect(setPacingProfileInputSchema.safeParse({ profileKey: '' }).success).toBe(false);
  });

  it('rejects_uppercase_and_other_non_machine_identifier_characters', () => {
    expect(setPacingProfileInputSchema.safeParse({ profileKey: 'Standard Profile!' }).success).toBe(
      false,
    );
  });
});
