// isolation suite B - SSE hub as a background path.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { realtimeEventSchema } from '@wp/contracts';
import { createRealtimeHub } from '../hub.js';

/**
 * suite-b-sse.test.ts (P05 Unit U3b) - two tenants streaming concurrently
 * NEVER receive each other's events, proven at the hub level (tenant
 * isolation core invariant 4) with a large interleaved publish volume. Every
 * frame each sink DID receive is validated against `realtimeEventSchema`
 * and routed to a channel matching that sink's own tenant - and an event
 * published for a clientId that owns NO connections reaches nobody.
 */

interface CapturedFrame {
  event: string;
  data: string;
}

function connectCapturingSink(
  hub: ReturnType<typeof createRealtimeHub>,
  input: { connectionId: string; userId: string; clientId: string },
): CapturedFrame[] {
  const frames: CapturedFrame[] = [];
  hub.connect({
    connectionId: input.connectionId,
    userId: input.userId,
    sessionId: randomUUID(),
    clientId: input.clientId,
    epoch: 0,
    channels: [`client:${input.clientId}`],
    sink: {
      write: (frame) => {
        frames.push({ event: frame.event, data: frame.data });
      },
      comment: () => {},
      close: () => {},
      onClose: () => {},
    },
  });
  return frames;
}

describe('isolation suite B - SSE hub as a background path', () => {
  it('two_tenants_streaming_at_once_never_receive_each_others_events', () => {
    const hub = createRealtimeHub({ replayRingSize: 200 });

    const clientA = randomUUID();
    const clientB = randomUUID();
    const clientNeither = randomUUID();

    const framesA = Array.from({ length: 5 }, () =>
      connectCapturingSink(hub, {
        connectionId: randomUUID(),
        userId: randomUUID(),
        clientId: clientA,
      }),
    );
    const framesB = Array.from({ length: 5 }, () =>
      connectCapturingSink(hub, {
        connectionId: randomUUID(),
        userId: randomUUID(),
        clientId: clientB,
      }),
    );

    // 50 interleaved events: alternating A/B, plus a handful for
    // clientNeither (a clientId owning zero connections).
    for (let i = 0; i < 50; i += 1) {
      const clientId = i % 2 === 0 ? clientA : clientB;
      hub.publish({
        type: 'campaign.progress',
        clientId,
        campaignId: randomUUID(),
        sent: i,
        queued: 0,
        failed: 0,
      });
    }
    hub.publish({
      type: 'campaign.progress',
      clientId: clientNeither,
      campaignId: randomUUID(),
      sent: 999,
      queued: 0,
      failed: 0,
    });

    // Every A sink got exactly the 25 A-tagged events, every B sink got
    // exactly the 25 B-tagged events, and every frame parses + belongs to
    // the right channel.
    for (const frames of framesA) {
      expect(frames).toHaveLength(25);
      for (const frame of frames) {
        const parsed = realtimeEventSchema.parse(JSON.parse(frame.data));
        expect(parsed.type).toBe('campaign.progress');
      }
    }
    for (const frames of framesB) {
      expect(frames).toHaveLength(25);
      for (const frame of frames) {
        const parsed = realtimeEventSchema.parse(JSON.parse(frame.data));
        expect(parsed.type).toBe('campaign.progress');
      }
    }

    // Zero cross-delivery: no A sink ever saw a `sent` value from the B
    // sequence and vice versa (odd indices are B's, even indices are A's).
    const sentValuesOf = (frames: CapturedFrame[]): number[] =>
      frames.map((f) => (JSON.parse(f.data) as { sent: number }).sent);
    for (const frames of framesA) {
      expect(sentValuesOf(frames).every((v) => v % 2 === 0)).toBe(true);
    }
    for (const frames of framesB) {
      expect(sentValuesOf(frames).every((v) => v % 2 === 1)).toBe(true);
    }

    // clientNeither owned no connections - nobody received sent:999.
    const allFrames = [...framesA, ...framesB].flat();
    expect(allFrames.some((f) => (JSON.parse(f.data) as { sent: number }).sent === 999)).toBe(
      false,
    );

    expect(hub.connectionCount()).toBe(10);
  });
});
