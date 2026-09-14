import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expandTenantMix,
  InvalidTenantMixError,
  parseTenantMix,
  perInstanceIntervalMs,
  sendRatePerSecond,
  weightedMeanSendsPerDayPerInstance,
  type ExpandedTenant,
  type TenantMixSpec,
} from './tenant-mix.js';

/**
 * tenant-mix.test.ts (P26 U2b) - the pure mix loader/validator/expander's
 * own test file. See `tenant-mix.ts`'s module doc for the field meanings
 * this file exercises.
 */

const SHIPPED_MIX: TenantMixSpec = {
  schemaVersion: 1,
  description: 'test mix',
  tenants: [
    { key: 'heavy', weight: 1, instances: 20, sendsPerDayPerInstance: 600 },
    { key: 'medium', weight: 8, instances: 5, sendsPerDayPerInstance: 300 },
    { key: 'small', weight: 40, instances: 1, sendsPerDayPerInstance: 120 },
  ],
};

describe('tenant-mix', () => {
  it('the_mix_expands_to_exactly_the_requested_instance_count', () => {
    const result = expandTenantMix(SHIPPED_MIX, 1000);

    expect(result.totalInstances).toBe(1000);
    expect(result.truncated).toBe(true);
    for (const tenant of result.tenants) {
      expect(tenant.instances).toBeGreaterThan(0);
    }
    // Exact per-class counts from the round-robin-by-weight expansion
    // (weights 1/8/40 summing to 49 per round; 20 full rounds = 980, the
    // 21st round adds heavy+1=21/medium+8=168 then truncates small's +40
    // step to +11 so the total lands exactly on 1000 - see tenant-mix.ts's
    // module doc for the algorithm).
    const byKey = new Map(result.tenants.map((t) => [t.key, t.instances]));
    expect(byKey.get('heavy')).toBe(40);
    expect(byKey.get('medium')).toBe(165);
    expect(byKey.get('small')).toBe(795);
  });

  it('a_mix_that_cannot_be_expanded_is_rejected_by_name', () => {
    expect(() => parseTenantMix({ schemaVersion: 1, description: 'x', tenants: [] })).toThrow(
      InvalidTenantMixError,
    );
    expect(() => parseTenantMix({ schemaVersion: 1, description: 'x', tenants: [] })).toThrow(
      /tenants/,
    );

    const duplicateKey = {
      schemaVersion: 1,
      description: 'x',
      tenants: [
        { key: 'a', weight: 1, instances: 1, sendsPerDayPerInstance: 100 },
        { key: 'a', weight: 1, instances: 1, sendsPerDayPerInstance: 100 },
      ],
    };
    expect(() => parseTenantMix(duplicateKey)).toThrow(InvalidTenantMixError);
    expect(() => parseTenantMix(duplicateKey)).toThrow(/duplicate key/);

    const zeroWeight = {
      schemaVersion: 1,
      description: 'x',
      tenants: [{ key: 'a', weight: 0, instances: 1, sendsPerDayPerInstance: 100 }],
    };
    expect(() => parseTenantMix(zeroWeight)).toThrow(InvalidTenantMixError);
    expect(() => parseTenantMix(zeroWeight)).toThrow(/weight/);

    const negativeSendsPerDay = {
      schemaVersion: 1,
      description: 'x',
      tenants: [{ key: 'a', weight: 1, instances: 1, sendsPerDayPerInstance: -5 }],
    };
    expect(() => parseTenantMix(negativeSendsPerDay)).toThrow(InvalidTenantMixError);
    expect(() => parseTenantMix(negativeSendsPerDay)).toThrow(/sendsPerDayPerInstance/);
  });

  it('send_rate_is_derived_from_the_mix_not_a_constant', () => {
    const tenants: ExpandedTenant[] = [
      { key: 'a', classKey: 'a', instances: 3, sendsPerDayPerInstance: 600 },
      { key: 'b', classKey: 'b', instances: 2, sendsPerDayPerInstance: 300 },
    ];
    // (3*600 + 2*300) / 86400 = 2400 / 86400 exactly.
    expect(sendRatePerSecond(tenants)).toBe(2400 / 86400);
    expect(perInstanceIntervalMs(600)).toBe(144000);
  });

  it('weighted_mean_sends_per_day_is_the_instance_weighted_average_over_the_expanded_mix', () => {
    const tenants: ExpandedTenant[] = [
      { key: 'a', classKey: 'a', instances: 3, sendsPerDayPerInstance: 600 },
      { key: 'b', classKey: 'b', instances: 2, sendsPerDayPerInstance: 300 },
      { key: 'c', classKey: 'c', instances: 5, sendsPerDayPerInstance: 120 },
    ];
    // (3*600 + 2*300 + 5*120) / (3+2+5) = (1800+600+600)/10 = 300 exactly.
    expect(weightedMeanSendsPerDayPerInstance(tenants)).toBe(300);
  });

  it('weighted_mean_sends_per_day_throws_a_named_error_on_zero_instances', () => {
    expect(() => weightedMeanSendsPerDayPerInstance([])).toThrow(InvalidTenantMixError);
    expect(() => weightedMeanSendsPerDayPerInstance([])).toThrow(/zero instances/);
  });

  it('the_shipped_tenant_mix_json_parses', () => {
    const raw = readFileSync(resolve(import.meta.dirname, 'tenant-mix.json'), 'utf8');
    const parsed = parseTenantMix(JSON.parse(raw));
    expect(parsed.tenants.length).toBe(3);
    expect(parsed.burstTenant?.key).toBe('burst');
  });
});
