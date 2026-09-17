// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { PARKED_COPY } from '@wp/domain';
import { setAccessToken } from '../../../../lib/api-client.js';
import {
  createInstanceAndChooseQr,
  HOLDER_ID,
  INSTANCE_ID,
  jsonResponse,
  neverEndingSseResponse,
  renderConnectSheet,
} from './connect-sheet-test-helpers.js';

/**
 * connect-sheet-no-free-slot.test.tsx (P08 U7) - split out of
 * `connect-sheet.test.tsx` (workspace 300-line max-lines rule). Proves the
 * `NO_FREE_SLOT` 409 renders the holders list without firing any mutation
 * until the user explicitly clicks "Park this one instead".
 */
describe('ConnectSheet - NO_FREE_SLOT', () => {
  beforeEach(() => {
    setAccessToken('test-token');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('no_free_slot_renders_holders_and_parks_nothing_by_itself', async () => {
    const parkCalls: string[] = [];
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
      if (url === `/v1/instances/${INSTANCE_ID}/online` && method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 'NO_FREE_SLOT',
                message: 'No free slot',
                requestId: 'r3',
                details: {
                  holders: [
                    { instanceId: HOLDER_ID, label: 'Support', maskedNumber: '+91·····99' },
                  ],
                },
              },
            },
            409,
          ),
        );
      }
      if (url === `/v1/instances/${HOLDER_ID}/park` && method === 'POST') {
        parkCalls.push(HOLDER_ID);
        return Promise.resolve(
          jsonResponse({
            data: { desiredState: 'offline', parkedCopy: PARKED_COPY },
            meta: { requestId: 'r4' },
          }),
        );
      }
      if (url === `/v1/instances/${INSTANCE_ID}/link-status`) {
        return Promise.resolve(
          jsonResponse({
            data: {
              linkState: 'pairing',
              healthState: 'never_linked',
              desiredState: 'offline',
              needsUserAction: false,
              userActionReason: null,
              attemptsLeft: 3,
              maskedNumber: null,
            },
            meta: { requestId: 'r5' },
          }),
        );
      }
      if (url.startsWith('/v1/events')) {
        // FIX (2026-09-16): see `neverEndingSseResponse`'s doc comment -
        // `useLinkStream` now also opens an instance-scoped SSE connection
        // while the sheet holds an `activeInstanceId`.
        return Promise.resolve(neverEndingSseResponse());
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConnectSheet();
    await createInstanceAndChooseQr();

    await waitFor(() => {
      expect(screen.getByTestId('connect-go-online-button')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('connect-go-online-button'));

    const holderRow = await screen.findByTestId(`no-free-slot-holder-${HOLDER_ID}`);
    expect(holderRow.textContent).toContain('Support');
    expect(holderRow.textContent).toContain('+91·····99');

    // The 409 alone must never have parked anything.
    expect(parkCalls).toHaveLength(0);

    fireEvent.click(screen.getByTestId(`park-instead-button-${HOLDER_ID}`));

    await waitFor(() => {
      expect(parkCalls).toEqual([HOLDER_ID]);
    });
  });
});
