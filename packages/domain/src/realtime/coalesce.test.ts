import { describe, expect, it } from 'vitest';
import { coalesceKeyFor } from './coalesce.js';

/**
 * coalesce.test.ts (P15 U2, step 3) - proves each named event family maps
 * to its documented coalesce-key shape, and that an unrecognised type is
 * rejected loudly rather than silently folded under a wrong key.
 */

describe('coalesceKeyFor', () => {
  it('instance_health_changed_maps_to_the_instance_state_key', () => {
    expect(
      coalesceKeyFor({ type: 'instance.health_changed', instanceId: 'inst-1', entityId: 'inst-1' }),
    ).toBe('instance:inst-1:state');
  });

  it('instance_pacing_changed_maps_to_the_instance_state_key', () => {
    expect(
      coalesceKeyFor({ type: 'instance.pacing_changed', instanceId: 'inst-1', entityId: 'inst-1' }),
    ).toBe('instance:inst-1:state');
  });

  it('message_job_status_changed_maps_to_the_instance_jobs_key', () => {
    expect(
      coalesceKeyFor({
        type: 'message.job.status_changed',
        instanceId: 'inst-1',
        entityId: 'job-1',
      }),
    ).toBe('instance:inst-1:jobs');
  });

  it('a_chat_event_maps_to_the_chat_key_using_entityId', () => {
    expect(coalesceKeyFor({ type: 'chat.message_received', entityId: 'chat-1' })).toBe(
      'chat:chat-1',
    );
  });

  it('campaign_progress_maps_to_the_campaign_progress_key_using_entityId', () => {
    expect(coalesceKeyFor({ type: 'campaign.progress', entityId: 'camp-1' })).toBe(
      'campaign:camp-1:progress',
    );
  });

  it('notification_created_coalesces_uniquely_per_notification_id', () => {
    // P17 Unit U2 - unique per notification: retries of the SAME row
    // coalesce (identical entityId -> identical key), but two distinct
    // notifications never fold into each other (different entityId ->
    // different key).
    const keyOnce = coalesceKeyFor({ type: 'notification.created', entityId: 'notif-1' });
    const keyRetry = coalesceKeyFor({ type: 'notification.created', entityId: 'notif-1' });
    expect(keyRetry).toBe(keyOnce);

    const keyOther = coalesceKeyFor({ type: 'notification.created', entityId: 'notif-2' });
    expect(keyOther).not.toBe(keyOnce);
  });

  it('throws_when_instance_id_is_missing_for_an_instance_scoped_type', () => {
    expect(() => coalesceKeyFor({ type: 'instance.health_changed', entityId: 'inst-1' })).toThrow();
  });

  it('throws_for_an_unrecognised_event_type', () => {
    expect(() => coalesceKeyFor({ type: 'something.unknown', entityId: 'x' })).toThrow();
  });
});
