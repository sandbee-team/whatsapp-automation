import { describe, expect, it } from 'vitest';
import { OUTBOX_EPHEMERAL_TOPICS } from './topics.js';

/**
 * topics.test.ts (P15 U2, step 3) - proves `OUTBOX_EPHEMERAL_TOPICS`
 * contains exactly the droppable state-hint topics and never a protected
 * topic (ADR 0010 backpressure policy: "above 50,000 depth the relay drops
 * ephemeral topics ... but never job.*, conversation.*, or
 * instance.health.*").
 */

const PROTECTED_TOPICS = [
  'message.job.status_changed',
  'chat.message_received',
  'instance.health_changed',
  'job.needs_user_action',
];

describe('OUTBOX_EPHEMERAL_TOPICS', () => {
  it('contains_exactly_instance_pacing_changed_and_campaign_progress', () => {
    expect([...OUTBOX_EPHEMERAL_TOPICS].sort()).toEqual(
      ['campaign.progress', 'instance.pacing_changed'].sort(),
    );
  });

  it('never_includes_any_protected_topic', () => {
    for (const protectedTopic of PROTECTED_TOPICS) {
      expect(OUTBOX_EPHEMERAL_TOPICS).not.toContain(protectedTopic);
    }
  });
});
