import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { instanceKeys } from '../features/instances/keys.js';
import { dashboardKeys } from '../features/dashboard/keys.js';
import { jobKeys } from '../features/jobs/keys.js';

/**
 * lib/sse-batch.test.ts (P15 U6, step 9) - proves the `batch` frame path
 * split out of `sse.ts`'s `sse-stream-consumer.ts`: dedupes the query-key
 * set across every named event before invalidating (never a per-event
 * storm), and `truncated: true` additionally triggers one full resync.
 * Split into its own file (rather than growing `sse.test.ts`) to stay under
 * the workspace's 300-line max-lines rule; same harness idiom as
 * `sse.test.ts` - a real `ReadableStream`-backed `fetch` mock.
 */

function sseStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

function frame(id: string, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('lib/sse.ts batch frame', () => {
  let sse: typeof import('./sse.js');
  let setAccessToken: typeof import('./api-client.js').setAccessToken;

  beforeEach(async () => {
    vi.resetModules();
    const apiClient = await import('./api-client.js');
    setAccessToken = apiClient.setAccessToken;
    sse = await import('./sse.js');
    setAccessToken('test-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setAccessToken(null);
  });

  it('a_batch_frame_invalidates_every_key_it_names_exactly_once', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const jobPublicId = 'job-1';
    const batch = {
      v: 1,
      truncated: false,
      events: [
        {
          type: 'instance.health_changed',
          instanceId,
          healthState: 'connected',
          pauseReason: null,
          needsUserAction: false,
        },
        // Maps to the same dashboardKeys.summary() key as above - dedupe check.
        {
          type: 'message.job.status_changed',
          jobPublicId,
          instanceId,
          status: 'sent',
        },
      ],
    };
    const stream = sseStreamFromChunks([frame('1', 'batch', batch)]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const handle = sse.acquireRealtimeConnection({ queryClient });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalled();
    });

    const calledKeys = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey: unknown }).queryKey,
    );
    // dashboardKeys.summary() must appear exactly once, deduped across both events.
    expect(calledKeys).toContainEqual(instanceKeys.detail(instanceId));
    expect(calledKeys).toContainEqual(instanceKeys.card(instanceId));
    expect(calledKeys).toContainEqual(jobKeys.detail(jobPublicId));
    expect(calledKeys).toContainEqual(jobKeys.list(instanceId));
    expect(calledKeys).toContainEqual(dashboardKeys.summary());
    expect(calledKeys).toHaveLength(5);

    handle.release();
  });

  it('a_truncated_batch_triggers_one_full_instance_refetch', async () => {
    const batch = { v: 1, truncated: true, events: [] };
    const stream = sseStreamFromChunks([frame('1', 'batch', batch)]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const handle = sse.acquireRealtimeConnection({ queryClient });

    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith();
    });
    // One no-filter call - never a per-event storm, even with an empty list.
    const fullRefetchCalls = invalidateSpy.mock.calls.filter((call) => call.length === 0);
    expect(fullRefetchCalls).toHaveLength(1);

    handle.release();
  });
});
