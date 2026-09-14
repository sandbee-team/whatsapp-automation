// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@wp/ui';
import { ContactsList } from '../ContactsList.js';

/**
 * contacts-list.test.tsx (P26b U5) - the restyled `/contacts` screen's
 * `DataTable` rendering (name/phone/tags/opt-out badge) and keyset
 * "Load more" from stubbed `GET /v1/contacts` pages, plus the add-contact
 * dialog opening. Same raw-`fetch`-stub idiom as `group-list.test.tsx` - no
 * MSW.
 */

function contactFixture(id: string, overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id,
    phoneE164: '+919000000000',
    waJid: '919000000000@s.whatsapp.net',
    addressingMode: 'phone',
    displayName: 'Asha Verma',
    firstName: null,
    lastName: null,
    attrs: {},
    source: 'manual',
    consentBasis: null,
    optOutState: 'none',
    optedOutAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    tags: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, meta: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ data: body, meta }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubContactsFetch(pages: { items: unknown[]; nextCursor?: string }[]): void {
  let callIndex = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/contacts/tags')) {
      return jsonResponse({ items: [] });
    }
    if (url.includes('/v1/contacts')) {
      const page = pages[Math.min(callIndex, pages.length - 1)]!;
      callIndex += 1;
      return jsonResponse(
        { items: page.items },
        page.nextCursor ? { nextCursor: page.nextCursor } : {},
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderList(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <ContactsList />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('ContactsList', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders contact rows with name, phone and opt-out badge', async () => {
    stubContactsFetch([
      {
        items: [
          contactFixture('c1', { displayName: 'Asha Verma' }),
          contactFixture('c2', {
            phoneE164: '+919111111111',
            displayName: 'Ravi Kumar',
            optOutState: 'opted_out',
            optedOutAt: '2026-09-02T00:00:00.000Z',
            tags: [{ id: 't1', name: 'VIP' }],
          }),
        ],
      },
    ]);

    renderList();

    await screen.findByText('Asha Verma');
    expect(screen.getByText('+919000000000')).toBeTruthy();
    expect(screen.getByText('Ravi Kumar')).toBeTruthy();
    expect(screen.getByText('VIP')).toBeTruthy();
    expect(screen.getByText('Opted out')).toBeTruthy();
  });

  it('shows the honest empty state when there are no contacts', async () => {
    stubContactsFetch([{ items: [] }]);
    renderList();
    await screen.findByText('No contacts yet');
  });

  it('load more fetches the next keyset page and appends rows', async () => {
    stubContactsFetch([
      { items: [contactFixture('c1', { displayName: 'Asha Verma' })], nextCursor: 'cursor-1' },
      { items: [contactFixture('c2', { displayName: 'Ravi Kumar' })] },
    ]);

    renderList();

    await screen.findByText('Asha Verma');
    const loadMore = screen.getByTestId('contacts-load-more');
    fireEvent.click(loadMore);

    await waitFor(() => {
      expect(screen.getByText('Ravi Kumar')).toBeTruthy();
    });
    expect(screen.getByText('Asha Verma')).toBeTruthy();
  });

  it('opens the add-contact dialog with the contact form', async () => {
    stubContactsFetch([{ items: [] }]);
    renderList();

    await screen.findByText('No contacts yet');
    fireEvent.click(screen.getByTestId('contacts-add-button'));

    const form = await screen.findByTestId('contact-form');
    expect(within(form).getByTestId('contact-form-phone')).toBeTruthy();
  });
});
