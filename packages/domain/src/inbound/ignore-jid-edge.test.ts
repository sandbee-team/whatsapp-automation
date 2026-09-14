import { describe, expect, it } from 'vitest';
import { shouldIgnoreJid } from './ignore-jid.js';

/**
 * ignore-jid-edge.test.ts (P21 E3 hardening) - additional edge cases for
 * `shouldIgnoreJid` beyond the sibling `ignore-jid.test.ts`: trailing
 * whitespace, uppercase server casing, a bare '@g.us' with no user part, a
 * trailing '.' after 'newsletter', and the `@lid`/device-suffix jids the
 * message-signals layer routes through unfiltered.
 */
describe('shouldIgnoreJid edge cases', () => {
  it('a_trailing_space_on_status_broadcast_is_not_recognised_as_the_platform_jid', () => {
    // 'status@broadcast ' (trailing space) does not case-fold to the exact
    // literal match and has no '@' server-part match either - the current
    // implementation does NOT trim, so this is NOT ignored in either scope.
    const jidWithSpace = 'status@broadcast ';
    expect(
      shouldIgnoreJid(jidWithSpace, { scope: 'message', sendEnabledGroupJids: new Set() }),
    ).toBe(false);
    expect(
      shouldIgnoreJid(jidWithSpace, { scope: 'receipt', sendEnabledGroupJids: new Set() }),
    ).toBe(false);
  });

  it('a_newsletter_server_with_a_trailing_dot_is_not_recognised_as_newsletter', () => {
    // 'x@newsletter.' - server part is 'newsletter.', not 'newsletter', so
    // this is NOT the platform-noise server and is NOT ignored in message
    // scope (no '@g.us' either, so it falls through to "not ignored").
    const jid = 'x@newsletter.';
    expect(shouldIgnoreJid(jid, { scope: 'message', sendEnabledGroupJids: new Set() })).toBe(false);
    expect(shouldIgnoreJid(jid, { scope: 'receipt', sendEnabledGroupJids: new Set() })).toBe(false);
  });

  it('a_bare_at_g_us_with_no_user_part_is_a_group_server_match', () => {
    // '@g.us' alone: server part 'g.us', empty user. Message scope: it IS a
    // group jid (server === 'g.us'), so it is dropped unless allow-listed.
    // Receipt scope structurally never drops a group.
    const jid = '@g.us';
    expect(shouldIgnoreJid(jid, { scope: 'message', sendEnabledGroupJids: new Set() })).toBe(true);
    expect(shouldIgnoreJid(jid, { scope: 'receipt', sendEnabledGroupJids: new Set() })).toBe(false);
  });

  it('an_uppercase_group_server_is_still_recognised_as_a_group', () => {
    const jid = '120363@G.US';
    expect(shouldIgnoreJid(jid, { scope: 'message', sendEnabledGroupJids: new Set() })).toBe(true);
    // Allow-listing must be keyed on the case-insensitively-normalised jid
    // (normalizeJidUser folds the server it decodes, but the input server
    // casing itself is compared via serverPartLower first) - the allow-list
    // check uses `normalizeJidUser(jid)`, which does NOT lower-case the
    // server (only this module's own `serverPartLower` helper does, for the
    // routing decision). Assert the actual behaviour: the normalised form
    // used for the Set lookup preserves the input's original server case.
    const normalisedUppercase = '120363@G.US';
    expect(
      shouldIgnoreJid(jid, {
        scope: 'message',
        sendEnabledGroupJids: new Set([normalisedUppercase]),
      }),
    ).toBe(false);
  });

  it('a_device_suffixed_participant_jid_is_never_filtered_in_either_scope', () => {
    // '123:4@s.whatsapp.net' - a device-suffixed DM participant. Neither
    // status/newsletter nor a group server, so never ignored.
    const jid = '123:4@s.whatsapp.net';
    expect(shouldIgnoreJid(jid, { scope: 'message', sendEnabledGroupJids: new Set() })).toBe(false);
    expect(shouldIgnoreJid(jid, { scope: 'receipt', sendEnabledGroupJids: new Set() })).toBe(false);
  });

  it('a_lid_participant_in_a_group_context_is_never_filtered_by_jid_shape_alone', () => {
    // A `@lid` jid used as a group participant is not itself a '@g.us'
    // server, so it is never treated as a group jid by this filter (message
    // signals resolves lid attribution separately).
    const jid = '999888777@lid';
    expect(shouldIgnoreJid(jid, { scope: 'message', sendEnabledGroupJids: new Set() })).toBe(false);
    expect(shouldIgnoreJid(jid, { scope: 'receipt', sendEnabledGroupJids: new Set() })).toBe(false);
  });
});
