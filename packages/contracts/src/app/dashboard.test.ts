import { describe, expect, it } from 'vitest';
import { dashboardSummaryOutputSchema } from './dashboard.js';

/**
 * app/dashboard.test.ts (P17 Unit U2) - proves the summary output matches
 * `app/frontend/src/features/dashboard/api.ts`'s `DashboardSummary`
 * interface verbatim: exactly `{connectedNumbers, queued, sent}`, all
 * non-negative integers, `.strict()` rejects an extra field.
 */
describe('dashboardSummaryOutputSchema', () => {
  it('accepts_the_exact_dashboard_summary_shape', () => {
    const result = dashboardSummaryOutputSchema.safeParse({
      data: { connectedNumbers: 3, queued: 12, sent: 480 },
      meta: { requestId: 'req-1' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects_an_unknown_extra_field_on_the_data_object', () => {
    const result = dashboardSummaryOutputSchema.safeParse({
      data: { connectedNumbers: 3, queued: 12, sent: 480, extra: 1 },
      meta: { requestId: 'req-1' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects_a_negative_count', () => {
    const result = dashboardSummaryOutputSchema.safeParse({
      data: { connectedNumbers: -1, queued: 12, sent: 480 },
      meta: { requestId: 'req-1' },
    });
    expect(result.success).toBe(false);
  });
});
