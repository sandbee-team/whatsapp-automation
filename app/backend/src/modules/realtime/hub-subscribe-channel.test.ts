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
});
