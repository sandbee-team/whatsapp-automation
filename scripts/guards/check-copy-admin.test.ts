import { describe, expect, it } from 'vitest';
import { BANNED_CLAIMS, NOTIFICATION_COPY } from '@wp/domain';
import { runCheckCopy, COPY_GLOBS } from '../check-copy.js';
import { resolveFiles } from './scan-config.js';

/**
 * check-copy-admin.test.ts (P28 Unit U3b, step 5) - the real-tree copy proof
 * for the P28 admin/staff-action notification copy. A SIBLING of
 * `check-copy.test.ts`, which sits at exactly 300/300 lines (the established
 * split idiom - never trim a guard's own behaviour comment to make room).
 *
 * WHY THIS MATTERS MORE HERE THAN FOR OTHER COPY: these strings are what a
 * tenant reads when WP SUPPORT stops their sending. If any of them said (or
 * implied) that WhatsApp restricted, banned or blocked the account, we would
 * be attributing OUR OWN commercial/compliance decision to the provider -
 * dishonest, and squarely against core invariant 6 / the safety-compliance
 * skill's "honest product claims". So the assertions below are not just the
 * generic banned-claims scan: `client_suspended` must state plainly that WP
 * support did this and that queued work is preserved, and must contain none
 * of `restrict`/`ban`/`block`/`whatsapp` in any casing.
 */

const ADMIN_COPY_FILE = 'packages/domain/src/copy/notifications-p28-admin.ts';
const BASE_COPY_FILE = 'packages/domain/src/copy/notifications.ts';

describe('P28 admin notification copy', () => {
  it('admin_and_notification_copy_contains_no_banned_claims', () => {
    // (a) the real-tree scan finds zero violations in either copy file.
    const result = runCheckCopy();
    for (const file of [ADMIN_COPY_FILE, BASE_COPY_FILE]) {
      expect(
        result.violations.filter((violation) => violation.file === file),
        `banned-claim violations in ${file}`,
      ).toEqual([]);
    }

    // (b) both files are actually IN the scanned set - a scan that silently
    // matched neither would report zero violations for the wrong reason.
    const matchedFiles = resolveFiles(COPY_GLOBS);
    expect(matchedFiles).toContain(ADMIN_COPY_FILE);
    expect(matchedFiles).toContain(BASE_COPY_FILE);

    // (c) the suspension body says WHO did this and that work is preserved.
    const suspendedBody = NOTIFICATION_COPY.client_suspended.email.body;
    expect(suspendedBody).toContain(
      'Sending is suspended by WP support. Your queued messages are preserved.',
    );

    // (d) and never attributes it to the provider, in any casing.
    for (const forbidden of [/restrict/i, /\bban/i, /block/i, /whatsapp/i]) {
      expect(
        forbidden.test(suspendedBody),
        `client_suspended body must not match ${String(forbidden)}`,
      ).toBe(false);
    }

    // (e) the same no-provider-attribution rule for every OTHER staff-action
    // kind this phase added - a per-kind copy drift is exactly how one of
    // these ends up blaming WhatsApp for a support decision.
    const staffActionKinds = [
      'client_reactivated',
      'limits_changed',
      'pricing_changed',
      'pacing_relaxed',
      'instance_paused_by_staff',
      'instance_resumed_by_staff',
      'campaign_cancelled_by_staff',
    ] as const;
    for (const kind of staffActionKinds) {
      const entry = NOTIFICATION_COPY[kind];
      const text = `${entry.title} ${entry.email.subject} ${entry.email.body}`;
      for (const claim of BANNED_CLAIMS) {
        expect(
          text.toLowerCase().includes(claim.toLowerCase()),
          `${kind} copy contains banned claim "${claim}"`,
        ).toBe(false);
      }
      for (const forbidden of [/restrict/i, /\bban/i, /block/i]) {
        expect(forbidden.test(text), `${kind} copy must not match ${String(forbidden)}`).toBe(
          false,
        );
      }
    }
  });
});
