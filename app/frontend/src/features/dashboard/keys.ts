/**
 * features/dashboard/keys.ts - query key factory only. `summary()` is the
 * target of two different SSE invalidations (`instance.health_changed`,
 * `message.job.status_changed`) even though there is no
 * `GET /v1/dashboard/summary` endpoint yet (P17 wires it) - the key exists
 * now so those invalidations already target the right cache entry.
 */
export const dashboardKeys = {
  summary: () => ['dashboard', 'summary'] as const,
};
