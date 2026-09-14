import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROADCAST_RECIPIENT_STATUSES } from '@wp/domain';
import { describe, expect, it } from 'vitest';
import { progressPayloadFor } from './funnel.repo.js';

/**
 * funnel.repo.test.ts (P23a Unit U2, step 4) - pure unit tests for the
 * progress-funnel repo module: (1) a source-scan proof that `deferred` is
 * NEVER stored anywhere this unit touches (it is a derived display bucket,
 * see `campaign_counters.ts`'s own header and `broadcasts.repo.ts#
 * countDeferredRecipients`), and (2) the exact `campaign.progress` payload
 * shape `progressPayloadFor` derives. No DB, no `@wp/server-kit` import -
 * root vitest project, no `WP_*` env needed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('deferred is derived and never stored', () => {
  it('deferred_is_derived_and_never_stored', () => {
    const scannedFiles = [
      'db/schema/campaign-counters.ts',
      'db/schema/enums.ts',
      'app/backend/src/modules/broadcasts/funnel.repo.ts',
      'app/backend/src/modules/broadcasts/funnel.sweep.ts',
    ];

    for (const relativePath of scannedFiles) {
      const content = readRepoFile(relativePath);
      // Excludes doc-comment prose that legitimately discusses "deferred"
      // (e.g. "NO deferred column") by asserting there is no column/enum
      // LABEL declaration and no assignment - never a bare substring ban,
      // which would also flag this file's own header prose.
      expect(content).not.toMatch(/deferred\s*[:(]\s*['"]?deferred/i);
      expect(content).not.toMatch(/['"]deferred['"]\s*,/);
      expect(content).not.toMatch(/\bdeferred\s*=\s*[^=]/);
    }

    expect(BROADCAST_RECIPIENT_STATUSES).not.toContain('deferred');
  });
});

describe('progressPayloadFor', () => {
  it('progress_payload_is_ids_and_counts_only_and_sums_the_sent_family', () => {
    const counters = {
      total: 100,
      pending: 3,
      skipped: 2,
      queued: 4,
      sent: 5,
      delivered: 2,
      read: 1,
      failed: 1,
      cancelled: 2,
      charged_minor: '75',
    };

    const payload = progressPayloadFor('11111111-1111-1111-1111-111111111111', counters);

    expect(payload).toEqual({
      campaignId: '11111111-1111-1111-1111-111111111111',
      sent: 8, // sent(5) + delivered(2) + read(1)
      queued: 7, // pending(3) + queued(4)
      failed: 1,
    });
    expect(Object.keys(payload).sort()).toEqual(['campaignId', 'failed', 'queued', 'sent']);
  });
});
