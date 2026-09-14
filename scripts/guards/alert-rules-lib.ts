import { parse } from 'yaml';

/**
 * alert-rules-lib.ts (P25 Unit U4, step 7) - pure parsing core for
 * check-alert-rules.ts, mirroring health-writers-lib.ts's split: this file
 * has no filesystem/process access, so every clause is testable with inline
 * strings. The check clauses themselves live in the sibling
 * alert-rules-clauses.ts (split out to respect the 300-line cap); the shell
 * part (promtool invocation) lives in check-alert-rules.ts.
 */

export interface RuleFile {
  path: string;
  content: string;
}

export interface AlertRule {
  name: string;
  expr: string;
  for?: string;
  severity?: string;
  runbookUrl?: string;
  annotationValues: string[];
  sourceFile: string;
}

export interface RecordingRule {
  name: string;
  expr: string;
  sourceFile: string;
}

const WP_METRIC_PATTERN = /\bwp_[a-z0-9_]+/g;
const WP_RECORDING_REF_PATTERN = /\bwp:[a-z0-9_:]+/g;
const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'];

/** Parse every `groups[].rules[]` entry across the given rule files into alert rules and recording rules. */
export function parseRuleFiles(ruleFiles: RuleFile[]): {
  alerts: AlertRule[];
  recordingRules: RecordingRule[];
} {
  const alerts: AlertRule[] = [];
  const recordingRules: RecordingRule[] = [];

  for (const file of ruleFiles) {
    const doc = parse(file.content) as {
      groups?: { rules?: Record<string, unknown>[] }[];
    } | null;
    const groups = doc?.groups ?? [];

    for (const group of groups) {
      for (const rule of group.rules ?? []) {
        if (typeof rule.alert === 'string') {
          const labels = (rule.labels ?? {}) as Record<string, unknown>;
          const annotations = (rule.annotations ?? {}) as Record<string, unknown>;
          alerts.push({
            name: rule.alert,
            expr: String(rule.expr ?? ''),
            for: typeof rule.for === 'string' ? rule.for : undefined,
            severity: typeof labels.severity === 'string' ? labels.severity : undefined,
            runbookUrl:
              typeof annotations.runbook_url === 'string' ? annotations.runbook_url : undefined,
            annotationValues: Object.values(annotations).filter(
              (v): v is string => typeof v === 'string',
            ),
            sourceFile: file.path,
          });
        } else if (typeof rule.record === 'string') {
          recordingRules.push({
            name: rule.record,
            expr: String(rule.expr ?? ''),
            sourceFile: file.path,
          });
        }
      }
    }
  }

  return { alerts, recordingRules };
}

/** GitHub-flavoured anchor: heading lowercased, spaces -> `-`, non `[a-z0-9-]` stripped. */
export function githubAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/** Every `## <heading>` H2 anchor present in the given runbook markdown text. */
export function runbookAnchors(runbookText: string): Set<string> {
  const anchors = new Set<string>();
  const headingPattern = /^##\s+(.+)$/gm;
  for (const match of runbookText.matchAll(headingPattern)) {
    const heading = match[1];
    if (heading) anchors.add(githubAnchor(heading));
  }
  return anchors;
}

/** Every `wp_...` metric name referenced by an expr string (de-duplicated, order-preserving). */
export function metricNamesInExpr(expr: string): string[] {
  return Array.from(new Set(expr.match(WP_METRIC_PATTERN) ?? []));
}

/** Every `wp:...` recording-rule name referenced by an expr string. */
export function recordingRefsInExpr(expr: string): string[] {
  return Array.from(new Set(expr.match(WP_RECORDING_REF_PATTERN) ?? []));
}

/**
 * True when `metricName` is covered by `manifestNames` - either directly,
 * or (for a histogram-suffixed name) via its base name being a histogram
 * in the manifest. Suffix normalisation is deliberately narrow: a counter
 * or gauge named e.g. `wp_something_count` that is NOT itself a histogram
 * base must still resolve only by its own exact name.
 */
export function metricIsKnown(
  metricName: string,
  manifestNames: ReadonlySet<string>,
  histogramBaseNames: ReadonlySet<string>,
): boolean {
  if (manifestNames.has(metricName)) return true;
  for (const suffix of HISTOGRAM_SUFFIXES) {
    if (metricName.endsWith(suffix)) {
      const base = metricName.slice(0, -suffix.length);
      if (histogramBaseNames.has(base)) return true;
    }
  }
  return false;
}

export interface ManifestMetric {
  name: string;
  type: string;
}

export interface GuardViolation {
  file: string;
  line?: number;
  message: string;
}

export interface ExprSource {
  expr: string;
  sourceFile: string;
  label: string;
}

export interface ParsedTestFile {
  exprSources: ExprSource[];
}

/** Parse the promtool test file's `input_series`/`promql_expr_test` expr strings into scannable sources. */
export function parseTestFileExprSources(testFileText: string): ExprSource[] {
  const testDoc = parse(testFileText) as {
    tests?: { input_series?: { series?: string }[]; promql_expr_test?: { expr?: string }[] }[];
  } | null;
  const sources: ExprSource[] = [];
  for (const test of testDoc?.tests ?? []) {
    for (const series of test.input_series ?? []) {
      if (series.series) {
        sources.push({
          expr: series.series,
          sourceFile: 'wp-alerts.test.yml',
          label: 'wp-alerts.test.yml input_series',
        });
      }
    }
    for (const promqlTest of test.promql_expr_test ?? []) {
      if (promqlTest.expr) {
        sources.push({
          expr: promqlTest.expr,
          sourceFile: 'wp-alerts.test.yml',
          label: 'wp-alerts.test.yml promql_expr_test',
        });
      }
    }
  }
  return sources;
}
