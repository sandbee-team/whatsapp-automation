import { describe, expect, it } from 'vitest';
import { shouldIgnoreJid } from './ignore-jid.js';

describe('shouldIgnoreJid', () => {
  it('status_and_newsletter_jids_are_ignored_in_both_scopes', () => {
    const cases: Array<{ jid: string }> = [
      { jid: 'status@broadcast' },
      { jid: 'STATUS@BROADCAST' },
      { jid: '123456@newsletter' },
    ];

    for (const { jid } of cases) {
      expect(shouldIgnoreJid(jid, { scope: 'message', sendEnabledGroupJids: new Set() })).toBe(
        true,
      );
      expect(shouldIgnoreJid(jid, { scope: 'receipt', sendEnabledGroupJids: new Set() })).toBe(
        true,
      );
    }
  });

  it('a_group_receipt_is_never_filtered_even_when_group_messages_are', () => {
    const groupJid = '120363@g.us';

    expect(shouldIgnoreJid(groupJid, { scope: 'message', sendEnabledGroupJids: new Set() })).toBe(
      true,
    );
    expect(shouldIgnoreJid(groupJid, { scope: 'receipt', sendEnabledGroupJids: new Set() })).toBe(
      false,
    );

    const enabledSet = new Set([groupJid]);
    expect(shouldIgnoreJid(groupJid, { scope: 'message', sendEnabledGroupJids: enabledSet })).toBe(
      false,
    );
    expect(shouldIgnoreJid(groupJid, { scope: 'receipt', sendEnabledGroupJids: enabledSet })).toBe(
      false,
    );
  });

  it('a_send_enabled_group_message_is_not_filtered', () => {
    const groupJid = '120363@g.us';
    const enabledSet = new Set([groupJid]);

    expect(shouldIgnoreJid(groupJid, { scope: 'message', sendEnabledGroupJids: enabledSet })).toBe(
      false,
    );
  });

  it('direct_and_lid_jids_are_never_filtered', () => {
    const jids = ['91xxxx@s.whatsapp.net', '12345@lid'];

    for (const jid of jids) {
      expect(shouldIgnoreJid(jid, { scope: 'message', sendEnabledGroupJids: new Set() })).toBe(
        false,
      );
      expect(shouldIgnoreJid(jid, { scope: 'receipt', sendEnabledGroupJids: new Set() })).toBe(
        false,
      );
    }
  });

  it('a_missing_or_empty_jid_is_ignored_only_in_message_scope', () => {
    for (const jid of [null, undefined, '']) {
      expect(shouldIgnoreJid(jid, { scope: 'message', sendEnabledGroupJids: new Set() })).toBe(
        true,
      );
      expect(shouldIgnoreJid(jid, { scope: 'receipt', sendEnabledGroupJids: new Set() })).toBe(
        false,
      );
    }
  });

  it('the_receipt_scope_never_consults_the_group_set', () => {
    class ThrowingSet extends Set<string> {
      override has(): boolean {
        throw new Error('sendEnabledGroupJids must not be read in receipt scope');
      }
    }
    const throwingSet = new ThrowingSet();
    const groupJid = '120363@g.us';

    expect(shouldIgnoreJid(groupJid, { scope: 'receipt', sendEnabledGroupJids: throwingSet })).toBe(
      false,
    );

    expect(() =>
      shouldIgnoreJid(groupJid, { scope: 'message', sendEnabledGroupJids: throwingSet }),
    ).toThrow();
  });
});
