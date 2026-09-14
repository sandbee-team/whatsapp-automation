import { describe, expect, it } from 'vitest';
import { coalesceOutboxRows, type OutboxRow } from './coalescer.js';

/**
 * coalescer.test.ts (P15 U4, step 5) - pure unit coverage of the newest-wins
 * grouping core. Real-DB claim/publish/mark behaviour is proven by
 * `roles/relay.integration.test.ts` instead (this module has no I/O).
 */

const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_A = '22222222-2222-4222-8222-222222222222';

function jobRow(id: string, jobPublicId: string): OutboxRow {
  return {
    id,
    clientId: CLIENT_A,
    instanceId: INSTANCE_A,
    coalesceKey: `instance:${INSTANCE_A}:jobs`,
    event: {
      type: 'message.job.status_changed',
      jobPublicId,
      instanceId: INSTANCE_A,
      status: 'sent',
    },
  };
}

describe('coalesceOutboxRows', () => {
  it('the_last_frame_carries_the_newest_state_for_every_coalesce_key', () => {
    const rows = [jobRow('1', 'job_a'), jobRow('2', 'job_a'), jobRow('3', 'job_a')];

    const [group] = coalesceOutboxRows(rows);

    expect(group?.frame.events).toHaveLength(1);
    expect(group?.frame.events[0]).toEqual(rows[2]?.event);
    expect(group?.winnerIds).toEqual(['3']);
    expect(group?.suppressedIds).toEqual([
      ['1', '3'],
      ['2', '3'],
    ]);
  });

  it('groups_by_client_then_instance_then_coalesce_key', () => {
    const otherInstance = '33333333-3333-4333-8333-333333333333';
    const rowsSameClientDifferentInstance: OutboxRow[] = [
      jobRow('1', 'job_a'),
      {
        ...jobRow('2', 'job_b'),
        instanceId: otherInstance,
        coalesceKey: `instance:${otherInstance}:jobs`,
      },
    ];

    const groups = coalesceOutboxRows(rowsSameClientDifferentInstance);

    expect(groups).toHaveLength(2);
  });

  it('more_than_25_keys_in_one_group_sets_truncated_and_keeps_the_25_newest', () => {
    const rows: OutboxRow[] = [];
    for (let i = 1; i <= 30; i += 1) {
      rows.push({
        id: String(i),
        clientId: CLIENT_A,
        instanceId: INSTANCE_A,
        coalesceKey: `chat:${i}`,
        event: {
          type: 'campaign.progress',
          campaignId: '44444444-4444-4444-8444-444444444444',
          sent: i,
          queued: 0,
          failed: 0,
        },
      });
    }

    const [group] = coalesceOutboxRows(rows);

    expect(group?.frame.truncated).toBe(true);
    expect(group?.frame.events).toHaveLength(25);
    // Every winner (all 30 - one per key, none suppressed) is still marked
    // published, even the 5 that missed the frame.
    expect(group?.winnerIds).toHaveLength(30);
    expect(group?.suppressedIds).toHaveLength(0);
    // The 25 newest ids (6..30) are the ones that made the frame.
    const framedSent = group?.frame.events.map((event) =>
      event.type === 'campaign.progress' ? event.sent : -1,
    );
    expect(framedSent).toEqual(Array.from({ length: 25 }, (_, i) => i + 6));
  });

  it('zero_rows_yields_zero_groups', () => {
    expect(coalesceOutboxRows([])).toEqual([]);
  });
});
