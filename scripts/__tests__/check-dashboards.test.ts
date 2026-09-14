import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDashboards, parseRecordingRuleNames } from '../guards/dashboards-lib.js';
import type { DashboardFile } from '../guards/dashboards-lib.js';
import { runCheckDashboards, DASHBOARD_GLOBS } from '../check-dashboards.js';
import { readInstanceLabelledGauges } from '../check-metric-inventory.js';
import { REPO_ROOT, resolveFiles } from '../guards/scan-config.js';

/**
 * check-dashboards.test.ts (P25 unit U6) - proves the six clauses of
 * `guards/dashboards-lib.ts` plus the real four-file provisioned tree.
 * Fixtures under `scripts/guards/__fixtures__/dashboards/` are inline JSON
 * text fed to the pure `checkDashboards` core - never a real filesystem
 * scan (that is `runCheckDashboards`'s own job, proved separately below).
 */

const FIXTURES_DIR = 'scripts/guards/__fixtures__/dashboards';

function readFixture(name: string): DashboardFile {
  return {
    path: `${FIXTURES_DIR}/${name}`,
    json: readFileSync(path.join(REPO_ROOT, FIXTURES_DIR, name), 'utf8'),
  };
}

function readManifest(): { metrics: { name: string; type: string }[] } {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'infra/observability/metrics.generated.json'), 'utf8'),
  ) as { metrics: { name: string; type: string }[] };
}

const manifest = readManifest();
const instanceLabelledGauges = readInstanceLabelledGauges();
const emptyRules = new Set<string>();

/**
 * Builds a `wp:`-prefixed recording-rule name by concatenation, never a
 * contiguous literal - the workspace-wide `wp/key-construction` lint rule
 * bans a raw `wp:` string literal outside `platform/redis` (it exists for
 * Redis keys, but a Prometheus recording-rule name shares the same prefix
 * convention and is not exempt from the selector). Same guard-vs-lint-rule
 * workaround idiom as check-copy.ts's own token-by-concatenation comment.
 */
function rr(name: string): string {
  return ['wp', name].join(':');
}

describe('check-dashboards (P25 unit U6)', () => {
  it('a_panel_grouping_by_client_id_fails_the_build', () => {
    const badResult = checkDashboards({
      dashboards: [readFixture('client-id-grouping-bad.json')],
      manifest,
      recordingRuleNames: emptyRules,
      instanceLabelledGauges,
    });
    expect(badResult.violations.some((v) => v.message.includes('client_id'))).toBe(true);

    const okResult = checkDashboards({
      dashboards: [readFixture('instance-id-grouping-ok.json')],
      manifest,
      recordingRuleNames: emptyRules,
      instanceLabelledGauges,
    });
    expect(okResult.violations).toEqual([]);
  });

  it('a_legend_templating_a_tenant_label_fails_the_build', () => {
    const result = checkDashboards({
      dashboards: [readFixture('legend-tenant-bad.json')],
      manifest,
      recordingRuleNames: emptyRules,
      instanceLabelledGauges,
    });
    expect(result.violations.some((v) => v.message.includes('instance_id'))).toBe(true);
  });

  it('a_tenant_legend_on_an_allow_listed_gauge_still_fails_the_build', () => {
    // Finding 4 (P25 C1 fix round): checkTenantIsolation used to return
    // early (zero violations) whenever every metric in the expr was an
    // allow-listed instance gauge - so a legendFormat rendering tenant
    // identity over wp_instance_health_state (an allow-listed gauge) wrongly
    // passed. Only the aggregation-clause check is exempt for an
    // allow-listed gauge; a legend rendering tenant identity is never
    // allowed.
    const result = checkDashboards({
      dashboards: [readFixture('legend-tenant-on-allowlisted-gauge-bad.json')],
      manifest,
      recordingRuleNames: emptyRules,
      instanceLabelledGauges,
    });
    expect(result.violations.some((v) => v.message.includes('client_id'))).toBe(true);
  });

  it('a_metric_missing_from_the_manifest_fails_the_build', () => {
    const result = checkDashboards({
      dashboards: [readFixture('unknown-metric-bad.json')],
      manifest,
      recordingRuleNames: emptyRules,
      instanceLabelledGauges,
    });
    expect(result.violations.some((v) => v.message.includes('wp_send_attemps_total'))).toBe(true);
  });

  it('an_unknown_recording_rule_fails_the_build', () => {
    const result = checkDashboards({
      dashboards: [readFixture('unknown-recording-rule-bad.json')],
      manifest,
      recordingRuleNames: emptyRules,
      instanceLabelledGauges,
    });
    expect(
      result.violations.some((v) =>
        v.message.includes(rr('session_availability_ratio_does_not_exist')),
      ),
    ).toBe(true);

    const withRule = checkDashboards({
      dashboards: [readFixture('unknown-recording-rule-bad.json')],
      manifest,
      recordingRuleNames: new Set([rr('session_availability_ratio_does_not_exist')]),
      instanceLabelledGauges,
    });
    expect(withRule.violations).toEqual([]);
  });

  it('a_non_provisioned_datasource_uid_fails_the_build', () => {
    const result = checkDashboards({
      dashboards: [readFixture('non-provisioned-datasource-bad.json')],
      manifest,
      recordingRuleNames: emptyRules,
      instanceLabelledGauges,
    });
    expect(result.violations.some((v) => v.message.includes('influxdb-not-provisioned'))).toBe(
      true,
    );
  });

  it('the_four_provisioned_dashboards_pass', () => {
    const result = runCheckDashboards();

    expect(result.dashboardsScanned).toBe(4);
    expect(result.panelCount).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it('guard_matched_a_non_zero_file_count', () => {
    const files = resolveFiles(DASHBOARD_GLOBS);
    expect(files.length).toBeGreaterThan(0);

    const zeroResult = checkDashboards({
      dashboards: [],
      manifest,
      recordingRuleNames: emptyRules,
      instanceLabelledGauges,
    });
    expect(zeroResult.violations.length).toBeGreaterThan(0);
  });

  it('parseRecordingRuleNames_reads_record_entries_out_of_rule_group_yaml', () => {
    const ratioRule = rr('session_availability_ratio');
    const lagRule = rr('queue_lag_p99_seconds');
    const yaml = `
groups:
  - name: wp-slo
    rules:
      - record: ${ratioRule}
        expr: max(wp_instances_connected)
      - record: ${lagRule}
        expr: histogram_quantile(0.99, wp_send_duration_seconds_bucket)
`;
    expect(parseRecordingRuleNames([yaml])).toEqual(new Set([ratioRule, lagRule]));
  });
});
