import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildHarness,
  readFrames,
  signAccessToken,
  type Harness,
} from './__tests__/sse-route-test-support.js';

/**
 * sse-route.test.ts (P05 Unit U3a) - `GET /v1/events`: authentication,
 * tenant-isolation (client_id is locked from the session, never a query
 * parameter or another tenant's channel), and `Last-Event-ID` resume. See
 * sse-route-resilience.test.ts for heartbeat/slow-consumer/connection-cap/
 * publish-validation.
 */

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) {
    await harness.app.close();
    harness = undefined;
  }
  vi.restoreAllMocks();
});

describe('GET /v1/events', () => {
  it('an_unauthenticated_request_to_v1_events_is_401', async () => {
    harness = await buildHarness();
    const response = await fetch(`${harness.baseUrl}/v1/events`);

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    expect(harness.hub.connectionCount()).toBe(0);
  });

  it('a_client_id_query_parameter_is_ignored', async () => {
    harness = await buildHarness();
    const clientA = randomUUID();
    const clientB = randomUUID();
    const userA = randomUUID();
    harness.epochByUserId.set(userA, 0);
    const tokenA = await signAccessToken({
      userId: userA,
      sessionId: randomUUID(),
      clientId: clientA,
      role: 'owner',
      epoch: 0,
    });

    const response = await fetch(`${harness.baseUrl}/v1/events?clientId=${clientB}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(response.status).toBe(200);

    // Wait until the hub has actually registered the connection.
    for (let i = 0; i < 50 && harness.hub.connectionCount() === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    harness.hub.publish({
      type: 'campaign.progress',
      clientId: clientB,
      campaignId: randomUUID(),
      sent: 1,
      queued: 0,
      failed: 0,
    });
    harness.hub.publish({
      type: 'campaign.progress',
      clientId: clientA,
      campaignId: randomUUID(),
      sent: 2,
      queued: 0,
      failed: 0,
    });

    const frames = await readFrames(response, 1, 1000);
    expect(frames).toHaveLength(1);
    const parsed = JSON.parse(frames[0]!.data) as { type: string; sent: number };
    expect(parsed.type).toBe('campaign.progress');
    expect(parsed.sent).toBe(2);
  });

  it('a_user_cannot_subscribe_to_another_clients_instance_channel', async () => {
    harness = await buildHarness();
    const clientA = randomUUID();
    const clientB = randomUUID();
    const instanceX = randomUUID();
    const userA = randomUUID();
    harness.epochByUserId.set(userA, 0);
    const tokenA = await signAccessToken({
      userId: userA,
      sessionId: randomUUID(),
      clientId: clientA,
      role: 'owner',
      epoch: 0,
    });

    const response = await fetch(`${harness.baseUrl}/v1/events?instanceId=${instanceX}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(response.status).toBe(200);

    for (let i = 0; i < 50 && harness.refusalCount === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(harness.refusalCount).toBe(1);

    harness.hub.publish({
      type: 'instance.pacing_changed',
      clientId: clientB,
      instanceId: instanceX,
      band: 'HIGH',
      tier: 1,
      effDailyCap: 100,
      configVersion: 1,
    });
    harness.hub.publish({
      type: 'campaign.progress',
      clientId: clientA,
      campaignId: randomUUID(),
      sent: 1,
      queued: 0,
      failed: 0,
    });

    const frames = await readFrames(response, 1, 1000);
    expect(frames).toHaveLength(1);
    const parsed = JSON.parse(frames[0]!.data) as { type: string };
    expect(parsed.type).toBe('campaign.progress');
  });

  it('a_reconnect_with_a_known_last_event_id_replays_only_the_missed_frames', async () => {
    harness = await buildHarness();
    const clientA = randomUUID();
    const userA = randomUUID();
    harness.epochByUserId.set(userA, 0);
    const token = await signAccessToken({
      userId: userA,
      sessionId: randomUUID(),
      clientId: clientA,
      role: 'owner',
      epoch: 0,
    });

    const first = await fetch(`${harness.baseUrl}/v1/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(first.status).toBe(200);
    for (let i = 0; i < 50 && harness.hub.connectionCount() === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const publishOne = (n: number): void => {
      harness!.hub.publish({
        type: 'campaign.progress',
        clientId: clientA,
        campaignId: randomUUID(),
        sent: n,
        queued: 0,
        failed: 0,
      });
    };
    publishOne(1);
    publishOne(2);
    publishOne(3);

    const firstFrames = await readFrames(first, 3, 1000);
    expect(firstFrames).toHaveLength(3);
    await first.body?.cancel().catch(() => {});

    const lastSeenId = firstFrames[1]!.id!;

    publishOne(4);
    publishOne(5);

    const resumed = await fetch(`${harness.baseUrl}/v1/events`, {
      headers: { Authorization: `Bearer ${token}`, 'Last-Event-ID': lastSeenId },
    });
    expect(resumed.status).toBe(200);

    const resumedFrames = await readFrames(resumed, 3, 1000);
    const values = resumedFrames.map((f) => (JSON.parse(f.data) as { sent: number }).sent);
    // lastSeenId = frame #2's id, so the replay must start strictly after
    // it: #3, then the two newly-published #4 and #5.
    expect(values).toEqual([3, 4, 5]);
  });

  it('a_last_event_id_minted_on_another_tenants_stream_never_replays_that_tenants_frames', async () => {
    harness = await buildHarness();
    const clientA = randomUUID();
    const clientB = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();
    harness.epochByUserId.set(userA, 0);
    harness.epochByUserId.set(userB, 0);
    const tokenA = await signAccessToken({
      userId: userA,
      sessionId: randomUUID(),
      clientId: clientA,
      role: 'owner',
      epoch: 0,
    });
    const tokenB = await signAccessToken({
      userId: userB,
      sessionId: randomUUID(),
      clientId: clientB,
      role: 'owner',
      epoch: 0,
    });

    // clientB connects and receives a real frame id from ITS OWN channel.
    const bResponse = await fetch(`${harness.baseUrl}/v1/events`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(bResponse.status).toBe(200);
    for (let i = 0; i < 50 && harness.hub.connectionCount() === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    harness.hub.publish({
      type: 'campaign.progress',
      clientId: clientB,
      campaignId: randomUUID(),
      sent: 1,
      queued: 0,
      failed: 0,
    });
    const bFrames = await readFrames(bResponse, 1, 1000);
    expect(bFrames).toHaveLength(1);
    const foreignFrameId = bFrames[0]!.id!;
    await bResponse.body?.cancel().catch(() => {});

    // clientA reconnects using clientB's frame id as its own Last-Event-ID.
    // Even though the id string exists in SOME ring, it must never resolve
    // against clientA's own channel - only a resync is acceptable.
    const aResumed = await fetch(`${harness.baseUrl}/v1/events`, {
      headers: { Authorization: `Bearer ${tokenA}`, 'Last-Event-ID': foreignFrameId },
    });
    expect(aResumed.status).toBe(200);

    harness.hub.publish({
      type: 'campaign.progress',
      clientId: clientA,
      campaignId: randomUUID(),
      sent: 42,
      queued: 0,
      failed: 0,
    });

    const aFrames = await readFrames(aResumed, 1, 1000);
    // Either a resync frame, or (if some replay happened) it must be strictly
    // clientA's own data - never clientB's `sent: 1` payload.
    for (const frame of aFrames) {
      if (frame.event !== 'resync') {
        const parsed = JSON.parse(frame.data) as { sent: number };
        expect(parsed.sent).not.toBe(1);
      }
    }
  });

  it('an_unknown_last_event_id_yields_one_resync_frame', async () => {
    harness = await buildHarness();
    const clientA = randomUUID();
    const userA = randomUUID();
    harness.epochByUserId.set(userA, 0);
    const token = await signAccessToken({
      userId: userA,
      sessionId: randomUUID(),
      clientId: clientA,
      role: 'owner',
      epoch: 0,
    });

    const response = await fetch(`${harness.baseUrl}/v1/events`, {
      headers: { Authorization: `Bearer ${token}`, 'Last-Event-ID': 'totally-unknown-id' },
    });
    expect(response.status).toBe(200);

    const frames = await readFrames(response, 1, 1000);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe('resync');
  });
});
