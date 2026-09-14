// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@wp/ui';
import { en } from '@wp/i18n';
import { Composer } from '../components/composer.js';
import {
  stubComposerFetchWithFailures,
  INSTANCE_ID,
  type RecordedRequest,
} from './__test-support__/stub-composer-fetch-retry-support.js';

/**
 * use-composer-retry-c2b.test.tsx (P23a C2b hardening pass; P23a C1 fix
 * round MINOR 6 flipped these assertions to the intended contract) -
 * retry-storm angles over `useComposer` beyond `composer.test.tsx`'s happy
 * path: a 503 on the create-draft POST, retried by re-clicking "Review
 * quote", carries the SAME idempotency key as the failed attempt (one
 * intent, one key); a Back-then-review cycle after a failure mints a NEW
 * create key (no orphaned-draft key reuse across abandoned attempts); and a
 * 503 on the start POST, retried by re-clicking "Start broadcast", carries
 * the SAME start key, which is never equal to the create key.
 *
 * `useComposer.requestQuote`/`.start` have NO automatic retry path of their
 * own - "retry" here means the user re-clicking the same button after the
 * errored stage returns control to them, which is the only retry path that
 * exists. `createKeyRef`/`startKeyRef` (see `use-composer.ts`'s header) mint
 * a key once per INTENT and reuse it on every retry of that intent, clearing
 * it only on a successful create/start or on `backToEditing`'s cancel - so a
 * user-driven retry after a transient failure never risks a duplicate
 * draft/start server-side.
 */

function renderComposer(): {
  requests: RecordedRequest[];
  failNextCreate: () => void;
  failNextStart: () => void;
  failNextPreflight: () => void;
  failNextPreflightWith: (status: number, code: string) => void;
} {
  const requests: RecordedRequest[] = [];
  const { failNextCreate, failNextStart, failNextPreflight, failNextPreflightWith } =
    stubComposerFetchWithFailures(requests);
  const queryClient = new QueryClient();
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <Composer />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { requests, failNextCreate, failNextStart, failNextPreflight, failNextPreflightWith };
}

async function fillBasicForm(): Promise<void> {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Launch' } });

  const instanceSelect = await screen.findByTestId('composer-instance');
  await waitFor(() => {
    // A plain DOM query, not `getAllByRole`: the value-holder `<select>` is
    // intentionally `aria-hidden` (see composer.tsx) so role-based queries
    // never see it, matching `messages/compose/composer.test.tsx`'s idiom
    // for the same hidden-input pattern.
    expect(instanceSelect.querySelectorAll('option').length).toBeGreaterThan(0);
  });
  fireEvent.change(instanceSelect, { target: { value: INSTANCE_ID } });

  const tagCheckbox = await screen.findByRole('checkbox', { name: /VIP/ });
  fireEvent.click(tagCheckbox);

  fireEvent.change(screen.getByTestId('composer-body'), {
    target: { value: 'Hello there' },
  });
}

function createRequestsOf(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((r) => r.method === 'POST' && /\/v1\/broadcasts$/.test(r.url));
}

function startRequestsOf(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((r) => r.method === 'POST' && r.url.endsWith('/start'));
}

function cancelRequestsOf(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((r) => r.method === 'POST' && r.url.endsWith('/cancel'));
}

describe('useComposer retry-storm hardening (P23a C2b; C1 fix round MINOR 6)', () => {
  afterEach(() => {
    cleanup();
  });

  it('a_503_on_create_then_a_user_retry_reuses_the_same_idempotency_key_one_intent_one_key', async () => {
    const { requests, failNextCreate } = renderComposer();
    await fillBasicForm();

    failNextCreate();
    fireEvent.click(screen.getByTestId('composer-review'));

    await waitFor(() => {
      expect(createRequestsOf(requests)).toHaveLength(1);
    });
    // The failed attempt returns control to 'editing' with an error banner -
    // re-click the same button to retry.
    await screen.findByRole('alert');

    fireEvent.click(screen.getByTestId('composer-review'));
    await screen.findByTestId('preflight-panel');

    const createRequests = createRequestsOf(requests);
    expect(createRequests).toHaveLength(2);
    const firstKey = createRequests[0]!.headers['idempotency-key'];
    const secondKey = createRequests[1]!.headers['idempotency-key'];
    // One intent, one key: the retry reuses the key from the failed attempt.
    expect(secondKey).toBe(firstKey);
  });

  it('back_then_review_again_after_a_failure_uses_a_new_create_key_never_the_abandoned_one', async () => {
    const { requests } = renderComposer();
    await fillBasicForm();

    fireEvent.click(screen.getByTestId('composer-review'));
    await screen.findByTestId('preflight-panel');

    fireEvent.click(screen.getByText('Back to editing'));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/cancel'))).toBe(true);
    });
    await screen.findByTestId('composer-review');

    fireEvent.click(screen.getByTestId('composer-review'));
    await screen.findByTestId('preflight-panel');

    const createRequests = createRequestsOf(requests);
    expect(createRequests).toHaveLength(2);
    expect(createRequests[1]!.headers['idempotency-key']).not.toBe(
      createRequests[0]!.headers['idempotency-key'],
    );
  });

  it('a_503_on_start_then_a_user_retry_reuses_the_same_start_key_and_it_never_equals_the_create_key', async () => {
    const { requests, failNextStart } = renderComposer();
    await fillBasicForm();

    fireEvent.click(screen.getByTestId('composer-review'));
    await screen.findByTestId('preflight-panel');

    failNextStart();
    fireEvent.click(screen.getByText('Start broadcast'));

    await waitFor(() => {
      expect(startRequestsOf(requests)).toHaveLength(1);
    });
    // The failed start is now visibly surfaced (`role="alert"` on
    // `PreflightPanel`, P23a C1 fix round) before the user retries.
    await screen.findByRole('alert');

    fireEvent.click(screen.getByText('Start broadcast'));
    await waitFor(() => {
      expect(startRequestsOf(requests)).toHaveLength(2);
    });

    const startRequests = startRequestsOf(requests);
    const firstStartKey = startRequests[0]!.headers['idempotency-key'];
    const secondStartKey = startRequests[1]!.headers['idempotency-key'];
    // One intent, one key: the retry reuses the key from the failed attempt.
    expect(secondStartKey).toBe(firstStartKey);

    const createRequest = createRequestsOf(requests)[0]!;
    expect(firstStartKey).not.toBe(createRequest.headers['idempotency-key']);
    expect(secondStartKey).not.toBe(createRequest.headers['idempotency-key']);
  });

  it('a_no_plan_preflight_shows_the_honest_no_plan_line_not_the_generic_error', async () => {
    // P23a C1 fix round (MINOR 4): the backend now answers a plan-less
    // workspace with 402 ENTITLEMENT_ERROR (PreflightNoPlanError) instead of
    // "over limit (0)"; the composer must map it to the catalogue's own
    // no-plan sentence, never the generic "Something went wrong".
    const { requests, failNextPreflightWith } = renderComposer();
    await fillBasicForm();

    failNextPreflightWith(402, 'ENTITLEMENT_ERROR');
    fireEvent.click(screen.getByTestId('composer-review'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(en['broadcasts.limit.noPlan']);
    // The orphaned draft is still cancelled on this path (MINOR 6).
    await waitFor(() => {
      expect(cancelRequestsOf(requests)).toHaveLength(1);
    });
  });

  it('a_failed_preflight_cancels_the_draft_it_just_created', async () => {
    const { requests, failNextPreflight } = renderComposer();
    await fillBasicForm();

    failNextPreflight();
    fireEvent.click(screen.getByTestId('composer-review'));

    await waitFor(() => {
      expect(cancelRequestsOf(requests)).toHaveLength(1);
    });
    await screen.findByRole('alert');

    // Exactly one cancel - the orphaned draft is never left server-side.
    expect(cancelRequestsOf(requests)).toHaveLength(1);
    expect(createRequestsOf(requests)).toHaveLength(1);

    // A second Review issues a new create with a DIFFERENT key - the
    // cancelled draft's intent has ended, so this is a genuinely new one.
    fireEvent.click(screen.getByTestId('composer-review'));
    await screen.findByTestId('preflight-panel');

    const createRequests = createRequestsOf(requests);
    expect(createRequests).toHaveLength(2);
    expect(createRequests[1]!.headers['idempotency-key']).not.toBe(
      createRequests[0]!.headers['idempotency-key'],
    );
  });
});
