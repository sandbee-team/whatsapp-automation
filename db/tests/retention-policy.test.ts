import { describe, expect, it } from 'vitest';
import { RETENTION_POLICIES } from '../src/retention.js';

/**
 * P23 (broadcast-campaigns) Unit U1 - proves the retention registry carries
 * exactly the one `campaign_recipients` policy the scope delta decided
 * ("Bound and retention, decided"), and that the registry array itself is
 * frozen (a later phase must never mutate this list in place - any new
 * policy is a new array literal in `db/src/retention.ts`, reviewed there).
 */
describe('retention_policy', () => {
  it('campaign_recipients_is_registered_as_a_13_month_archive_then_delete_policy', () => {
    const entry = RETENTION_POLICIES.find((policy) => policy.table === 'campaign_recipients');

    expect(entry).toBeDefined();
    expect(entry?.retainMonths).toBe(13);
    expect(entry?.action).toBe('archive_then_delete');
    expect(entry?.archiveWith).toBe('campaigns');
    expect(entry?.deleteMode).toBe('rate_limited_batches');
    expect(entry?.scheduledBy).toBe('P25');
  });

  it('the_registry_array_is_frozen', () => {
    expect(Object.isFrozen(RETENTION_POLICIES)).toBe(true);
    expect(() => {
      (RETENTION_POLICIES as RetentionPolicyArray).push({
        table: 'x',
        archiveWith: 'y',
        retainMonths: 1,
        action: 'archive_then_delete',
        deleteMode: 'rate_limited_batches',
        scheduledBy: 'nobody',
      });
    }).toThrow();
  });
});

// Local widened type purely so the frozen-push proof above can attempt the
// mutation without TypeScript rejecting it at compile time - `push` on a
// readonly array is a type error, but the runtime freeze is what this test
// actually proves.
type RetentionPolicyArray = Array<(typeof RETENTION_POLICIES)[number]>;
