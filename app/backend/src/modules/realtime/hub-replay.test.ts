import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRealtimeHub } from './hub.js';
import { fakeSink } from './__tests__/hub-test-support.js';

/**
 * hub-replay.test.ts (P05 test-engineer hardening pass) - `replaySince`
 * boundary behaviors: replay ring eviction, the exact `replayRingSize`
 * boundary, malformed/oversized Last-Event-ID values, cross-tenant id
 * confusion, and publish-with-zero-subscribers still populating the ring.
 * Split from hub.test.ts to stay under the workspace's 300-line max-lines
 * lint rule.
 */

describe('createRealtimeHub - replay ring boundaries', () => {
  it('replay_ring_evicts_the_oldest_frame_once_it_exceeds_replayRingSize', () => {
    const hub = createRealtimeHub({ replayRingSize: 3 });
    const clientId = randomUUID();
    const channel = `client:${clientId}`;
    const sink = fakeSink();
    hub.connect({
      connectionId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [channel],
      sink: sink.sink,
    });

    for (let i = 0; i < 5; i += 1) {
      hub.publish({
        type: 'campaign.progress',
        clientId,
        campaignId: randomUUID(),
        sent: i,
        queued: 0,
        failed: 0,
      });
    }

    const firstId = sink.written[0]!.id;
    // The very first frame published has fallen out of the ring - resuming
    // from it must yield 'resync', not the replayed remainder.
    expect(hub.replaySince(channel, firstId)).toEqual({ kind: 'resync' });

    // The most recent replayRingSize (3) frames are still resumable.
    const thirdFromLastId = sink.written.at(-3)!.id;
    const result = hub.replaySince(channel, thirdFromLastId);
    expect(result.kind).toBe('frames');
    if (result.kind === 'frames') {
      expect(result.frames).toHaveLength(2);
    }
  });

  it('replay_ring_at_exactly_replayRingSize_boundary_resumes_from_the_oldest_still_present_id', () => {
    const hub = createRealtimeHub({ replayRingSize: 4 });
    const clientId = randomUUID();
    const channel = `client:${clientId}`;
    const sink = fakeSink();
    hub.connect({
      connectionId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [channel],
      sink: sink.sink,
    });

    for (let i = 0; i < 4; i += 1) {
      hub.publish({
        type: 'campaign.progress',
        clientId,
        campaignId: randomUUID(),
        sent: i,
        queued: 0,
        failed: 0,
      });
    }

    // Exactly at the ring size: the oldest id (frame #0) must still resolve.
    const oldestId = sink.written[0]!.id;
    const result = hub.replaySince(channel, oldestId);
    expect(result.kind).toBe('frames');
    if (result.kind === 'frames') {
      expect(result.frames).toHaveLength(3);
    }

    // Publishing one more frame evicts frame #0 - it now resyncs.
    hub.publish({
      type: 'campaign.progress',
      clientId,
      campaignId: randomUUID(),
      sent: 99,
      queued: 0,
      failed: 0,
    });
    expect(hub.replaySince(channel, oldestId)).toEqual({ kind: 'resync' });
  });

  it('a_huge_last_event_id_does_not_crash_and_yields_resync', () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const clientId = randomUUID();
    const channel = `client:${clientId}`;
    hub.publish({
      type: 'campaign.progress',
      clientId,
      campaignId: randomUUID(),
      sent: 1,
      queued: 0,
      failed: 0,
    });

    const hugeId = 'x'.repeat(10 * 1024);
    expect(() => hub.replaySince(channel, hugeId)).not.toThrow();
    expect(hub.replaySince(channel, hugeId)).toEqual({ kind: 'resync' });
  });

  it('a_malformed_last_event_id_on_a_channel_with_no_ring_yet_yields_resync_not_a_crash', () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    expect(() => hub.replaySince('client:never-seen', '')).not.toThrow();
    expect(hub.replaySince('client:never-seen', '')).toEqual({ kind: 'resync' });
    expect(hub.replaySince('client:never-seen', '../../etc/passwd')).toEqual({ kind: 'resync' });
  });

  it('a_last_event_id_from_a_different_tenants_channel_never_replays_foreign_frames', () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const clientA = randomUUID();
    const clientB = randomUUID();
    const channelA = `client:${clientA}`;
    const channelB = `client:${clientB}`;
    const sinkA = fakeSink();
    hub.connect({
      connectionId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId: clientA,
      epoch: 0,
      channels: [channelA],
      sink: sinkA.sink,
    });

    hub.publish({
      type: 'campaign.progress',
      clientId: clientA,
      campaignId: randomUUID(),
      sent: 1,
      queued: 0,
      failed: 0,
    });
    const clientAFrameId = sinkA.written[0]!.id;

    // clientB's channel has never had a publish - its ring does not exist.
    // Attempting to resume clientB's stream using an id minted on clientA's
    // channel must never leak clientA's ring contents.
    const result = hub.replaySince(channelB, clientAFrameId);
    expect(result).toEqual({ kind: 'resync' });
  });

  it('publish_with_zero_subscribers_still_records_the_frame_in_the_replay_ring_and_returns_without_error', () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const clientId = randomUUID();
    const channel = `client:${clientId}`;

    expect(() =>
      hub.publish({
        type: 'campaign.progress',
        clientId,
        campaignId: randomUUID(),
        sent: 1,
        queued: 0,
        failed: 0,
      }),
    ).not.toThrow();

    // A late-connecting subscriber with no Last-Event-ID gets nothing
    // replayed, but the ring itself was populated (a subsequent connect with
    // a stale-but-known id could still resume from it).
    const laterSink = fakeSink();
    hub.connect({
      connectionId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [channel],
      sink: laterSink.sink,
    });
    expect(laterSink.written).toHaveLength(0);
  });
});
