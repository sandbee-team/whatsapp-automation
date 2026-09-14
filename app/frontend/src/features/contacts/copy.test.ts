import { describe, expect, it } from 'vitest';
import { CONTACTS_COPY, BANNED_CLAIMS } from '@wp/domain';
import { en, hi } from '@wp/i18n';

/**
 * copy.test.ts (P20 Unit U9, step 10) - the honest contacts/import copy
 * proof, same purity idiom as `packages/domain/src/copy/pacing-copy.test.ts`:
 * the verbatim attestation sentence, no banned claim, no verification claim,
 * and identical `contacts.*` key sets across both catalogues.
 */

const BANNED_VERIFICATION_PATTERN =
  /verified numbers|whatsapp-checked|verify(?:ing)? (?:the )?numbers|guaranteed|instant/i;

function containsBannedClaim(value: string): string | undefined {
  const normalized = value.toLowerCase();
  return BANNED_CLAIMS.find((claim) => normalized.includes(claim.toLowerCase()));
}

function contactsKeys(catalogue: Record<string, string>): string[] {
  return Object.keys(catalogue).filter((key) => key.startsWith('contacts.'));
}

describe('CONTACTS_COPY', () => {
  it('import_copy_states_that_we_cannot_verify_consent', () => {
    expect(CONTACTS_COPY.attestationNotice).toBe(
      'We record who asserted consent; we do not and cannot verify it.',
    );
    expect(en['contacts.import.attestationNotice']).toBe(CONTACTS_COPY.attestationNotice);
  });

  it('every_contacts_copy_string_and_catalogue_key_is_honest', () => {
    const domainStrings = Object.values(CONTACTS_COPY);
    const enContactsKeys = contactsKeys(en);
    const hiContactsKeys = contactsKeys(hi);
    const enStrings = enContactsKeys.map((key) => en[key as keyof typeof en] as string);
    const hiStrings = hiContactsKeys.map((key) => hi[key as keyof typeof hi] as string);

    for (const value of [...domainStrings, ...enStrings, ...hiStrings]) {
      const hit = containsBannedClaim(value);
      expect(hit, `banned claim "${String(hit)}" found in: "${value}"`).toBeUndefined();
      expect(value).not.toMatch(BANNED_VERIFICATION_PATTERN);
    }
  });

  it('the_two_catalogues_carry_the_same_contacts_key_set', () => {
    const enKeys = contactsKeys(en).sort();
    const hiKeys = contactsKeys(hi).sort();
    expect(hiKeys).toEqual(enKeys);
  });
});
