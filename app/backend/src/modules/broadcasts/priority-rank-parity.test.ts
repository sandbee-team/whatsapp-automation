import { describe, expect, it } from 'vitest';
import type { JobPriority } from '@wp/domain';
import { priorityRankFor as broadcastsPriorityRankFor } from './expansion.repo.js';
import { priorityRankFor as messagesPriorityRankFor } from '../messages/messages.repo.js';

/**
 * priority-rank-parity.test.ts (P23 C1 fix round, unit F2, item 3) - unit
 * test proving `expansion.repo.ts`'s `PRIORITY_TO_BAND`/`priorityRankFor`
 * duplicate (a depcruise workaround - see that file's own doc comment) never
 * silently drifts from `modules/messages/messages.repo.ts`'s own mapping,
 * over EVERY `JobPriority` value.
 */

const ALL_PRIORITIES: readonly JobPriority[] = ['high', 'normal', 'low'];

describe('priority-rank-parity (P23 C1 fix round, item 3)', () => {
  it.each(ALL_PRIORITIES)(
    'broadcasts_priority_rank_matches_messages_priority_rank_for_%s',
    (priority) => {
      expect(broadcastsPriorityRankFor(priority)).toBe(messagesPriorityRankFor(priority));
    },
  );
});
