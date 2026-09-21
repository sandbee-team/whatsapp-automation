import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRealtimeHub } from './hub.js';
import { fakeSink } from './__tests__/hub-test-support.js';

/**
 * hub-subscribe-channel.test.ts (P05 FIXA MIN-2) - `RealtimeHub.subscribeChannel`,
 * the seam that lets a caller register a connection's OWN client channel
 * synchronously via `connect` and add owned-instance channels afterwards, as
 * their (awaited) ownership lookups resolve - without losing any frame
 * published to the client channel in between (service.ts's fix for the
 * "frames lost between hijack and hub.connect" finding).
 */

describe('createRealtimeHub - subscribeChannel', () => {
  it('subscribeChannel_adds_a_new_channel_to_an_already_connected_connection_and_it_receives_subsequent_publishes', () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const clientId = randomUUID();
    const instanceId = randomUUID();
    const connectionId = randomUUID();
    const sink = fakeSink();

    hub.connect({
      connectionId,
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [`client:${clientId}`],
      sink: sink.sink,
    });

    // Not yet subscribed to the instance channel - a publish there is not
    // delivered.
    hub.publish({
      type: 'instance.pacing_changed',
      clientId,
      instanceId,
      band: 'HIGH',
      tier: 1,
      effDailyCap: 100,
      configVersion: 1,
    });
    expect(sink.written).toHaveLength(0);

    hub.subscribeChannel(connectionId, `client:${clientId}:instance:${instanceId}`);

    hub.publish({
      type: 'instance.pacing_changed',
      clientId,
      instanceId,
      band: 'HIGH',
      tier: 2,
      effDailyCap: 100,
      configVersion: 1,
    });
    expect(sink.written).toHaveLength(1);
  });

  it('subscribeChannel_on_an_unknown_connectionId_is_a_no_op_not_a_throw', () => {
    // The connection may have already disconnected between hijack and the
    // ownership lookup resolving (client navigated away mid-request) -
    // adding a channel for a connection that no longer exists must be inert,
    // never a crash in the ownership-resolution callback chain.
    const hub = createRealtimeHub({ replayRingSize: 10 });
    expect(() => hub.subscribeChannel(randomUUID(), 'client:whatever')).not.toThrow();
  });

  /**
   * Regression test for the 2026-09-15/16 live incident ("QR never reaches
   * the browser"): `instance.qr` always carries `instanceId`
   * (packages/contracts/src/app/realtime.ts, `z.uuid()`, required), so
   * `hub.publish` (hub.ts:214-217) ALWAYS routes it to the instance channel,
   * never the client channel - a connection subscribed client-wide only
   * (exactly what the browser's always-on `sse.ts` stream did before this
   * fix - no query string, ever) never receives it, and the pre-fix
   * `publish` returned silently (hub.ts's `if (!subscribers) return`), with
   * no observable signal. This test proves both halves: (1) the bug
   * scenario - client-wide-only really does miss the frame, and firing the
   * new `onPublishNoSubscribers` hook is how that miss becomes visible - and
   * (2) the fix shape - a connection that ALSO subscribes the instance
   * channel the way `service.ts#subscribeConnection` does (client channel at
   * `connect`, instance channel via a later `subscribeChannel` call, mirroring
   * the real panel opening a second, instance-scoped connection per
   * `sse-instance-stream.ts`) receives it correctly.
   */
  it('an_instance_qr_event_is_silently_missed_by_a_client_wide_only_subscriber_but_reaches_one_also_subscribed_to_the_instance_channel', () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const clientId = randomUUID();
    const instanceId = randomUUID();

    let noSubscriberSignals = 0;
    hub.onPublishNoSubscribers(() => {
      noSubscriberSignals += 1;
    });

    // Connection A: client-wide only - exactly what the browser's one
    // always-on stream subscribed to before this fix (no `?instanceId=`
    // query string was ever sent).
    const clientWideOnlyId = randomUUID();
    const clientWideOnlySink = fakeSink();
    hub.connect({
      connectionId: clientWideOnlyId,
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [`client:${clientId}`],
      sink: clientWideOnlySink.sink,
    });

    hub.publish({
      type: 'instance.qr',
      clientId,
      instanceId,
      payload: 'bearer-qr-payload',
      expiresAt: new Date().toISOString(),
      attemptsLeft: 5,
    });

    // The bug, reproduced: a client-wide-only subscriber never sees an
    // instance-scoped event, and it happens with NO visible signal unless
    // `onPublishNoSubscribers` is wired (this test's own assertion of it).
    expect(clientWideOnlySink.written).toHaveLength(0);
    expect(noSubscriberSignals).toBe(1);

    // Connection B: subscribed the way the REAL panel now does post-fix -
    // its own client channel at `connect`, plus the instance channel added
    // via `subscribeChannel` (the same two-phase shape `service.ts`'s
    // MIN-2 fix uses server-side; client-side, `sse-instance-stream.ts`
    // opens a second connection whose `connect` call already includes both
    // channels up front, which this test also covers by asserting the
    // channel-name shape itself, not just the two-phase server path).
    const subscribedConnectionId = randomUUID();
    const subscribedSink = fakeSink();
    hub.connect({
      connectionId: subscribedConnectionId,
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [`client:${clientId}`],
      sink: subscribedSink.sink,
    });
    hub.subscribeChannel(subscribedConnectionId, `client:${clientId}:instance:${instanceId}`);

    hub.publish({
      type: 'instance.qr',
      clientId,
      instanceId,
      payload: 'bearer-qr-payload-2',
      expiresAt: new Date().toISOString(),
      attemptsLeft: 4,
    });

    expect(subscribedSink.written).toHaveLength(1);
    // The still-client-wide-only connection A must still receive nothing for
    // this instance-scoped event - proving the fix does not become an
    // accidental fan-out-to-everyone (that would be Option B, rejected: see
    // this phase's ownership-port design - a client can have instances a
    // given connection/session must not receive events for).
    expect(clientWideOnlySink.written).toHaveLength(0);
    // No-subscriber signal must not have fired again for the SECOND publish
    // (it now has a real subscriber) - the counter tracks misses, not every
    // publish call.
    expect(noSubscriberSignals).toBe(1);
  });

  /**
   * Regression test for the 2026-09-17 "first QR always lost" incident
   * (operator report: "first time 5 scans left me kuch nahi aata, uske bad
   * 4 scans left me qr aata hai"). Root cause: Baileys fires its first `qr`
   * almost immediately once the socket opens, but the browser's
   * instance-scoped SSE connection (`sse-instance-stream.ts`) has not
   * finished its fetch handshake yet, so `hub.subscribeChannel` runs AFTER
   * `hub.publish` already ran once with zero subscribers. The publish still
   * landed in the replay ring (`hub-replay-ring.ts`'s `pushToRing` runs
   * before the subscriber check), but nothing used to drain it for a
   * connection with no prior frame to resume from (`replaySince` only runs
   * from a `Last-Event-ID` header a first-time connection can never send).
   * `subscribeChannel` now replays that ring unconditionally - this test
   * proves the frame the connection missed while subscribing now arrives
   * the moment `subscribeChannel` runs, with no client-side timing change.
   */
  it('a_connection_that_subscribes_after_a_qr_was_published_still_receives_that_qr', () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const clientId = randomUUID();
    const instanceId = randomUUID();
    const instanceChannel = `client:${clientId}:instance:${instanceId}`;

    // The worker's `pairing.ts` publishes the first QR before any browser
    // connection has reached `subscribeChannel` for this instance - exactly
    // the race this fix closes.
    hub.publish({
      type: 'instance.qr',
      clientId,
      instanceId,
      payload: 'first-qr-payload',
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
      attemptsLeft: 5,
    });

    const connectionId = randomUUID();
    const sink = fakeSink();
    hub.connect({
      connectionId,
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [`client:${clientId}`],
      sink: sink.sink,
    });

    // The browser's second, instance-scoped connection reaches this call
    // only once its own fetch handshake resolves - moments after the QR
    // above was already published into the (now subscriber-less) ring.
    hub.subscribeChannel(connectionId, instanceChannel);

    expect(sink.written).toHaveLength(1);
    expect(JSON.parse(sink.written[0]!.data)).toMatchObject({
      type: 'instance.qr',
      payload: 'first-qr-payload',
    });
  });

  it('an_already_expired_qr_in_the_ring_is_never_replayed_on_subscribe', () => {
    // Bound tightly (per this fix's own safety requirement): a QR is a
    // bearer credential, and a stale one must not be handed to a late
    // subscriber as if it were still live - `QrPanel.tsx`'s own `isExpired`
    // path is what a live (non-replayed) expired QR renders as; a replay
    // must never bypass that by resurrecting a dead credential.
    const hub = createRealtimeHub({ replayRingSize: 10, now: () => 1_000_000 });
    const clientId = randomUUID();
    const instanceId = randomUUID();
    const instanceChannel = `client:${clientId}:instance:${instanceId}`;

    hub.publish({
      type: 'instance.qr',
      clientId,
      instanceId,
      payload: 'stale-qr-payload',
      expiresAt: new Date(999_000).toISOString(), // already in the past vs `now`
      attemptsLeft: 5,
    });

    const connectionId = randomUUID();
    const sink = fakeSink();
    hub.connect({
      connectionId,
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [`client:${clientId}`],
      sink: sink.sink,
    });
    hub.subscribeChannel(connectionId, instanceChannel);

    expect(sink.written).toHaveLength(0);
  });
});
