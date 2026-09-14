// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { sortInstanceItems, useInstanceList } from '../use-instance-list.js';
import type { InstanceCardResult } from '../api.js';

/**
 * use-instance-list.test.tsx (P26b) - the shared instance list joins
 * `/v1/queue-status` (the only list source) with one card fetch per
 * instance, lists an instance even while its card is pending/failed, and
 * sorts needs-action first, parked last.
 */

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function card(overrides: Partial<InstanceCardResult>): InstanceCardResult {
  return {
    instanceId: ID_A,
    label: 'Sales',
    linkState: 'linked',
    healthState: 'connected',
    desiredState: 'online',
    parked: false,
    needsUserAction: false,
    userActionReason: null,
    healthScore: 90,
    healthBand: 'HEALTHY',
    warmupTier: 1,
    warmupDay: 1,
    todaySent: 0,
    effDailyCap: 10,
    newConversationsToday: 0,
    effNewConvCap: 5,
    sendingWindow: { start: '09:00', end: '20:00', tz: 'Asia/Kolkata' },
    lastSendAt: null,
    queueDepth: 0,
    queueDepthCapped: false,
    oldestQueuedAgeSeconds: null,
    nextSendEarliestAt: null,
    serverNow: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/v1/queue-status')) {
        return json({
          instances: [
            { instanceId: ID_A, waiting: 3, sentToday: 1, failedToday: 0, spentTodayMinor: '0' },
            { instanceId: ID_B, waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
          ],
          workspace: { waiting: 3, sentToday: 1, failedToday: 0, spentTodayMinor: '0' },
        });
      }
      if (url.includes(`/v1/instances/${ID_A}/card`)) {
        return json(card({ instanceId: ID_A, label: 'Sales' }));
      }
      if (url.includes(`/v1/instances/${ID_B}/card`)) {
        return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'x' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useInstanceList', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists every queue-status instance and attaches its card when it loads', async () => {
    stubFetch();
    const { result } = renderHook(() => useInstanceList(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items).toHaveLength(2);

    await waitFor(() => expect(result.current.isCardsLoading).toBe(false));
    const a = result.current.items.find((item) => item.instanceId === ID_A);
    const b = result.current.items.find((item) => item.instanceId === ID_B);
    expect(a?.card?.label).toBe('Sales');
    expect(a?.cardStatus).toBe('success');
    expect(a?.queue.waiting).toBe(3);
    // A failed card never drops the instance from the list.
    expect(b?.card).toBeNull();
    expect(b?.cardStatus).toBe('error');
  });

  it('sorts needs-action first, parked last, then by label', () => {
    const base = (id: string, overrides: Partial<InstanceCardResult>) => ({
      instanceId: id,
      queue: { instanceId: id, waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
      card: card({ instanceId: id, ...overrides }),
      cardStatus: 'success' as const,
    });
    const sorted = sortInstanceItems([
      base('c', { label: 'Zulu', parked: true }),
      base('b', { label: 'Bravo' }),
      base('a', { label: 'Alpha', needsUserAction: true }),
      base('d', { label: 'Charlie' }),
    ]);
    expect(sorted.map((item) => item.card?.label)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Zulu']);
  });

  it('an empty queue-status list renders zero items, never a loading/error state stuck on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/v1/queue-status')) {
          return json({
            instances: [],
            workspace: { waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const { result } = renderHook(() => useInstanceList(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items).toEqual([]);
    expect(result.current.isError).toBe(false);
    // No card queries were ever created, so cards can never be "stuck loading".
    expect(result.current.isCardsLoading).toBe(false);
  });

  it('sort is stable across items sharing an identical label with a missing card', () => {
    // Two items with card === null (both cardStatus 'pending' or 'error') and
    // the same fallback label (''.localeCompare('') === 0) must break the
    // tie by instanceId alone - never by original array position leaking
    // through as accidental "stability" that a later refactor could invert.
    const pending = (id: string) => ({
      instanceId: id,
      queue: { instanceId: id, waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
      card: null,
      cardStatus: 'pending' as const,
    });
    const sorted = sortInstanceItems([pending('zzz'), pending('aaa'), pending('mmm')]);
    expect(sorted.map((item) => item.instanceId)).toEqual(['aaa', 'mmm', 'zzz']);

    // Reversing the input must produce the exact same output - proving the
    // order is derived purely from `instanceId`, not input position.
    const sortedReversed = sortInstanceItems([pending('mmm'), pending('zzz'), pending('aaa')]);
    expect(sortedReversed.map((item) => item.instanceId)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('refetch() refetches both the queue-status layer and every card layer', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push(url);
        if (url.includes('/v1/queue-status')) {
          return json({
            instances: [
              { instanceId: ID_A, waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
            ],
            workspace: { waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
          });
        }
        if (url.includes(`/v1/instances/${ID_A}/card`)) {
          return json(card({ instanceId: ID_A, label: 'Sales' }));
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const { result } = renderHook(() => useInstanceList(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(result.current.isCardsLoading).toBe(false));
    const queueCallsBefore = calls.filter((u) => u.includes('/v1/queue-status')).length;
    const cardCallsBefore = calls.filter((u) => u.includes('/card')).length;
    expect(queueCallsBefore).toBeGreaterThan(0);
    expect(cardCallsBefore).toBeGreaterThan(0);

    result.current.refetch();

    await waitFor(() => {
      const queueCallsAfter = calls.filter((u) => u.includes('/v1/queue-status')).length;
      const cardCallsAfter = calls.filter((u) => u.includes('/card')).length;
      expect(queueCallsAfter).toBeGreaterThan(queueCallsBefore);
      expect(cardCallsAfter).toBeGreaterThan(cardCallsBefore);
    });
  });
});
