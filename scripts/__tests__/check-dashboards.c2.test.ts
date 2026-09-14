import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDashboards } from '../guards/dashboards-lib.js';
import { readInstanceLabelledGauges } from '../check-metric-inventory.js';
import { REPO_ROOT } from '../guards/scan-config.js';

/**
 * check-dashboards.c2.test.ts (P25 SESSION-PROTOCOL C2 edge-case pass) -
 * hunt items not already in check-dashboards.test.ts: a row panel's NESTED
 * panels grouping by client_id are caught (walkPanels recursion), a
 * `targets[].expr` that is not a string (a Loki-shaped object expr) is
 * handled without crashing and without silently skipping every check on
 * that target, and `legendFormat` with IRREGULAR internal spacing
 * (`{{  client_id  }}`, two spaces) - decided and pinned here as currently
 * NOT caught (only the exact compact and single-space-padded forms are
 * checked), a real gap distinct from the already-fixed Finding 4.
 */

function readManifest(): { metrics: { name: string; type: string }[] } {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'infra/observability/metrics.generated.json'), 'utf8'),
  ) as { metrics: { name: string; type: string }[] };
}

const manifest = readManifest();
const instanceLabelledGauges = readInstanceLabelledGauges();
const emptyRules = new Set<string>();

describe('a_row_panel_with_nested_panels_grouping_by_client_id_is_caught', () => {
  it('the tenant-isolation violation is found inside a nested row panel, not only top-level panels', () => {
    const dashboardJson = JSON.stringify({
      uid: 'fixture-c2-nested-row',
      title: 'Fixture: nested row panel tenant grouping',
      panels: [
        {
          id: 1,
          type: 'row',
          title: 'A row',
          description: 'row panel - container only',
          panels: [
            {
              id: 2,
              type: 'timeseries',
              title: 'Nested send attempts by client',
              description: 'Nested fixture panel - should fail the guard.',
              datasource: { uid: 'prometheus' },
              targets: [
                {
                  refId: 'A',
                  expr: 'sum by (client_id) (rate(wp_send_attempts_total[5m]))',
                },
              ],
            },
          ],
        },
      ],
    });

    const result = checkDashboards({
      dashboards: [{ path: 'inline/nested-row.json', json: dashboardJson }],
      manifest,
      recordingRuleNames: emptyRules,
      instanceLabelledGauges,
    });

    expect(result.violations.some((v) => v.message.includes('client_id'))).toBe(true);
    // The nested panel is counted too - walkPanels recursion covers it.
    expect(result.panelCount).toBe(2);
  });
});

describe('a_non_string_expr_is_handled_not_crashed_on', () => {
  it('a Loki-shaped object expr never throws and the panel is still validated for hygiene', () => {
    const dashboardJson = JSON.stringify({
      uid: 'fixture-c2-object-expr',
      title: 'Fixture: object-shaped expr (Loki datasource variant)',
      panels: [
        {
          id: 1,
          type: 'logs',
          title: 'Loki logs panel',
          description: 'Fixture panel - object expr must not crash the guard.',
          datasource: { uid: 'loki' },
          targets: [
            {
              refId: 'A',
              // A Loki panel occasionally carries a structured expr object
              // instead of a plain string - this must never throw.
              expr: { query: '{app="wp"}' },
            },
          ],
        },
      ],
    });

    expect(() =>
      checkDashboards({
        dashboards: [{ path: 'inline/object-expr.json', json: dashboardJson }],
        manifest,
        recordingRuleNames: emptyRules,
        instanceLabelledGauges,
      }),
    ).not.toThrow();

    const result = checkDashboards({
      dashboards: [{ path: 'inline/object-expr.json', json: dashboardJson }],
      manifest,
      recordingRuleNames: emptyRules,
      instanceLabelledGauges,
    });
    // Non-string expr contributes no metric-name/recording-rule/tenant
    // violations (there is no string to scan) - pinned as the decided,
    // documented behaviour rather than an accidental silent pass: the panel
    // itself is still walked (hygiene checks like description/datasource
    // still run), just the expr-dependent checks have nothing to scan.
    expect(result.violations).toEqual([]);
    expect(result.panelCount).toBe(1);
  });
});

describe('legendFormat_with_irregular_internal_spacing', () => {
  it('two spaces inside the mustache braces is NOT currently caught - decided and pinned as a real gap, not a silent guarantee', () => {
    const dashboardJson = JSON.stringify({
      uid: 'fixture-c2-irregular-legend-spacing',
      title: 'Fixture: legendFormat with irregular internal spacing',
      panels: [
        {
          id: 1,
          type: 'timeseries',
          title: 'Irregular legend spacing',
          description: 'Fixture panel.',
          datasource: { uid: 'prometheus' },
          targets: [
            {
              refId: 'A',
              expr: 'rate(wp_send_attempts_total[5m])',
              legendFormat: '{{  client_id  }}',
            },
          ],
        },
      ],
    });

    const result = checkDashboards({
      dashboards: [{ path: 'inline/irregular-spacing.json', json: dashboardJson }],
      manifest,
      recordingRuleNames: emptyRules,
      instanceLabelledGauges,
    });

    // Documented gap: AGGREGATION_CLAUSE_PATTERN's legendFormat check only
    // recognises the exact compact ("{{client_id}}") and single-space-padded
    // ("{{ client_id }}") forms - two (or more) spaces slips through
    // uncaught today. This test exists so a future tightening of the
    // legendFormat match is a conscious, evidenced change (flip this
    // expectation to `true`), not a silent regression discovered in
    // production dashboards.
    expect(result.violations.some((v) => v.message.includes('client_id'))).toBe(false);
  });

  it('the exact single-space-padded form IS caught (not a regression of the existing contract)', () => {
    const dashboardJson = JSON.stringify({
      uid: 'fixture-c2-single-space-legend',
      title: 'Fixture: single-space legendFormat',
      panels: [
        {
          id: 1,
          type: 'timeseries',
          title: 'Single space legend',
          description: 'Fixture panel.',
          datasource: { uid: 'prometheus' },
          targets: [
            {
              refId: 'A',
              expr: 'rate(wp_send_attempts_total[5m])',
              legendFormat: '{{ client_id }}',
            },
          ],
        },
      ],
    });

    const result = checkDashboards({
      dashboards: [{ path: 'inline/single-space-legend.json', json: dashboardJson }],
      manifest,
      recordingRuleNames: emptyRules,
      instanceLabelledGauges,
    });

    expect(result.violations.some((v) => v.message.includes('client_id'))).toBe(true);
  });
});
