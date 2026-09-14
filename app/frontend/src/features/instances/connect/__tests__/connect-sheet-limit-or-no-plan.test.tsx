// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { setAccessToken } from '../../../../lib/api-client.js';
import { jsonResponse, renderConnectSheet } from './connect-sheet-test-helpers.js';

/**
 * connect-sheet-limit-or-no-plan.test.tsx (2026-09-08 bug fix) - a
 * `REGISTERED_LIMIT_REACHED` 409 on the very first `POST /v1/instances`
 * call (label -> Continue) must render the three-part "no plan or limit
 * used up" block, never the bare generic "Something went wrong" string -
 * this is the exact QA repro (demo client has `plan_id: NULL` and 0
 * numbers, so the API's `?? 0` fallback refuses the FIRST number). Modelled
 * on `connect-sheet-mfa.test.tsx`'s stub idiom.
 */
describe('ConnectSheet - REGISTERED_LIMIT_REACHED (no plan or limit used up)', () => {
  beforeEach(() => {
    setAccessToken('test-token');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('renders_the_no_plan_aware_title_and_body_not_the_generic_error', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/v1/instances' && method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 'REGISTERED_LIMIT_REACHED',
                message: 'This plan has reached its registered-instance limit.',
                requestId: 'r1',
              },
            },
            409,
          ),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConnectSheet();

    await waitFor(() => {
      expect(screen.getByTestId('connect-label-input')).not.toBeNull();
    });
    fireEvent.change(screen.getByTestId('connect-label-input'), { target: { value: 'Sales' } });
    fireEvent.click(screen.getByTestId('connect-create-button'));

    const block = await screen.findByTestId('connect-limit-or-no-plan');
    expect(block.textContent).toContain('This workspace cannot add a number yet');
    expect(block.textContent).toContain('Your workspace has no plan assigned');
    expect(block.textContent).toContain('Nothing was lost. No number was created.');

    expect(screen.queryByTestId('connect-error')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('Something went wrong');
  });
});
