// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, type Locale } from '@wp/ui';
import { BROADCAST_DISCLOSURE, BANNED_CLAIMS } from '@wp/domain';
import { createBroadcastInputSchema } from '@wp/contracts';
import { Composer } from '../components/composer.js';
import {
  stubComposerFetch,
  INSTANCE_ID,
  GROUP_ID,
  type RecordedRequest,
} from './__test-support__/stub-composer-fetch.js';
import { stubComposerFetchWithFailures } from './__test-support__/stub-composer-fetch-retry-support.js';

/**
 * composer.test.tsx (P23a Unit U4) - the composer + variables + audience
 * picker surface. Same stub-fetch + recorded-request idiom as
 * `preflight.test.tsx`/`wallet-banner.test.tsx`: every request the component
 * issues is recorded (`method`, `url`, `headers`, `body`) so assertions bind
 * to the exact wire shape, never an implementation detail of the hook. The
 * fetch stub and its fixtures live in `__test-support__/stub-composer-fetch.ts`
 * (this file sat near the `max-lines: 300` cap - core-invariants.md's
 * mandatory split idiom).
 */

function renderComposer(locale: Locale = 'en'): { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  stubComposerFetch(requests);
  const queryClient = new QueryClient();
  render(
    <I18nProvider locale={locale}>
      <QueryClientProvider client={queryClient}>
        <Composer />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { requests };
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

describe('Composer', () => {
  afterEach(() => {
    cleanup();
  });

  it('compose_then_review_creates_one_draft_and_one_preflight_with_idempotency_keys', async () => {
    const { requests } = renderComposer();
    await fillBasicForm();

    fireEvent.click(screen.getByTestId('composer-review'));

    await screen.findByTestId('preflight-panel');

    const createRequests = requests.filter(
      (request) => request.method === 'POST' && /\/v1\/broadcasts$/.test(request.url),
    );
    expect(createRequests).toHaveLength(1);
    const createRequest = createRequests[0]!;
    expect(createRequest.headers['idempotency-key']).toBeTruthy();
    const parsed = createBroadcastInputSchema.parse(createRequest.body);
    expect(parsed.priority).toBe('low');
    expect(parsed.scheduledAt).toBeNull();

    const preflightRequests = requests.filter(
      (request) => request.method === 'POST' && request.url.endsWith('/preflight'),
    );
    expect(preflightRequests).toHaveLength(1);
  });

  it('inserting_a_variable_writes_the_token_at_the_caret_and_lists_it', async () => {
    renderComposer();
    await fillBasicForm();

    const body = screen.getByTestId('composer-body') as HTMLTextAreaElement;
    const beforeValue = body.value;

    fireEvent.click(screen.getByRole('button', { name: 'first_name' }));

    await waitFor(() => {
      expect((screen.getByTestId('composer-body') as HTMLTextAreaElement).value).toBe(
        `${beforeValue}{{first_name}}`,
      );
    });
    expect(screen.getByText(/Variables in this message/).textContent).toContain('first_name');

    fireEvent.change(screen.getByPlaceholderText('custom attribute key'), {
      target: { value: 'city' },
    });
    fireEvent.click(screen.getByTestId('variable-attr-insert'));

    await waitFor(() => {
      expect((screen.getByTestId('composer-body') as HTMLTextAreaElement).value).toContain(
        '{{attrs.city}}',
      );
    });

    fireEvent.change(screen.getByPlaceholderText('custom attribute key'), {
      target: { value: 'City-1' },
    });
    fireEvent.click(screen.getByTestId('variable-attr-insert'));

    expect(screen.getByRole('alert')).toBeTruthy();
    expect((screen.getByTestId('composer-body') as HTMLTextAreaElement).value).not.toContain(
      'City-1',
    );
  });

  it('back_to_editing_cancels_the_draft_instead_of_orphaning_it', async () => {
    const { requests } = renderComposer();
    await fillBasicForm();

    fireEvent.click(screen.getByTestId('composer-review'));
    await screen.findByTestId('preflight-panel');

    fireEvent.click(screen.getByText('Back to editing'));

    await waitFor(() => {
      const cancelRequests = requests.filter(
        (request) => request.method === 'POST' && request.url.endsWith('/cancel'),
      );
      expect(cancelRequests).toHaveLength(1);
    });
    const cancelRequests = requests.filter(
      (request) => request.method === 'POST' && request.url.endsWith('/cancel'),
    );
    expect(cancelRequests[0]!.headers['idempotency-key']).toBeTruthy();

    await screen.findByTestId('composer-review');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Launch');
    expect((screen.getByTestId('composer-body') as HTMLTextAreaElement).value).toBe('Hello there');
  });

  it('start_uses_a_fresh_idempotency_key_and_never_offers_a_faster_mode', async () => {
    const { requests } = renderComposer();
    await fillBasicForm();

    fireEvent.click(screen.getByTestId('composer-review'));
    await screen.findByTestId('preflight-panel');

    fireEvent.click(screen.getByText('Start broadcast'));

    await waitFor(() => {
      const startRequests = requests.filter(
        (request) => request.method === 'POST' && request.url.endsWith('/start'),
      );
      expect(startRequests).toHaveLength(1);
    });

    const createRequest = requests.find(
      (request) => request.method === 'POST' && /\/v1\/broadcasts$/.test(request.url),
    )!;
    const startRequest = requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/start'),
    )!;
    expect(startRequest.headers['idempotency-key']).toBeTruthy();
    expect(startRequest.headers['idempotency-key']).not.toBe(
      createRequest.headers['idempotency-key'],
    );

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/faster/i);
    expect(text).not.toMatch(/boost/i);
    expect(text).not.toMatch(/speed up/i);

    const lowerText = text.toLowerCase();
    for (const claim of BANNED_CLAIMS) {
      expect(lowerText).not.toContain(claim.toLowerCase());
    }
  });

  it('a_failed_start_shows_an_alert_on_the_quote_panel', async () => {
    const requests: RecordedRequest[] = [];
    const { failNextStart } = stubComposerFetchWithFailures(requests);
    const queryClient = new QueryClient();
    render(
      <I18nProvider locale="en">
        <QueryClientProvider client={queryClient}>
          <Composer />
        </QueryClientProvider>
      </I18nProvider>,
    );

    await fillBasicForm();
    fireEvent.click(screen.getByTestId('composer-review'));
    await screen.findByTestId('preflight-panel');

    failNextStart();
    fireEvent.click(screen.getByText('Start broadcast'));

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toBe('Something went wrong. Nothing was sent.');

    // The panel is still rendered and Start is clickable again (not stuck
    // disabled behind a silently-swallowed error).
    expect(screen.getByTestId('preflight-panel')).toBeTruthy();
    const startButton = screen.getByText('Start broadcast').closest('button');
    expect((startButton as HTMLButtonElement).disabled).toBe(false);
  });

  it.each<Locale>(['en', 'hi'])(
    'every_composer_surface_shows_the_broadcast_disclosure (%s)',
    async (locale) => {
      renderComposer(locale);
      const disclosure = await screen.findByTestId('broadcast-disclosure');
      expect(disclosure.textContent).toBe(BROADCAST_DISCLOSURE);
    },
  );

  it('selecting_groups_sends_a_groups_audience_without_target_kind', async () => {
    const { requests } = renderComposer();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Launch' } });

    const instanceSelect = await screen.findByTestId('composer-instance');
    await waitFor(() => {
      // Plain DOM query - see `fillBasicForm`'s comment above (aria-hidden).
      expect(instanceSelect.querySelectorAll('option').length).toBeGreaterThan(0);
    });
    fireEvent.change(instanceSelect, { target: { value: INSTANCE_ID } });

    const groupsToggle = screen.getByTestId('composer-target-kind-groups');
    fireEvent.click(within(groupsToggle).getByRole('radio'));

    await screen.findByTestId('audience-groups-picker');

    fireEvent.change(screen.getByTestId('composer-body'), {
      target: { value: 'Hello there' },
    });

    fireEvent.click(screen.getByTestId('composer-review'));
    await screen.findByTestId('preflight-panel');

    const createRequest = requests.find(
      (request) => request.method === 'POST' && /\/v1\/broadcasts$/.test(request.url),
    )!;
    const body = createRequest.body as { audience: unknown };
    expect(body.audience).toEqual({ kind: 'groups' });
    expect(body.audience).not.toHaveProperty('targetKind');
  });

  it('selecting_a_subset_of_groups_sends_their_ids', async () => {
    const { requests } = renderComposer();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Launch' } });

    const instanceSelect = await screen.findByTestId('composer-instance');
    await waitFor(() => {
      // Plain DOM query - see `fillBasicForm`'s comment above (aria-hidden).
      expect(instanceSelect.querySelectorAll('option').length).toBeGreaterThan(0);
    });
    fireEvent.change(instanceSelect, { target: { value: INSTANCE_ID } });

    const groupsToggle = screen.getByTestId('composer-target-kind-groups');
    fireEvent.click(within(groupsToggle).getByRole('radio'));

    const groupOption = await screen.findByTestId(`audience-group-option-${GROUP_ID}`);
    fireEvent.click(within(groupOption).getByRole('checkbox'));

    fireEvent.change(screen.getByTestId('composer-body'), {
      target: { value: 'Hello there' },
    });

    fireEvent.click(screen.getByTestId('composer-review'));
    await screen.findByTestId('preflight-panel');

    const createRequest = requests.find(
      (request) => request.method === 'POST' && /\/v1\/broadcasts$/.test(request.url),
    )!;
    const body = createRequest.body as { audience: unknown };
    expect(body.audience).toEqual({ kind: 'groups', groupIds: [GROUP_ID] });
    expect(body.audience).not.toHaveProperty('targetKind');
  });
});
