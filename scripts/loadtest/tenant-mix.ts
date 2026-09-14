/**
 * tenant-mix.ts (P26 U2b) - the PURE mix loader/validator/expander shared by
 * BOTH load drivers (the Node driver, `engine/measure/send-load-driver.ts`,
 * and the k6 script, `send-load.k6.mjs`, which loads the SAME `tenant-mix.json`
 * via k6's `open()` + `JSON.parse` at init - no code sharing is possible
 * across the JS/k6 boundary, so this module's job is to be the ONE place the
 * shape and the expansion math are defined and tested; the k6 script re-
 * implements nothing beyond reading the same file).
 *
 * SHAPE (ADR 0018 §7's "realistic multi-tenant mix"): `tenants` lists
 * WEIGHTED CLASSES, not a literal instance count - `expandTenantMix` grows
 * each class round-robin by its own `weight` until the caller's
 * `targetInstances` is reached, so the SAME mix file expresses a 50-instance
 * smoke run and a 1,000-instance fleet run without editing the file. Field
 * meanings:
 *   - `schemaVersion`: fixed at 1 (JSON has no comments - this file is
 *     the only place the shape is documented).
 *   - `description`: free-text, never parsed.
 *   - `tenants[].key`: stable identifier for this class (e.g. "heavy",
 *     "medium", "small") - used as `ExpandedTenant.classKey` and as the k6
 *     scenario/tag name, so per-tenant-class latency stays separable.
 *   - `tenants[].weight`: relative growth rate during expansion (see
 *     `expandTenantMix`) - NOT a fraction of total instances; a class with
 *     weight 40 grows 40x faster per round than a class with weight 1.
 *   - `tenants[].instances`: the BASE instance count for this class before
 *     expansion (what a `targetInstances` equal to the file's own base sum
 *     yields) - also the minimum this class contributes even if
 *     `expandTenantMix` is called with a `targetInstances` smaller than the
 *     base sum (truncation only ever shrinks the LAST class touched in the
 *     final round, never a class's base allocation below what the file
 *     itself already lists... in practice this harness is only ever called
 *     with `targetInstances >= sum(base instances)`, see the test file).
 *   - `tenants[].sendsPerDayPerInstance`: steady-state send volume for ONE
 *     instance of this class - the input to `perInstanceIntervalMs`.
 *   - `burstTenant`: an OPTIONAL single extra tenant that fires one burst of
 *     `recipients` sends for its `instances` starting at `startAtSeconds`
 *     into the run - modeled separately from the steady classes above
 *     because a burst is a one-shot event, not a steady rate.
 */

export interface TenantClass {
  key: string;
  weight: number;
  instances: number;
  sendsPerDayPerInstance: number;
}

export interface BurstSpec {
  key: string;
  instances: number;
  recipients: number;
  startAtSeconds: number;
}

export interface TenantMixSpec {
  schemaVersion: 1;
  description: string;
  tenants: TenantClass[];
  burstTenant?: BurstSpec;
}

export interface ExpandedTenant {
  key: string;
  classKey: string;
  instances: number;
  sendsPerDayPerInstance: number;
}

export interface ExpandTenantMixResult {
  tenants: ExpandedTenant[];
  totalInstances: number;
  truncated: boolean;
}

export class InvalidTenantMixError extends Error {
  constructor(message: string) {
    super(`invalid tenant mix: ${message}`);
    this.name = 'InvalidTenantMixError';
  }
}

const SECONDS_PER_DAY = 86_400;
const MS_PER_DAY = 86_400_000;

/** Parses+validates an unknown value into a `TenantMixSpec` - throws `InvalidTenantMixError` naming the offending field on any violation. Never mutates `input`. */
export function parseTenantMix(input: unknown): TenantMixSpec {
  if (typeof input !== 'object' || input === null) {
    throw new InvalidTenantMixError('root: expected an object');
  }
  const raw = input as Record<string, unknown>;

  if (raw.schemaVersion !== 1) {
    throw new InvalidTenantMixError(`schemaVersion: expected 1, got ${String(raw.schemaVersion)}`);
  }
  if (typeof raw.description !== 'string') {
    throw new InvalidTenantMixError('description: expected a string');
  }
  if (!Array.isArray(raw.tenants) || raw.tenants.length === 0) {
    throw new InvalidTenantMixError('tenants: expected a non-empty array');
  }

  const seenKeys = new Set<string>();
  const tenants: TenantClass[] = raw.tenants.map((item, index) => {
    const cls = parseTenantClass(item, index);
    if (seenKeys.has(cls.key)) {
      throw new InvalidTenantMixError(`tenants[${String(index)}].key: duplicate key "${cls.key}"`);
    }
    seenKeys.add(cls.key);
    return cls;
  });

  const burstTenant =
    raw.burstTenant === undefined ? undefined : parseBurstSpec(raw.burstTenant, seenKeys);

  return { schemaVersion: 1, description: raw.description, tenants, burstTenant };
}

function parseTenantClass(item: unknown, index: number): TenantClass {
  if (typeof item !== 'object' || item === null) {
    throw new InvalidTenantMixError(`tenants[${String(index)}]: expected an object`);
  }
  const cls = item as Record<string, unknown>;
  if (typeof cls.key !== 'string' || cls.key.length === 0) {
    throw new InvalidTenantMixError(`tenants[${String(index)}].key: expected a non-empty string`);
  }
  if (typeof cls.weight !== 'number' || !(cls.weight > 0)) {
    throw new InvalidTenantMixError(
      `tenants[${String(index)}].weight: expected a positive number, got ${String(cls.weight)}`,
    );
  }
  if (typeof cls.instances !== 'number' || !Number.isInteger(cls.instances) || cls.instances < 0) {
    throw new InvalidTenantMixError(
      `tenants[${String(index)}].instances: expected a non-negative integer, got ${String(cls.instances)}`,
    );
  }
  if (typeof cls.sendsPerDayPerInstance !== 'number' || !(cls.sendsPerDayPerInstance > 0)) {
    throw new InvalidTenantMixError(
      `tenants[${String(index)}].sendsPerDayPerInstance: expected a positive number, got ` +
        `${String(cls.sendsPerDayPerInstance)}`,
    );
  }
  return {
    key: cls.key,
    weight: cls.weight,
    instances: cls.instances,
    sendsPerDayPerInstance: cls.sendsPerDayPerInstance,
  };
}

function parseBurstSpec(item: unknown, tenantKeys: Set<string>): BurstSpec {
  if (typeof item !== 'object' || item === null) {
    throw new InvalidTenantMixError('burstTenant: expected an object');
  }
  const burst = item as Record<string, unknown>;
  if (typeof burst.key !== 'string' || burst.key.length === 0) {
    throw new InvalidTenantMixError('burstTenant.key: expected a non-empty string');
  }
  if (tenantKeys.has(burst.key)) {
    throw new InvalidTenantMixError(`burstTenant.key: duplicate key "${burst.key}"`);
  }
  if (
    typeof burst.instances !== 'number' ||
    !Number.isInteger(burst.instances) ||
    burst.instances <= 0
  ) {
    throw new InvalidTenantMixError(
      `burstTenant.instances: expected a positive integer, got ${String(burst.instances)}`,
    );
  }
  if (
    typeof burst.recipients !== 'number' ||
    !Number.isInteger(burst.recipients) ||
    burst.recipients <= 0
  ) {
    throw new InvalidTenantMixError(
      `burstTenant.recipients: expected a positive integer, got ${String(burst.recipients)}`,
    );
  }
  if (typeof burst.startAtSeconds !== 'number' || burst.startAtSeconds < 0) {
    throw new InvalidTenantMixError(
      `burstTenant.startAtSeconds: expected a non-negative number, got ` +
        `${String(burst.startAtSeconds)}`,
    );
  }
  return {
    key: burst.key,
    instances: burst.instances,
    recipients: burst.recipients,
    startAtSeconds: burst.startAtSeconds,
  };
}

/**
 * Expands `spec.tenants` to exactly `targetInstances` total instances by
 * round-robin growth: repeatedly walk the tenant list in order, adding each
 * tenant's own `weight` (rounded to the nearest integer, minimum 1) to its
 * running instance count, until the running total would reach or exceed
 * `targetInstances`. The FINAL addition that would overshoot is truncated to
 * land exactly on `targetInstances` (never silently over/under) and
 * `truncated: true` is reported whenever any truncation happened (including
 * the degenerate case where the base sum already exceeds the target, which
 * this harness never calls with in practice - see the module doc).
 */
export function expandTenantMix(
  spec: TenantMixSpec,
  targetInstances: number,
): ExpandTenantMixResult {
  if (!Number.isInteger(targetInstances) || targetInstances < 0) {
    throw new InvalidTenantMixError(
      `targetInstances: expected a non-negative integer, got ${String(targetInstances)}`,
    );
  }

  const counts = new Map<string, number>(spec.tenants.map((t) => [t.key, t.instances]));
  let total = spec.tenants.reduce((sum, t) => sum + t.instances, 0);
  let truncated = false;

  while (total < targetInstances) {
    for (const cls of spec.tenants) {
      if (total >= targetInstances) break;
      const step = Math.max(1, Math.round(cls.weight));
      const remaining = targetInstances - total;
      const applied = Math.min(step, remaining);
      if (applied < step) truncated = true;
      counts.set(cls.key, (counts.get(cls.key) ?? 0) + applied);
      total += applied;
    }
  }
  if (total > targetInstances) truncated = true;

  const tenants: ExpandedTenant[] = spec.tenants.map((cls) => ({
    key: cls.key,
    classKey: cls.key,
    instances: counts.get(cls.key) ?? 0,
    sendsPerDayPerInstance: cls.sendsPerDayPerInstance,
  }));

  return { tenants, totalInstances: total, truncated };
}

/** Sum over every expanded tenant of `instances * sendsPerDayPerInstance`, divided by seconds-per-day - the mix's DERIVED steady-state aggregate send rate, never a hand-picked constant. */
export function sendRatePerSecond(tenants: readonly ExpandedTenant[]): number {
  const totalPerDay = tenants.reduce((sum, t) => sum + t.instances * t.sendsPerDayPerInstance, 0);
  return totalPerDay / SECONDS_PER_DAY;
}

/** The steady-state gap, in milliseconds, between two sends from the SAME instance at `sendsPerDayPerInstance` sends/day. */
export function perInstanceIntervalMs(sendsPerDayPerInstance: number): number {
  return MS_PER_DAY / sendsPerDayPerInstance;
}

/**
 * The INSTANCE-weighted mean `sendsPerDayPerInstance` over an already-
 * expanded mix: `sum(instances * sendsPerDayPerInstance) / sum(instances)`.
 * This is a tenant-BEHAVIOUR input (what the mix says a connected instance
 * sends per day), never something a synthetic run measures - callers that
 * feed a load-model projection with a per-instance send rate derive it here
 * rather than hand-picking a class's own figure (P26 C1 MAJOR 4: a bare
 * `600` read as a measured fact when it was really the "heavy" class's own
 * literal, unweighted by the other two classes actually seeded).
 */
export function weightedMeanSendsPerDayPerInstance(tenants: readonly ExpandedTenant[]): number {
  const totalInstances = tenants.reduce((sum, t) => sum + t.instances, 0);
  if (totalInstances === 0) {
    throw new InvalidTenantMixError(
      'weightedMeanSendsPerDayPerInstance: the expanded mix has zero instances - nothing to average',
    );
  }
  const totalPerDay = tenants.reduce((sum, t) => sum + t.instances * t.sendsPerDayPerInstance, 0);
  return totalPerDay / totalInstances;
}
