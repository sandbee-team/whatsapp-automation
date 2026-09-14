import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAlertRules } from '../guards/alert-rules-clauses.js';
import type { ManifestMetric, RuleFile } from '../guards/alert-rules-lib.js';
import { runCheckAlertRules } from '../check-alert-rules.js';
import { REPO_ROOT } from '../guards/scan-config.js';

/**
 * check-alert-rules.test.ts (P25 Unit U4, step 7) - proves the pure clauses
 * in guards/alert-rules-clauses.ts against both the real committed rule
 * tree and small inline/fixture cases, plus the five named promtool test
 * cases and the real shell part (Docker is up on this machine).
 */

const RULES_DIR = path.join(REPO_ROOT, 'infra/observability/prometheus/rules');
const RUNBOOK_PATH = path.join(REPO_ROOT, 'docs/RUNBOOK.md');
const MANIFEST_PATH = path.join(REPO_ROOT, 'infra/observability/metrics.generated.json');
const FIXTURES_DIR = path.join(REPO_ROOT, 'scripts/guards/__fixtures__/alert-rules');

function readRuleFile(name: string): RuleFile {
  return { path: name, content: readFileSync(path.join(RULES_DIR, name), 'utf8') };
}

function readFixture(name: string): RuleFile {
  return { path: name, content: readFileSync(path.join(FIXTURES_DIR, name), 'utf8') };
}

function realManifestMetrics(): ManifestMetric[] {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
    metrics: ManifestMetric[];
  };
  return manifest.metrics;
}

function realRuleFiles(): RuleFile[] {
  return [readRuleFile('wp-alerts.rules.yml'), readRuleFile('wp-slo.rules.yml')];
}

function realTestFileText(): string {
  return readFileSync(path.join(RULES_DIR, 'wp-alerts.test.yml'), 'utf8');
}

function realRunbookText(): string {
  return readFileSync(RUNBOOK_PATH, 'utf8');
}

describe('check-alert-rules (P25 unit U4)', () => {
  it('every_alert_has_an_existing_runbook_anchor', () => {
    const clean = checkAlertRules({
      ruleFiles: realRuleFiles(),
      testFileText: realTestFileText(),
      manifestNames: realManifestMetrics(),
      runbookText: realRunbookText(),
    });
    expect(clean.filter((v) => v.message.includes('runbook anchor'))).toEqual([]);

    const runbookMissingOneAnchor = realRunbookText().replace('## alert-instances-unowned\n\n', '');
    const withMissingAnchor = checkAlertRules({
      ruleFiles: realRuleFiles(),
      testFileText: realTestFileText(),
      manifestNames: realManifestMetrics(),
      runbookText: runbookMissingOneAnchor,
    });
    const anchorViolations = withMissingAnchor.filter((v) => v.message.includes('runbook anchor'));
    expect(anchorViolations).toHaveLength(1);
    expect(anchorViolations[0]?.message).toContain('InstancesUnowned');
  });

  it('every_metric_referenced_by_a_rule_exists_in_the_manifest', () => {
    const violations = checkAlertRules({
      ruleFiles: [readFixture('typo-metric.rules.yml')],
      testFileText: 'tests: []',
      manifestNames: realManifestMetrics(),
      runbookText: realRunbookText(),
    });
    expect(violations.some((v) => v.message.includes('wp_instances_unowend'))).toBe(true);

    const real = checkAlertRules({
      ruleFiles: realRuleFiles(),
      testFileText: realTestFileText(),
      manifestNames: realManifestMetrics(),
      runbookText: realRunbookText(),
    });
    expect(real.filter((v) => v.message.includes('unknown metric'))).toEqual([]);
  });

  it('every_alert_carries_a_page_or_ticket_severity', () => {
    const violations = checkAlertRules({
      ruleFiles: [readFixture('bad-severity.rules.yml')],
      testFileText: 'tests: []',
      manifestNames: realManifestMetrics(),
      runbookText: realRunbookText(),
    });
    expect(violations.some((v) => v.message.includes('BadSeverity'))).toBe(true);
  });

  it('annotations_never_template_tenant_or_recipient_labels', () => {
    const violations = checkAlertRules({
      ruleFiles: [readFixture('templated-client-id.rules.yml')],
      testFileText: 'tests: []',
      manifestNames: realManifestMetrics(),
      runbookText: realRunbookText(),
    });
    expect(violations.some((v) => v.message.includes('TemplatedClientId'))).toBe(true);
  });

  it('the_five_named_promtool_cases_are_present', () => {
    const text = realTestFileText();
    const expectedCases = [
      'wp_instances_unowned_fires_after_two_minutes',
      'any_fence_regression_pages_immediately',
      'wallet_drift_nonzero_pages',
      'headroom_ratio_below_twenty_percent_warns',
      'messages_out_without_job_pages',
    ];
    for (const caseName of expectedCases) {
      expect(text).toContain(`# case: ${caseName}`);
    }
  });

  // promtool runs as an external process (PATH or the pinned Docker image) - seconds under
  // load, not the 5 s vitest default; a timeout here is not a rules failure.
  it('promtool_check_and_unit_tests_pass_on_the_real_rules', { timeout: 120_000 }, () => {
    const result = runCheckAlertRules();
    const promtoolViolations = result.violations.filter((v) => v.message.includes('promtool'));
    expect(promtoolViolations).toEqual([]);
  });

  it('guard_matched_a_non_zero_file_count', { timeout: 120_000 }, () => {
    const result = runCheckAlertRules();
    expect(result.filesScanned ?? 0).toBeGreaterThanOrEqual(3);
    expect(result.violations).toEqual([]);
  });
});
