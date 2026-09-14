import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRealtimeHub, TooManyConnectionsError, type DropReason } from './hub.js';
import type { SseSink } from '../../platform/http/sse.js';
import { fakeSink } from './__tests__/hub-test-support.js';

/**
 * hub.test.ts (P05 test-engineer hardening pass) - concurrency behaviors of
 * `createRealtimeHub` not exercised by the higher-level route/authz-tick/
 * suite-B tests: publish-during-close reentrancy, dropWhere iterating over a
 * snapshot (not the live map), connect-during-publish, and per-channel
 * frame-id ordering under interleaved publishes. See hub-replay.test.ts for
 * replay-ring/Last-Event-ID boundary behavior (split to stay under the
 * workspace's 300-line max-lines lint rule).
 */

describe('createRealtimeHub - concurrency', () => {
  it('a_connection_that_closes_itself_from_inside_a_publish_write_does_not_corrupt_the_fanout', () => {
    // sink.write() for connection A synchronously triggers A's own onClose
    // (e.g. a slow-consumer detector firing mid-write) WHILE the hub is still
    // iterating other subscribers in the same publish() call.
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const clientId = randomUUID();
    const channel = `client:${clientId}`;

    const b = fakeSink();
    const aConnectionId = randomUUID();
    const closeCallbacksA: Array<(reason: DropReason) => void> = [];
    let aClosed = false;
    const aSink: SseSink = {
      write: () => {
        // Self-close reentrantly, before the hub finishes iterating.
        hub.disconnect(aConnectionId, 'slow_consumer');
      },
      comment: () => {},
      close: (reason) => {
        if (aClosed) return;
        aClosed = true;
        for (const cb of closeCallbacksA) cb(reason);
      },
      onClose: (cb) => {
        closeCallbacksA.push(cb);
      },
    };

    hub.connect({
      connectionId: aConnectionId,
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [channel],
      sink: aSink,
    });
    hub.connect({
      connectionId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [channel],
      sink: b.sink,
    });

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

    // B must still have received the frame despite A's reentrant self-close.
    expect(b.written).toHaveLength(1);
    expect(hub.connectionCount()).toBe(1);
  });

  it('dropWhere_iterates_a_snapshot_so_a_predicate_side_effect_cannot_skip_or_double_visit_connections', () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const clientId = randomUUID();
    const channel = `client:${clientId}`;
    const sinks = Array.from({ length: 5 }, () => fakeSink());
    const connectionIds = sinks.map(() => randomUUID());

    sinks.forEach((s, i) => {
      hub.connect({
        connectionId: connectionIds[i]!,
        userId: randomUUID(),
        sessionId: randomUUID(),
        clientId,
        epoch: 0,
        channels: [channel],
        sink: s.sink,
      });
    });

    let visits = 0;
    const dropped = hub.dropWhere(() => {
      visits += 1;
      return true;
    }, 'server_shutdown');

    expect(visits).toBe(5);
    expect(dropped).toBe(5);
    expect(hub.connectionCount()).toBe(0);
    for (const s of sinks) {
      expect(s.closedWith).toEqual(['server_shutdown']);
    }
  });

  it('a_connection_established_between_a_predicate_decision_and_the_drop_pass_is_not_silently_lost', () => {
    // Simulates the authz-tick's two-pass dropWhere shape: a NEW connection
    // arriving mid-tick (after the first observe-only pass ran) must still
    // be visible to hub bookkeeping and must not be dropped by a reason it
    // was never evaluated against.
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const clientId = randomUUID();
    const channel = `client:${clientId}`;
    const early = fakeSink();
    const earlyId = randomUUID();
    hub.connect({
      connectionId: earlyId,
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [channel],
      sink: early.sink,
    });

    let lateConnected = false;
    hub.dropWhere(() => {
      if (!lateConnected) {
        lateConnected = true;
        const late = fakeSink();
        hub.connect({
          connectionId: randomUUID(),
          userId: randomUUID(),
          sessionId: randomUUID(),
          clientId,
          epoch: 0,
          channels: [channel],
          sink: late.sink,
        });
      }
      return false;
    }, 'membership_revoked');

    // The late connection joined mid-iteration; it must be counted, and it
    // must NOT have been dropped by the in-flight dropWhere call above (that
    // call's snapshot was taken before the late connection existed).
    expect(hub.connectionCount()).toBe(2);
  });

  it('two_interleaved_publishes_on_the_same_channel_keep_strictly_increasing_frame_ids', () => {
    const hub = createRealtimeHub({ replayRingSize: 50 });
    const clientId = randomUUID();
    const sink = fakeSink();
    hub.connect({
      connectionId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [`client:${clientId}`],
      sink: sink.sink,
    });

    for (let i = 0; i < 20; i += 1) {
      hub.publish({
        type: 'campaign.progress',
        clientId,
        campaignId: randomUUID(),
        sent: i,
        queued: 0,
        failed: 0,
      });
    }

    const ids = sink.written.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Ids are `${bootNonce}-${seq}` - the numeric seq suffix must be strictly
    // increasing in publish order.
    const seqs = ids.map((id) => Number(id.split('-').at(-1)));
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it('a_connection_that_joins_mid_publish_burst_only_sees_frames_published_after_it_connects', () => {
    const hub = createRealtimeHub({ replayRingSize: 50 });
    const clientId = randomUUID();
    const channel = `client:${clientId}`;
    const early = fakeSink();
    hub.connect({
      connectionId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [channel],
      sink: early.sink,
    });

    hub.publish({
      type: 'campaign.progress',
      clientId,
      campaignId: randomUUID(),
      sent: 1,
      queued: 0,
      failed: 0,
    });

    const late = fakeSink();
    hub.connect({
      connectionId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [channel],
      sink: late.sink,
    });

    hub.publish({
      type: 'campaign.progress',
      clientId,
      campaignId: randomUUID(),
      sent: 2,
      queued: 0,
      failed: 0,
    });

    expect(early.written).toHaveLength(2);
    expect(late.written).toHaveLength(1);
    expect((JSON.parse(late.written[0]!.data) as { sent: number }).sent).toBe(2);
  });

  it('ten_concurrent_connects_for_one_user_without_awaiting_between_them_never_exceed_the_per_user_cap', () => {
    // MAJ-3: `assertUnderConnectionCap` alone is a check-then-act race - N
    // concurrent requests can all read the count BEFORE any of them
    // registers. The cap must be enforced atomically INSIDE `hub.connect`
    // itself (a synchronous check-and-register in one turn), so firing 10
    // connects for the SAME user with no `await` between them (the exact
    // shape a real burst of concurrent requests produces - all synchronous
    // up to this call) must still leave at most `maxConnectionsPerUser`
    // registered, with the rest refused via the same typed error
    // routes.ts already maps to 429.
    const hub = createRealtimeHub({ replayRingSize: 10, maxConnectionsPerUser: 5 });
    const userId = randomUUID();
    const clientId = randomUUID();

    let refused = 0;
    let accepted = 0;
    for (let i = 0; i < 10; i += 1) {
      const s = fakeSink();
      try {
        hub.connect({
          connectionId: randomUUID(),
          userId,
          sessionId: randomUUID(),
          clientId,
          epoch: 0,
          channels: [`client:${clientId}`],
          sink: s.sink,
        });
        accepted += 1;
      } catch (err) {
        expect(err).toBeInstanceOf(TooManyConnectionsError);
        refused += 1;
      }
    }

    expect(hub.connectionCount()).toBeLessThanOrEqual(5);
    expect(accepted).toBe(5);
    expect(refused).toBe(5);
  });
});
