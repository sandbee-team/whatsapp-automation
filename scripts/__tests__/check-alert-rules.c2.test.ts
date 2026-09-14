import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAlertRules } from '../guards/alert-rules-clauses.js';
import type { ManifestMetric, RuleFile } from '../guards/alert-rules-lib.js';
import { runbookAnchors } from '../guards/alert-rules-lib.js';
import { REPO_ROOT } from '../guards/scan-config.js';

/**
 * check-alert-rules.c2.test.ts (P25 SESSION-PROTOCOL C2 edge-case pass) -
 * hunt item (c): a `for:` present but `labels` absent entirely (not merely
 * missing `severity`) is a violation; `severity: Page` (case mismatch) is a
 * violation (VALID_SEVERITIES.has is case-sensitive); a runbook_url anchor
 * that exists only as an H3 heading (never an H2) is a violation
 * (runbookAnchors only parses `## ` H2 headings).
 */

const RUNBOOK_PATH = path.join(REPO_ROOT, 'docs/RUNBOOK.md');
const MANIFEST_PATH = path.join(REPO_ROOT, 'infra/observability/metrics.generated.json');
const FIXTURES_DIR = path.join(REPO_ROOT, 'scripts/guards/__fixtures__/alert-rules');

function readFixture(name: string): RuleFile {
  return { path: name, content: readFileSync(path.join(FIXTURES_DIR, name), 'utf8') };
}

function realManifestMetrics(): ManifestMetric[] {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { metrics: ManifestMetric[] };
  return manifest.metrics;
}

function realRunbookText(): string {
  return readFileSync(RUNBOOK_PATH, 'utf8');
}

describe('a_for_window_with_no_labels_key_at_all_is_a_violation', () => {
  it('fails severity check when labels is entirely absent, not merely missing severity', () => {
    const violations = checkAlertRules({
      ruleFiles: [readFixture('no-labels-at-all.rules.yml')],
      testFileText: 'tests: []',
      manifestNames: realManifestMetrics(),
      runbookText: realRunbookText(),
    });
    expect(violations.some((v) => v.message.includes('NoLabelsAtAll'))).toBe(true);
    expect(
      violations.some((v) => v.message.includes('NoLabelsAtAll') && v.message.includes('severity')),
    ).toBe(true);
  });
});

describe('severity_case_mismatch_is_a_violation', () => {
  it('"Page" (capital P) is rejected - VALID_SEVERITIES is case-sensitive', () => {
    const violations = checkAlertRules({
      ruleFiles: [readFixture('case-mismatched-severity.rules.yml')],
      testFileText: 'tests: []',
      manifestNames: realManifestMetrics(),
      runbookText: realRunbookText(),
    });
    expect(violations.some((v) => v.message.includes('CaseMismatchedSeverity'))).toBe(true);
  });
});

describe('an_anchor_that_exists_only_as_an_h3_heading_is_not_a_match', () => {
  it('runbookAnchors never parses ### headings, only ##', () => {
    const runbookText = [
      '# Runbook',
      '',
      '## alert-real-h2-anchor',
      '',
      'Some prose.',
      '',
      '### alert-only-an-h3-anchor',
      '',
      'More prose.',
    ].join('\n');

    const anchors = runbookAnchors(runbookText);
    expect(anchors.has('alert-real-h2-anchor')).toBe(true);
    expect(anchors.has('alert-only-an-h3-anchor')).toBe(false);
  });

  it('an alert whose runbook_url anchor only exists as an H3 heading fails the runbook-anchor check', () => {
    const ruleFiles: RuleFile[] = [
      {
        path: 'h3-only-anchor.rules.yml',
        content: [
          'groups:',
          '  - name: fixture-h3-only-anchor',
          '    rules:',
          '      - alert: H3OnlyAnchor',
          '        expr: wp_instances_unowned > 0',
          '        labels:',
          '          severity: ticket',
          '        annotations:',
          '          runbook_url: docs/RUNBOOK.md#alert-only-an-h3-anchor',
        ].join('\n'),
      },
    ];
    const runbookText = ['# Runbook', '', '### alert-only-an-h3-anchor', '', 'prose'].join('\n');

    const violations = checkAlertRules({
      ruleFiles,
      testFileText: 'tests: []',
      manifestNames: realManifestMetrics(),
      runbookText,
    });

    expect(
      violations.some(
        (v) => v.message.includes('H3OnlyAnchor') && v.message.includes('runbook anchor'),
      ),
    ).toBe(true);
  });
});
