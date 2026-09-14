import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS } from '../enums/index.js';
import { NOTIFICATION_COPY } from './notifications.js';
import { PACING_COPY } from './pacing-copy.js';
import { INFRA_UNAVAILABLE_COPY } from './infra-unavailable-copy.js';

/**
 * copy/notifications.test.ts (P17 Unit U2) - proves NOTIFICATION_COPY is
 * total over NOTIFICATION_KINDS, every email body ends with the required
 * panel tail line, pause bodies reuse PACING_COPY verbatim (never restated),
 * and infra_unavailable reuses INFRA_UNAVAILABLE_COPY verbatim.
 */

const PANEL_TAIL =
  'Open the WP panel for details and history — further alerts this hour may be summarised there.';

describe('NOTIFICATION_COPY (P17 Unit U2)', () => {
  it('is_total_over_notification_kinds_with_email_and_title_shape', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const entry = NOTIFICATION_COPY[kind];
      expect(entry).toBeDefined();
      expect(typeof entry.title).toBe('string');
      expect(entry.title.length).toBeGreaterThan(0);
      expect(typeof entry.email.subject).toBe('string');
      expect(entry.email.subject.length).toBeGreaterThan(0);
      expect(typeof entry.email.body).toBe('string');
      expect(entry.email.body.endsWith(PANEL_TAIL)).toBe(true);
    }
  });

  it('reuses_pacing_copy_for_pause_bodies_instead_of_restating_them', () => {
    expect(NOTIFICATION_COPY.instance_paused.email.body).toContain(
      PACING_COPY.instancePausedRestriction,
    );
  });

  it('reuses_infra_unavailable_copy_verbatim', () => {
    expect(NOTIFICATION_COPY.infra_unavailable.email.body).toContain(INFRA_UNAVAILABLE_COPY);
  });
});
