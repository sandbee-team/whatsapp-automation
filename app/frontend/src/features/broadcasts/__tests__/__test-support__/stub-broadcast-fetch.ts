import { BROADCAST_DISCLOSURE } from '@wp/domain';
import type { BroadcastStatusContract } from '@wp/contracts';

/**
 * stub-broadcast-fetch.ts (P23a Unit U5) - the list/detail screens' fetch
 * stub and fixtures, split out of `broadcast-list.test.tsx`/`panel-proof.
 * test.tsx` same idiom as `stub-composer-fetch.ts` (core-invariants.md's
 * mandatory split idiom for large fixture bodies). Every request the
 * component issues is recorded (`method`, `url`, `headers`, `body`) so
 * assertions bind to the exact wire shape, never an implementation detail of
 * the hook.
 */

export const BROADCAST_ID = '11111111-1111-4111-8111-111111111111';
export const BROADCAST_ID_2 = '66666666-6666-4666-8666-666666666666';
export const INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(body: unknown, meta?: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ data: body, meta: { requestId: 'r', ...meta } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseCounters(overrides: Partial<Record<string, number>> = {}): Record<string, number> {
  return {
    total: 0,
    pending: 0,
    skipped: 0,
    queued: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    cancelled: 0,
    deferred: 0,
    chargedMinor: 0,
    ...overrides,
  };
}

function summaryFixture(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    status: 'running',
    instanceId: INSTANCE_ID,
    priority: 'low',
    audienceCount: 10,
    quoteMinor: 300,
    priceKey: 'default',
    scheduledAt: null,
    snapshotDoneAt: '2026-09-06T00:00:00.000Z',
    expandDoneAt: '2026-09-06T00:00:00.000Z',
    cancelReason: null,
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  };
}

export interface ListFetchOptions {
  firstNextCursor?: string;
  secondNextCursor?: string;
}

/** Stubs `GET /v1/broadcasts` with two pages: "Launch one" then "Launch two". */
export function stubBroadcastListFetch(
  requests: RecordedRequest[],
  options: ListFetchOptions,
): void {
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
    }
    const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
    requests.push({ method, url, headers, body });

    if (method === 'GET' && url.includes('/v1/broadcasts?')) {
      const isSecondPage = url.includes('cursor=c2');
      if (isSecondPage) {
        return jsonResponse(
          { items: [summaryFixture(BROADCAST_ID_2, 'Launch two')] },
          { nextCursor: options.secondNextCursor },
        );
      }
      return jsonResponse(
        { items: [summaryFixture(BROADCAST_ID, 'Launch one')] },
        { nextCursor: options.firstNextCursor },
      );
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = fetchMock as any;
}

export interface DetailFetchOptions {
  status?: BroadcastStatusContract;
  counters?: Record<string, number>;
  /** One-shot: the next `/cancel` POST returns this status + error body instead of succeeding. */
  failNextCancelWith?: { status: number; code: string };
  /** Stubs `GET /v1/instances/{id}/card`; omit to leave the route unhandled (falls through to id). */
  instanceCardLabel?: string;
}

/** Stubs `GET /v1/broadcasts/{id}` plus pause/resume/cancel mutation routes. */
export function stubBroadcastDetailFetch(
  requests: RecordedRequest[],
  options: DetailFetchOptions,
): void {
  let cancelFailureArmed = Boolean(options.failNextCancelWith);

  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
    }
    const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
    requests.push({ method, url, headers, body });

    const detailFixture = {
      id: BROADCAST_ID,
      name: 'Launch',
      status: options.status ?? 'running',
      instanceId: INSTANCE_ID,
      priority: 'low',
      audienceCount: 10,
      quoteMinor: 300,
      priceKey: 'default',
      scheduledAt: null,
      snapshotDoneAt: '2026-09-06T00:00:00.000Z',
      expandDoneAt: '2026-09-06T00:00:00.000Z',
      cancelReason: null,
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
      counters: baseCounters(options.counters),
      disclosure: BROADCAST_DISCLOSURE,
    };

    if (method === 'GET' && url.includes(`/v1/instances/${INSTANCE_ID}/card`)) {
      return jsonResponse({
        instanceId: INSTANCE_ID,
        label: options.instanceCardLabel ?? 'Sales team',
        warmupTier: 3,
        effDailyCap: 500,
        todaySent: 50,
      });
    }
    if (method === 'GET' && url.endsWith(`/v1/broadcasts/${BROADCAST_ID}`)) {
      return jsonResponse(detailFixture);
    }
    if (method === 'POST' && url.endsWith('/pause')) {
      return jsonResponse({ ...detailFixture, status: 'paused' });
    }
    if (method === 'POST' && url.endsWith('/resume')) {
      return jsonResponse({ ...detailFixture, status: 'running' });
    }
    if (method === 'POST' && url.endsWith('/cancel')) {
      if (cancelFailureArmed && options.failNextCancelWith) {
        cancelFailureArmed = false;
        const { status, code } = options.failNextCancelWith;
        return new Response(
          JSON.stringify({ error: { code, message: 'simulated failure', requestId: 'r' } }),
          { status, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return jsonResponse({
        ...detailFixture,
        status: 'cancelled',
        cancelReason: (body as { reason?: string } | undefined)?.reason ?? null,
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = fetchMock as any;
}
