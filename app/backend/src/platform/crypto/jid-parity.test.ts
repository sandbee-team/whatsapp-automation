import { describe, expect, it } from 'vitest';
import { jidNormalizedUser } from 'baileys';
import { normalizeJidUser } from '@wp/domain';

/**
 * jid-parity.test.ts (P20 Unit U2, step 3) - proves `@wp/domain`'s ported
 * `normalizeJidUser` matches Baileys' own `jidNormalizedUser` byte-for-byte
 * over every case this module cares about. Only `baileys` and `@wp/domain`
 * are imported (neither reaches `@wp/server-kit`'s config singleton), so no
 * `stub-wp-server-kit-env.js` first-import guard is needed here. `baileys`
 * is already an `app/backend` dependency (see `package.json`), and no
 * dependency-cruiser rule restricts importing it outside `provider/**` (only
 * `server-kit-src-never-imports-baileys` exists), so this file may live here.
 */

describe('normalizeJidUser (domain port) vs jidNormalizedUser (baileys)', () => {
  it('the_domain_port_matches_baileys_jid_normalized_user_byte_for_byte', () => {
    const inputs = [
      '15550001111@s.whatsapp.net',
      '15550001111:12@s.whatsapp.net',
      '15550001111_1@s.whatsapp.net',
      '15550001111@c.us',
      '123456789-987654321@g.us',
      '98765@lid',
      '98765:3@lid',
      'status@broadcast',
      '',
      'no-at-sign',
      '@s.whatsapp.net',
      '15550001111@hosted',
      '15550001111@hosted.lid',
    ];

    for (const input of inputs) {
      expect(normalizeJidUser(input)).toBe(jidNormalizedUser(input));
    }
  });
});
