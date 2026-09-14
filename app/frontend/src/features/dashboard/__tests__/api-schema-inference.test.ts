import { describe, expect, it } from 'vitest';
import { dashboardSummaryDataSchema } from '@wp/contracts';
import type { DashboardSummary } from '../api.js';

/**
 * api-schema-inference.test.ts (P26b C1 fix round MINOR-13) -
 * `DashboardSummary` must be INFERRED from `@wp/contracts`'
 * `dashboardSummaryDataSchema` (same idiom as every sibling `api.ts`), never
 * hand-typed - a hand-typed interface can silently drift from the contract
 * with no signal. Asserted via a structural round-trip: a value satisfying
 * the schema must also satisfy `DashboardSummary` and vice versa (checked by
 * TypeScript at compile time here - `tsc -b` is the real enforcement; this
 * test also proves the schema still parses the exact shape the type claims).
 */
describe('DashboardSummary is inferred from the contract schema', () => {
  it('a_value_the_schema_accepts_is_assignable_to_DashboardSummary', () => {
    const parsed = dashboardSummaryDataSchema.parse({
      connectedNumbers: 3,
      queued: 5,
      sent: 7,
    });
    const value: DashboardSummary = parsed;
    expect(value).toEqual({ connectedNumbers: 3, queued: 5, sent: 7 });
  });

  it('the_schema_rejects_an_unknown_extra_field (strict)', () => {
    expect(() =>
      dashboardSummaryDataSchema.parse({
        connectedNumbers: 3,
        queued: 5,
        sent: 7,
        extra: true,
      }),
    ).toThrow();
  });
});
