// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@wp/ui';
import { DashboardKpiRow } from '../components/dashboard-kpi-row.js';

/**
 * dashboard-kpi-row-icons.test.tsx (P26b C1 fix round MINOR-14) - the "sent"
 * KPI tile previously used `AlertTriangle` (a warning icon on a neutral
 * count). Lucide icons render an SVG with a `lucide lucide-<name>` class
 * (see `lucide-react`'s own `buildLucideIconNode`), so this asserts on that
 * class directly rather than a screenshot.
 */
describe('DashboardKpiRow icons', () => {
  afterEach(() => {
    cleanup();
  });

  it('the_sent_tile_never_uses_the_alert_triangle_icon', () => {
    render(
      <I18nProvider locale="en">
        <DashboardKpiRow
          summary={{ connectedNumbers: 1, queued: 2, sent: 3 }}
          queueStatus={undefined}
          isLoading={false}
          needsActionCount={0}
          walletBalanceMinor={undefined}
        />
      </I18nProvider>,
    );

    const sentTile = screen.getByTestId('stat-sent');
    const svg = sentTile.querySelector('svg');
    expect(svg?.getAttribute('class')).not.toContain('lucide-alert-triangle');
  });

  it('the_sent_tile_uses_a_send_or_check_check_icon', () => {
    render(
      <I18nProvider locale="en">
        <DashboardKpiRow
          summary={{ connectedNumbers: 1, queued: 2, sent: 3 }}
          queueStatus={undefined}
          isLoading={false}
          needsActionCount={0}
          walletBalanceMinor={undefined}
        />
      </I18nProvider>,
    );

    const sentTile = screen.getByTestId('stat-sent');
    const svg = sentTile.querySelector('svg');
    const classAttr = svg?.getAttribute('class') ?? '';
    const usesExpectedIcon =
      classAttr.includes('lucide-send') || classAttr.includes('lucide-check-check');
    expect(usesExpectedIcon).toBe(true);
  });
});
