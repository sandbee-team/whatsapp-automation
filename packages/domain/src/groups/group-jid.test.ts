import { describe, expect, it } from 'vitest';
import { isGroupJid, groupRecipientHashInput } from './group-jid.js';

/**
 * group-jid.test.ts (P24 groups-messaging, Unit U2, step 1).
 */
describe('isGroupJid', () => {
  it('is_true_only_for_a_g_us_server_case_insensitive', () => {
    expect(isGroupJid('120363012345678901@g.us')).toBe(true);
    expect(isGroupJid('120363012345678901@G.US')).toBe(true);
    expect(isGroupJid('120363012345678901:3@g.us')).toBe(true);
  });

  it('is_false_for_status_broadcast_newsletter_pn_and_lid_and_never_inspects_digits', () => {
    expect(isGroupJid('status@broadcast')).toBe(false);
    expect(isGroupJid('x@newsletter')).toBe(false);
    expect(isGroupJid('1@s.whatsapp.net')).toBe(false);
    expect(isGroupJid('1@lid')).toBe(false);
  });
});

describe('group_recipient_hash_is_derived_from_the_normalised_jid_not_digits', () => {
  it('device_agent_suffix_and_server_casing_variants_all_produce_the_identical_hash_input', () => {
    const withDevice = groupRecipientHashInput('120363012345678901:3@g.us');
    const upperServer = groupRecipientHashInput('120363012345678901@G.US');
    const plain = groupRecipientHashInput('120363012345678901@g.us');

    expect(withDevice).toBe(plain);
    expect(upperServer).toBe(plain);
  });

  it('a_dm_jid_throws_a_range_error', () => {
    expect(() => groupRecipientHashInput('1@s.whatsapp.net')).toThrow(RangeError);
  });
});
