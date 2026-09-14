/**
 * features/instances/keys.ts - query key factory only (no fetching yet -
 * P08 wires the real `features/instances/api.ts`). Exact key shapes matter:
 * `lib/sse.ts`'s static invalidation map calls `invalidateQueries({
 * queryKey })` with these exact arrays, so `instance.health_changed` must
 * invalidate `qk.instances.detail(id)` WITHOUT also touching
 * `qk.instances.qr(id)` or `qk.instances.pacing(id)` (canon: scoped
 * invalidation, never a same-prefix catch-all).
 *
 * `card(instanceId)` (P17 U5) is the second target `instance.health_changed`
 * invalidates, alongside `detail(id)` - the per-instance card surface needs
 * its own scoped key so a health-change push refreshes the card without
 * touching `qr`/`pacing`.
 */
export const instanceKeys = {
  all: ['instances'] as const,
  detail: (instanceId: string) => ['instances', 'detail', instanceId] as const,
  qr: (instanceId: string) => ['instances', 'qr', instanceId] as const,
  pacing: (instanceId: string) => ['instances', 'pacing', instanceId] as const,
  card: (instanceId: string) => ['instances', 'card', instanceId] as const,
  healthWhy: (instanceId: string) => ['instances', 'health-why', instanceId] as const,
};
