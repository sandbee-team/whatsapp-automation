import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildHarness,
  readFrames,
  signAccessToken,
  type Harness,
} from './__tests__/sse-route-test-support.js';

/**
 * sse-route-subscribe-race.test.ts (P05 FIXA MIN-2) - proves no frame
 * published to a connection's own CLIENT channel is lost in the window
 * between the stream being hijacked and `subscribeConnection` finishing its
 * (possibly slow) owned-instance-channel resolution - service.ts registers
 * the client channel synchronously via `hub.connect` before awaiting any
 * ownership lookups, so this window no longer exists for the client channel.
 */

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) {
    await harness.app.close();
    harness = undefined;
  }
  vi.restoreAllMocks();
});

describe('GET /v1/events (subscribe race)', () => {
  it('an_event_published_to_the_client_channel_between_stream_open_and_subscribe_completion_is_still_delivered', async () => {
    let releaseGate: () => void = () => undefined;
    const ownershipGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    harness = await buildHarness({ ownershipGate });
    const userA = randomUUID();
    const clientA = randomUUID();
    harness.epochByUserId.set(userA, 0);
    const token = await signAccessToken({
      userId: userA,
      sessionId: randomUUID(),
      clientId: clientA,
      role: 'owner',
      epoch: 0,
    });

    // Requesting an instance channel forces `subscribeConnection` to await
    // `isOwnedBy` (gated above) before it finishes - a real, sustained gap
    // during which the connection must ALREADY be registered on its own
    // client channel (the synchronous-register fix), not merely "eventually"
    // registered once the whole function resolves.
    const instanceId = randomUUID();
    harness.ownedInstanceIds.add(instanceId);

    const responsePromise = fetch(`${harness.baseUrl}/v1/events?instanceId=${instanceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Give the request time to reach the hijack + synchronous client-channel
    // registration before the ownership gate is released.
    for (let i = 0; i < 50 && harness.hub.connectionCount() === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(harness.hub.connectionCount()).toBe(1);

    // Publish to the CLIENT channel WHILE `subscribeConnection` is still
    // awaiting the gated ownership lookup - this must be delivered, not
    // lost, because the connection is already subscribed to its own client
    // channel at this point.
    harness.hub.publish({
      type: 'campaign.progress',
      clientId: clientA,
      campaignId: randomUUID(),
      sent: 1,
      queued: 0,
      failed: 0,
    });

    releaseGate();
    const response = await responsePromise;
    expect(response.status).toBe(200);

    const frames = await readFrames(response, 1, 2000);
    expect(frames).toHaveLength(1);
    const payload = JSON.parse(frames[0]!.data) as { type: string; sent: number };
    expect(payload.type).toBe('campaign.progress');
    expect(payload.sent).toBe(1);

    await response.body?.cancel().catch(() => {});
  });
});
