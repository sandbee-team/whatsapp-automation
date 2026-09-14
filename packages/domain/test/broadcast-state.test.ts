import { describe, expect, it } from 'vitest';
import {
  nextCampaignState,
  IllegalCampaignTransitionError,
  CLAIMABLE_CAMPAIGN_STATUSES,
  isTerminalCampaignStatus,
  type CampaignEvent,
} from '../src/broadcast/state.js';
import { BROADCAST_STATUSES, type BroadcastStatus } from '../src/enums/index.js';

/**
 * broadcast-state.test.ts (P23 Unit U2, step 3) - the ONE transition-table
 * proof for `nextCampaignState`. Every legal edge from the dispatch's table
 * gets its own test; the absorbing-states test iterates the FULL cartesian
 * product of {completed, cancelled, failed} x every `CampaignEvent` x both
 * `ctx.expansionComplete` values - no sampling, per the dispatch's explicit
 * instruction.
 */

const ALL_EVENTS: readonly CampaignEvent[] = [
  'schedule',
  'start',
  'snapshot_done',
  'expand_done',
  'pause',
  'resume',
  'cancel',
  'complete',
  'fail',
];

describe('nextCampaignState - legal edges', () => {
  it('draft_schedule_goes_to_scheduled', () => {
    expect(nextCampaignState('draft', 'schedule')).toBe('scheduled');
  });

  it('draft_start_goes_to_snapshotting', () => {
    expect(nextCampaignState('draft', 'start')).toBe('snapshotting');
  });

  it('scheduled_start_goes_to_snapshotting', () => {
    expect(nextCampaignState('scheduled', 'start')).toBe('snapshotting');
  });

  it('snapshotting_snapshot_done_goes_to_expanding', () => {
    expect(nextCampaignState('snapshotting', 'snapshot_done')).toBe('expanding');
  });

  it('expanding_expand_done_goes_to_running', () => {
    expect(nextCampaignState('expanding', 'expand_done')).toBe('running');
  });

  it('running_pause_goes_to_paused', () => {
    expect(nextCampaignState('running', 'pause')).toBe('paused');
  });

  it('expanding_pause_goes_to_paused', () => {
    expect(nextCampaignState('expanding', 'pause')).toBe('paused');
  });

  it('paused_resume_with_expansion_complete_goes_to_running', () => {
    expect(nextCampaignState('paused', 'resume', { expansionComplete: true })).toBe('running');
  });

  it('paused_resume_without_expansion_complete_goes_to_expanding', () => {
    expect(nextCampaignState('paused', 'resume', { expansionComplete: false })).toBe('expanding');
  });

  it('paused_resume_with_no_ctx_throws', () => {
    expect(() => nextCampaignState('paused', 'resume')).toThrow();
  });

  it.each(['draft', 'scheduled', 'snapshotting', 'expanding', 'running', 'paused'] as const)(
    '%s_cancel_goes_to_cancelled',
    (from) => {
      expect(nextCampaignState(from, 'cancel')).toBe('cancelled');
    },
  );

  it('running_complete_goes_to_completed', () => {
    expect(nextCampaignState('running', 'complete')).toBe('completed');
  });

  it.each(['snapshotting', 'expanding'] as const)('%s_fail_goes_to_failed', (from) => {
    expect(nextCampaignState(from, 'fail')).toBe('failed');
  });
});

describe('nextCampaignState - illegal edges throw', () => {
  it('an_undeclared_pair_throws_illegal_campaign_transition_error', () => {
    expect(() => nextCampaignState('draft', 'pause')).toThrow(IllegalCampaignTransitionError);
  });

  it('the_thrown_error_carries_the_from_state_and_event', () => {
    try {
      nextCampaignState('draft', 'expand_done');
      throw new Error('expected nextCampaignState to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalCampaignTransitionError);
      const illegal = error as IllegalCampaignTransitionError;
      expect(illegal.from).toBe('draft');
      expect(illegal.event).toBe('expand_done');
    }
  });
});

describe('cancelled_and_completed_are_absorbing_states', () => {
  const ABSORBING: readonly BroadcastStatus[] = ['completed', 'cancelled', 'failed'];
  const CTX_VARIANTS: readonly ({ expansionComplete?: boolean } | undefined)[] = [
    undefined,
    { expansionComplete: true },
    { expansionComplete: false },
  ];

  for (const status of ABSORBING) {
    for (const event of ALL_EVENTS) {
      for (const ctx of CTX_VARIANTS) {
        it(`${status}_${event}_${ctx === undefined ? 'no_ctx' : String(ctx.expansionComplete)}_throws`, () => {
          expect(() => nextCampaignState(status, event, ctx)).toThrow(
            IllegalCampaignTransitionError,
          );
        });
      }
    }
  }
});

describe('CLAIMABLE_CAMPAIGN_STATUSES', () => {
  it('mirrors_the_claim_allow_list_exactly', () => {
    expect(CLAIMABLE_CAMPAIGN_STATUSES).toEqual(['running', 'expanding']);
  });
});

describe('isTerminalCampaignStatus', () => {
  it.each(['completed', 'cancelled', 'failed'] as const)('%s_is_terminal', (status) => {
    expect(isTerminalCampaignStatus(status)).toBe(true);
  });

  it.each(['draft', 'scheduled', 'snapshotting', 'expanding', 'running', 'paused'] as const)(
    '%s_is_not_terminal',
    (status) => {
      expect(isTerminalCampaignStatus(status)).toBe(false);
    },
  );
});

describe('every BroadcastStatus is reachable via a legal edge', () => {
  it('all_statuses_appear_as_a_destination_of_some_legal_transition_except_draft', () => {
    // 'draft' is the initial state, never a destination - every other status
    // must be reachable as SOME event's destination from the table above.
    const reachable = new Set<BroadcastStatus>();
    reachable.add(nextCampaignState('draft', 'schedule'));
    reachable.add(nextCampaignState('draft', 'start'));
    reachable.add(nextCampaignState('snapshotting', 'snapshot_done'));
    reachable.add(nextCampaignState('expanding', 'expand_done'));
    reachable.add(nextCampaignState('running', 'pause'));
    reachable.add(nextCampaignState('paused', 'resume', { expansionComplete: true }));
    reachable.add(nextCampaignState('paused', 'resume', { expansionComplete: false }));
    reachable.add(nextCampaignState('draft', 'cancel'));
    reachable.add(nextCampaignState('running', 'complete'));
    reachable.add(nextCampaignState('snapshotting', 'fail'));

    for (const status of BROADCAST_STATUSES) {
      if (status === 'draft') continue;
      expect(reachable.has(status)).toBe(true);
    }
  });
});
