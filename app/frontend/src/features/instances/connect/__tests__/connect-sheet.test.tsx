// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { PARKED_COPY } from '@wp/domain';
import { setAccessToken } from '../../../../lib/api-client.js';
import {
  createInstanceAndChooseQr,
  INSTANCE_ID,
  jsonResponse,
  renderConnectSheet,
} from './connect-sheet-test-helpers.js';

/**
 * connect-sheet.test.tsx (P08 U7) - the ConnectSheet flow's contract-level
 * proofs: a connected label renders the API's `maskedNumber` VERBATIM (no
 * full phone number ever reaches the DOM), and the parked copy renders the
 * `@wp/domain` safety-reviewed constant byte-for-byte (never retyped). The
 * `NO_FREE_SLOT` 409 case lives in its own file
 * (`connect-sheet-no-free-slot.test.tsx`, workspace 300-line max-lines
 * rule). Mocks the global `fetch` (the one true network seam `apiFetch`
 * calls through), never the feature's own `api.ts` module.
 */

describe('ConnectSheet', () => {
  beforeEach(() => {
    setAccessToken('test-token');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('connected_label_is_masked', async () => {
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
          jsonResponse({ data: { desiredState: 'online' }, meta: { requestId: 'r3' } }),
        );
      }
      if (url === `/v1/instances/${INSTANCE_ID}/link-status`) {
        return Promise.resolve(
          jsonResponse({
            data: {
              linkState: 'linked',
              healthState: 'connected',
              desiredState: 'online',
              needsUserAction: false,
              userActionReason: null,
              attemptsLeft: 3,
              maskedNumber: '+91·····21',
            },
            meta: { requestId: 'r4' },
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConnectSheet();
    await createInstanceAndChooseQr();

    await waitFor(() => {
      expect(screen.getByTestId('connect-go-online-button')).not.toBeNull();
    });

    // The link-status poll (useLinkStream) fires once immediately, giving
    // linkStream.maskedNumber a value BEFORE the user clicks online.
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) => call[0] === `/v1/instances/${INSTANCE_ID}/link-status`),
      ).toBe(true);
    });

    fireEvent.click(screen.getByTestId('connect-go-online-button'));

    const connectedLabel = await screen.findByTestId('connect-masked-number');
    expect(connectedLabel.textContent).toBe('+91·····21');

    // Invariant: no full E.164 number anywhere in the rendered DOM.
    const fullDom = document.body.textContent ?? '';
    expect(fullDom).not.toMatch(/\+91\d{10}/u);
  });

  it('online_resolving_alone_never_shows_connected_without_real_link_evidence', async () => {
    // 2026-09-15 live bug: `POST /online` only sets `desired_state='online'`
    // (`instance-online-slot.repo.ts#setOnlineWithSlotCheck`) - it says
    // nothing about whether the device paired. A real row was observed with
    // `link_state='pairing'`, `phone_e164=null`, `qr_attempts=4` while the
    // Connect sheet showed "Connected - This number is linked and ready."
    // This test's `link-status` mock NEVER reports `healthState: 'connected'`
    // (it stays 'never_linked'/'pairing' throughout, as the real row was) -
    // so a correct flow must land on the honest 'linking' waiting stage and
    // must NOT render `connect-connected-state`, even though the `/online`
    // call itself resolves 200.
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
          jsonResponse({ data: { desiredState: 'online' }, meta: { requestId: 'r3' } }),
        );
      }
      if (url === `/v1/instances/${INSTANCE_ID}/link-status`) {
        // Mirrors the real live row exactly: still `pairing`/`never_linked`,
        // no masked number, even after `/online` has resolved. Never
        // 'connected' anywhere in this test.
        return Promise.resolve(
          jsonResponse({
            data: {
              linkState: 'pairing',
              healthState: 'never_linked',
              desiredState: 'online',
              needsUserAction: false,
              userActionReason: null,
              attemptsLeft: 3,
              maskedNumber: null,
            },
            meta: { requestId: 'r4' },
          }),
        );
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

    // The honest waiting stage must appear...
    await waitFor(() => {
      expect(screen.getByTestId('connect-linking-state')).not.toBeNull();
    });

    // ...and the connected stage must never appear, no matter how long we
    // give the poll to keep firing with the same unlinked evidence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('connect-connected-state')).toBeNull();
  });

  it('parked_copy_renders_the_domain_constant_verbatim', async () => {
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
      if (url === `/v1/instances/${INSTANCE_ID}/park` && method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            data: { desiredState: 'offline', parkedCopy: PARKED_COPY },
            meta: { requestId: 'r3' },
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
            meta: { requestId: 'r4' },
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConnectSheet();
    await createInstanceAndChooseQr();

    await waitFor(() => {
      expect(screen.getByTestId('connect-park-button')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('connect-park-button'));

    const parkedCopyEl = await screen.findByTestId('connect-parked-copy');
    expect(parkedCopyEl.textContent).toBe(PARKED_COPY);
  });
});
