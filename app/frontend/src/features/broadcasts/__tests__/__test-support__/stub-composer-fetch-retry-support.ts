import { BROADCAST_DISCLOSURE } from '@wp/domain';

/**
 * stub-composer-fetch-retry-support.ts (P23a C2b hardening pass) - a
 * failure-injecting variant of `stub-composer-fetch.ts` for
 * `use-composer-retry-c2b.test.tsx`: `failNextCreate()`/`failNextStart()`
 * arm a ONE-SHOT 503 on the next matching POST (create-draft / start),
 * consumed on the very next matching request so a subsequent retry
 * succeeds. Every request is still recorded the same way as the sibling
 * stub so idempotency-key assertions bind to the exact wire shape.
 */

export const INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
export const BROADCAST_ID = '11111111-1111-4111-8111-111111111111';
export const TAG_ID = '44444444-4444-4444-8444-444444444444';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function baseCounters(): Record<string, number> {
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
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data: body }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message: 'simulated failure', requestId: 'test-req' } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

const PREFLIGHT_FIXTURE = {
  broadcastId: BROADCAST_ID,
  audience: { matched: 10, skipped: 0, skipReasons: [], sendable: 10 },
  alreadyMessaged: {
    deferred: 0,
    perRecipient24h: 1,
    perRecipient7d: 3,
    note: 'Sending the same audience from another number does not increase how often a person can be messaged — the frequency limit is per workspace.',
  },
  billable: { count: 10, priceKey: 'default', rateMinor: 30, quoteMinor: 300 },
  wallet: { balanceMinor: 5000, afterMinor: 4700, sufficient: true },
  account: {
    instanceId: INSTANCE_ID,
    label: 'Sales team',
    warmupTier: 3,
    effDailyCap: 500,
    sentToday: 50,
    remainingToday: 450,
  },
  estimate: {
    totalDays: 0,
    finishAt: '2026-09-08T12:00:00.000Z',
    caveat: 'This is an estimate, not a guarantee.',
    options: [],
  },
  fanOut: { warnThreshold: 30, ackThreshold: 60, requiresHumanAck: false },
  disclosure: BROADCAST_DISCLOSURE,
};

export function stubComposerFetchWithFailures(requests: RecordedRequest[]): {
  failNextCreate: () => void;
  failNextStart: () => void;
  failNextPreflight: () => void;
  /** Arms the next pre-flight POST to fail with a SPECIFIC status/code (e.g. 402 `ENTITLEMENT_ERROR` = no plan attached). */
  failNextPreflightWith: (status: number, code: string) => void;
} {
  let armCreateFailure = false;
  let armStartFailure = false;
  let armPreflightFailure: { status: number; code: string } | null = null;

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

    if (url.includes('/v1/queue-status')) {
      return jsonResponse({
        instances: [{ instanceId: INSTANCE_ID, waiting: 0, sentToday: 0, failedToday: 0 }],
        workspace: { waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
      });
    }
    if (url.includes(`/v1/instances/${INSTANCE_ID}/card`)) {
      return jsonResponse({
        instanceId: INSTANCE_ID,
        label: 'Sales team',
        warmupTier: 3,
        effDailyCap: 500,
        todaySent: 50,
      });
    }
    if (url.includes('/v1/contacts/tags')) {
      return jsonResponse({
        items: [
          {
            id: TAG_ID,
            name: 'VIP',
            color: null,
            contactCount: 42,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
    }
    if (url.includes('/v1/contacts?')) {
      return jsonResponse({ items: [] });
    }
    if (method === 'POST' && /\/v1\/broadcasts$/.test(url)) {
      if (armCreateFailure) {
        armCreateFailure = false;
        return errorResponse(503, 'INTERNAL');
      }
      return jsonResponse(
        {
          id: BROADCAST_ID,
          name: (body as { name: string }).name,
          status: 'draft',
          instanceId: INSTANCE_ID,
          priority: (body as { priority: string }).priority,
          audienceCount: null,
          quoteMinor: null,
          priceKey: null,
          scheduledAt: null,
          snapshotDoneAt: null,
          expandDoneAt: null,
          cancelReason: null,
          createdAt: '2026-09-06T00:00:00.000Z',
          updatedAt: '2026-09-06T00:00:00.000Z',
          counters: baseCounters(),
          disclosure: BROADCAST_DISCLOSURE,
        },
        201,
      );
    }
    if (method === 'POST' && url.endsWith('/preflight')) {
      if (armPreflightFailure) {
        const failure = armPreflightFailure;
        armPreflightFailure = null;
        return errorResponse(failure.status, failure.code);
      }
      return jsonResponse(PREFLIGHT_FIXTURE);
    }
    if (method === 'POST' && url.endsWith('/start')) {
      if (armStartFailure) {
        armStartFailure = false;
        return errorResponse(503, 'INTERNAL');
      }
      return jsonResponse({
        id: BROADCAST_ID,
        name: 'Launch',
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
        counters: { ...baseCounters(), total: 10, pending: 10 },
        disclosure: BROADCAST_DISCLOSURE,
      });
    }
    if (method === 'POST' && url.endsWith('/cancel')) {
      return jsonResponse({
        id: BROADCAST_ID,
        name: 'Launch',
        status: 'cancelled',
        instanceId: INSTANCE_ID,
        priority: 'low',
        audienceCount: null,
        quoteMinor: null,
        priceKey: null,
        scheduledAt: null,
        snapshotDoneAt: null,
        expandDoneAt: null,
        cancelReason: (body as { reason?: string } | undefined)?.reason ?? null,
        createdAt: '2026-09-06T00:00:00.000Z',
        updatedAt: '2026-09-06T00:00:00.000Z',
        counters: baseCounters(),
        disclosure: BROADCAST_DISCLOSURE,
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = fetchMock as any;

  return {
    failNextCreate: () => {
      armCreateFailure = true;
    },
    failNextStart: () => {
      armStartFailure = true;
    },
    failNextPreflight: () => {
      armPreflightFailure = { status: 500, code: 'INTERNAL' };
    },
    failNextPreflightWith: (status: number, code: string) => {
      armPreflightFailure = { status, code };
    },
  };
}
