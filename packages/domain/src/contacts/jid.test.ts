import { describe, expect, it } from 'vitest';
import { normaliseJid } from './jid.js';

/**
 * jid.test.ts (P20 Unit U2, step 3) - `normaliseJid` unit tests. Pure
 * `@wp/domain` module, no `@wp/server-kit` in the import chain.
 */

describe('normaliseJid', () => {
  it('every_provider_jid_goes_through_jid_normalized_user', () => {
    const expected = {
      jid: '15550001111@s.whatsapp.net',
      addressingMode: 'pn' as const,
      unattributable: false,
      e164: '+15550001111',
    };
    const inputs = [
      '15550001111@s.whatsapp.net',
      '15550001111:12@s.whatsapp.net',
      '15550001111_1@s.whatsapp.net',
      '15550001111@c.us',
      '15550001111@S.WHATSAPP.NET',
    ];
    for (const input of inputs) {
      expect(normaliseJid(input)).toMatchObject(expected);
    }
  });

  it('a_lid_sender_resolves_or_is_recorded_unattributable', () => {
    expect(normaliseJid('98765@lid')).toEqual({
      jid: '98765@lid',
      addressingMode: 'lid',
      unattributable: true,
      e164: null,
      lidJid: '98765@lid',
    });

    expect(normaliseJid('98765@lid', { resolveLid: () => '15550001111@s.whatsapp.net' })).toEqual({
      jid: '15550001111@s.whatsapp.net',
      addressingMode: 'lid',
      unattributable: false,
      e164: '+15550001111',
      lidJid: '98765@lid',
    });

    let receivedArg: string | null = null;
    normaliseJid('98765:3@lid', {
      resolveLid: (normalisedLidJid) => {
        receivedArg = normalisedLidJid;
        return null;
      },
    });
    expect(receivedArg).toBe('98765@lid');
  });

  it('group_and_broadcast_jids_are_never_contacts', () => {
    const inputs = ['123456789-987654321@g.us', 'status@broadcast', '', 'no-at-sign'];
    for (const input of inputs) {
      const result = normaliseJid(input);
      expect(result.unattributable).toBe(true);
      expect(result.e164).toBeNull();
    }
  });
});
