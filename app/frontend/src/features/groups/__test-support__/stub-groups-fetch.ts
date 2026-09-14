/**
 * stub-groups-fetch.ts (P24 groups-messaging, Unit U5) - the groups list
 * test's fetch stub and fixtures, split out of `group-list.test.tsx` (same
 * split idiom as `stub-broadcast-fetch.ts`/`stub-composer-fetch.ts` -
 * core-invariants.md's mandatory split idiom for large fixture bodies).
 * Every request the component issues is recorded (`method`, `url`,
 * `headers`, `body`) so assertions bind to the exact wire shape.
 */

export const INSTANCE_ID = '77777777-7777-4777-8777-777777777777';
export const GROUP_ID = '88888888-8888-4888-8888-888888888888';
export const GROUP_ID_2 = '99999999-9999-4999-8999-999999999999';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface GroupFixtureOverrides {
  sendEnabled?: boolean;
  eligibilitySendable?: boolean;
  eligibilityReason?: string | null;
  disabledReason?: string | null;
  leaveRequestedAt?: string | null;
  participantCount?: number | null;
  trackedParticipantDevices?: number;
}

export function groupFixture(id: string, overrides: GroupFixtureOverrides = {}): unknown {
  return {
    id,
    instanceId: INSTANCE_ID,
    subject: 'Sales team chat',
    participantCount: overrides.participantCount ?? 250,
    isAnnounce: false,
    ourRole: 'member',
    sendEnabled: overrides.sendEnabled ?? false,
    sendEnabledAt: null,
    disabledReason: overrides.disabledReason ?? null,
    trackedParticipantDevices: overrides.trackedParticipantDevices ?? 12,
    lastSyncedAt: '2026-09-05T00:00:00.000Z',
    lastMessageAt: null,
    leaveRequestedAt: overrides.leaveRequestedAt ?? null,
    eligibility: {
      sendable: overrides.eligibilitySendable ?? true,
      reason: overrides.eligibilityReason ?? null,
    },
  };
}

export interface ListFixtureOptions {
  groups?: unknown[];
  effGroupDailyCap?: number;
  sentToday?: number;
  remainingToday?: number;
  warmupTier?: number;
  healthBand?: string;
  trackedDevicesEnabledTotal?: number;
  budgetMax?: number;
  lastSyncedAt?: string | null;
  nextSyncAfter?: string | null;
}

function listFixture(options: ListFixtureOptions): unknown {
  return {
    items: options.groups ?? [groupFixture(GROUP_ID)],
    nextCursor: undefined,
    budget: {
      trackedDevicesEnabledTotal: options.trackedDevicesEnabledTotal ?? 12,
      max: options.budgetMax ?? 2000,
    },
    groupCap: {
      warmupTier: options.warmupTier ?? 3,
      healthBand: options.healthBand ?? 'healthy',
      effGroupDailyCap: options.effGroupDailyCap ?? 50,
      sentToday: options.sentToday ?? 5,
      remainingToday: options.remainingToday ?? 45,
    },
    sync: {
      lastSyncedAt: options.lastSyncedAt ?? '2026-09-05T00:00:00.000Z',
      nextSyncAfter: options.nextSyncAfter ?? null,
      requestedAt: null,
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ data: body, meta: {} }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function errorResponse(status: number, code: string, details?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ error: { code, message: 'simulated failure', requestId: 'r', details } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

export interface StubGroupsFetchOptions extends ListFixtureOptions {
  /** One-shot: the next `PATCH .../send-enabled` returns this 422 instead of succeeding. */
  failNextEnableWith?: { reason: string; trackedDevicesEnabledTotal?: number; max?: number };
  /** One-shot: the next `POST .../sync` returns 429 RATE_LIMITED. */
  failNextSyncWithRateLimit?: boolean;
}

/** Stubs `GET /v1/instances/{id}/groups` plus the sync/send-enabled/leave mutation routes. */
export function stubGroupsFetch(
  requests: RecordedRequest[],
  options: StubGroupsFetchOptions = {},
): void {
  let enableFailureArmed = Boolean(options.failNextEnableWith);
  let syncFailureArmed = Boolean(options.failNextSyncWithRateLimit);

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
        warmupTier: options.warmupTier ?? 3,
        effDailyCap: 500,
        todaySent: 50,
      });
    }
    if (method === 'GET' && url.includes(`/v1/instances/${INSTANCE_ID}/groups?`)) {
      return jsonResponse(listFixture(options));
    }
    if (method === 'POST' && url.endsWith('/groups/sync')) {
      if (syncFailureArmed) {
        syncFailureArmed = false;
        return errorResponse(429, 'RATE_LIMITED');
      }
      return jsonResponse({ requestedAt: '2026-09-06T01:00:00.000Z', nextSyncAfter: null }, 202);
    }
    if (method === 'PATCH' && url.endsWith('/send-enabled')) {
      if (enableFailureArmed && options.failNextEnableWith) {
        enableFailureArmed = false;
        const { reason, trackedDevicesEnabledTotal, max } = options.failNextEnableWith;
        return errorResponse(422, 'GROUP_NOT_SENDABLE', {
          reason,
          trackedDevicesEnabledTotal,
          groupTrackedDevices: 12,
          max,
        });
      }
      const sendEnabled = (body as { sendEnabled: boolean }).sendEnabled;
      return jsonResponse(groupFixture(GROUP_ID, { sendEnabled }));
    }
    if (method === 'POST' && url.endsWith('/leave')) {
      return jsonResponse({ leaveRequestedAt: '2026-09-06T02:00:00.000Z' }, 202);
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = fetchMock as any;
}
