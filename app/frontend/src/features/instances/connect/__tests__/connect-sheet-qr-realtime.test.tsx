// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { setAccessToken } from '../../../../lib/api-client.js';
import {
  createInstanceAndChooseQr,
  INSTANCE_ID,
  jsonResponse,
  renderConnectSheet,
} from './connect-sheet-test-helpers.js';

/**
 * connect-sheet-qr-realtime.test.tsx (fix, 2026-09-16 - "QR never reaches
 * the browser" first-live-deployment incident) - the end-to-end regression
 * test for the actual bug: a real `instance.qr` frame delivered on the
 * connection the panel itself opens must render in the QR panel. This FAILS
 * with the bug present (before this fix, `useLinkStream` never opened any
 * instance-scoped connection, so a mock that only serves `/v1/events`
 * (no query string) would need to carry the frame - and the real backend
 * never puts an `instance.qr` frame there, see `hub.ts`'s `publish`) and
 * PASSES with the fix (the frame arrives on `/v1/events?instanceId=...`,
 * which is exactly what `sse-instance-stream.ts` now opens while the
 * Connect sheet holds this instance).
 *
 * Split out of `connect-sheet.test.tsx` (workspace 300-line max-lines rule).
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

function qrFrame(attemptsLeft: number): string {
  const data = {
    type: 'instance.qr',
    instanceId: INSTANCE_ID,
    payload: 'bearer-qr-payload-from-worker',
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
    attemptsLeft,
  };
  return `id: evt-1\nevent: instance.qr\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('ConnectSheet - instance.qr realtime delivery', () => {
  beforeEach(() => {
    setAccessToken('test-token');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('an_instance_qr_frame_on_the_instance_scoped_stream_renders_in_the_qr_panel', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url === '/v1/instances' && method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            data: {
              id: INSTANCE_ID,
              label: 'Sales',
              linkState: 'unlinked',
              healthState: 'never_linked',
              desiredState: 'offline',
            },
            meta: { requestId: 'r1' },
          }),
        );
      }
      if (url === `/v1/instances/${INSTANCE_ID}/link` && method === 'POST') {
        return Promise.resolve(
          jsonResponse({ data: { linkState: 'pairing' }, meta: { requestId: 'r2' } }),
        );
      }
      if (url === `/v1/instances/${INSTANCE_ID}/link-status`) {
        // Deliberately reports NO payload here - the QR must arrive via the
        // realtime frame below, not the poll fallback, proving this test
        // exercises the SSE delivery path and not the polling fallback that
        // `useLinkStream` also has.
        return Promise.resolve(
          jsonResponse({
            data: {
              linkState: 'pairing',
              healthState: 'never_linked',
              desiredState: 'offline',
              needsUserAction: false,
              userActionReason: null,
              attemptsLeft: 5,
              maskedNumber: null,
            },
            meta: { requestId: 'r3' },
          }),
        );
      }
      // The exact seam this bug lived in: `GET /v1/events?instanceId=...`
      // is the instance-scoped stream `sse-instance-stream.ts` opens. Real
      // production evidence (worker publish -> bridge subscriber -> hub) all
      // worked; the missing piece was ever asking for THIS channel at all.
      if (url === `/v1/events?instanceId=${INSTANCE_ID}`) {
        return Promise.resolve(
          new Response(sseStreamFromChunks([qrFrame(5)]), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConnectSheet();
    await createInstanceAndChooseQr();

    // The QR image renders once `linkStream.payload` is populated - proof
    // the frame delivered on the instance-scoped connection reached the
    // panel exactly the way the real browser must.
    await waitFor(() => {
      expect(screen.getByTestId('qr-image')).not.toBeNull();
    });
    const attemptsBadge = screen.getByTestId('qr-attempts-left');
    expect(attemptsBadge.textContent).toContain('5');

    // The instance-scoped connection must actually have been requested -
    // this is the regression guard itself: before the fix, nothing ever
    // called fetch with this URL, so this frame could never have been
    // delivered by any real backend (hub.ts only ever routes `instance.qr`
    // to this exact channel).
    expect(
      fetchMock.mock.calls.some((call) => call[0] === `/v1/events?instanceId=${INSTANCE_ID}`),
    ).toBe(true);
  });
});
