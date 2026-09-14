import {
  metricIsKnown,
  metricNamesInExpr,
  parseRuleFiles,
  parseTestFileExprSources,
  recordingRefsInExpr,
  runbookAnchors,
  type AlertRule,
  type ExprSource,
  type GuardViolation,
  type ManifestMetric,
  type RecordingRule,
  type RuleFile,
} from './alert-rules-lib.js';

/**
 * alert-rules-clauses.ts (P25 Unit U4, step 7) - the six check clauses
 * (a)-(f) from the phase Dispatch plan, split out of alert-rules-lib.ts to
 * respect the 300-line cap. Still pure - no filesystem/process access.
 */

const VALID_SEVERITIES = new Set(['page', 'ticket']);

/** Annotation values never templated with a tenant/recipient identifier - copy is prose, ids-only. */
const FORBIDDEN_ANNOTATION_TOKENS = [
  '$labels.client_id',
  '$labels.instance_id',
  'recipient',
  'jid',
  'phone',
  'body',
  'external_ref',
];

function checkSeverities(alerts: AlertRule[]): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const alert of alerts) {
    if (!alert.severity || !VALID_SEVERITIES.has(alert.severity)) {
      violations.push({
        file: alert.sourceFile,
        message: `alert ${alert.name}: labels.severity must be "page" or "ticket" (found ${String(alert.severity)})`,
      });
    }
  }
  return violations;
}

function checkRunbookAnchors(alerts: AlertRule[], anchors: ReadonlySet<string>): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const alert of alerts) {
    const match = alert.runbookUrl?.match(/^docs\/RUNBOOK\.md#(.+)$/);
    if (!match) {
      violations.push({
        file: alert.sourceFile,
        message: `alert ${alert.name}: annotations.runbook_url must look like docs/RUNBOOK.md#<anchor> (found ${String(alert.runbookUrl)})`,
      });
      continue;
    }
    const anchor = match[1];
    if (!anchor || !anchors.has(anchor)) {
      violations.push({
        file: alert.sourceFile,
        message: `alert ${alert.name}: runbook anchor "${String(anchor)}" has no matching "## ${String(anchor)}" heading in docs/RUNBOOK.md`,
      });
    }
  }
  return violations;
}

function checkMetricNamesKnown(
  exprSources: ExprSource[],
  manifestNames: ReadonlySet<string>,
  histogramBaseNames: ReadonlySet<string>,
): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const source of exprSources) {
    for (const metric of metricNamesInExpr(source.expr)) {
      if (!metricIsKnown(metric, manifestNames, histogramBaseNames)) {
        violations.push({
          file: source.sourceFile,
          message: `${source.label}: expr references unknown metric "${metric}" - not in infra/observability/metrics.generated.json`,
        });
      }
    }
  }
  return violations;
}

function checkRecordingRefsKnown(
  exprSources: ExprSource[],
  recordingRuleNames: ReadonlySet<string>,
): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const source of exprSources) {
    for (const ref of recordingRefsInExpr(source.expr)) {
      if (!recordingRuleNames.has(ref)) {
        violations.push({
          file: source.sourceFile,
          message: `${source.label}: expr references unknown recording rule "${ref}" - no matching record: in the rule files`,
        });
      }
    }
  }
  return violations;
}

function checkUniqueNames(alerts: AlertRule[], recordingRules: RecordingRule[]): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const seenAlerts = new Map<string, string>();
  for (const alert of alerts) {
    const prior = seenAlerts.get(alert.name);
    if (prior) {
      violations.push({
        file: alert.sourceFile,
        message: `alert name "${alert.name}" is defined more than once (also in ${prior})`,
      });
    } else {
      seenAlerts.set(alert.name, alert.sourceFile);
    }
  }
  const seenRecording = new Map<string, string>();
  for (const rule of recordingRules) {
    const prior = seenRecording.get(rule.name);
    if (prior) {
      violations.push({
        file: rule.sourceFile,
        message: `recording rule name "${rule.name}" is defined more than once (also in ${prior})`,
      });
    } else {
      seenRecording.set(rule.name, rule.sourceFile);
    }
  }
  return violations;
}

function checkAnnotationsHonest(alerts: AlertRule[]): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const alert of alerts) {
    for (const value of alert.annotationValues) {
      const lower = value.toLowerCase();
      for (const token of FORBIDDEN_ANNOTATION_TOKENS) {
        if (lower.includes(token.toLowerCase())) {
          violations.push({
            file: alert.sourceFile,
            message: `alert ${alert.name}: annotation value templates or names a tenant/recipient identifier ("${token}") - annotations must be plain, ids-only prose`,
          });
        }
      }
    }
  }
  return violations;
}

export interface AlertRulesInput {
  ruleFiles: RuleFile[];
  testFileText: string;
  manifestNames: ManifestMetric[];
  runbookText: string;
  /** Reserved for a future instance-labelled-gauge clause; unused by clauses (a)-(f) today. */
  instanceLabelledGauges?: string[];
}

/**
 * Pure clauses (a)-(f) from the phase Dispatch plan:
 * (a) every alert has labels.severity in {page, ticket};
 * (b)+(f) every alert has a valid annotations.runbook_url whose anchor
 *     exists in the runbook;
 * (c) every wp_ metric referenced by any expr (rules AND the test file)
 *     exists in the manifest; every wp: recording-rule reference resolves
 *     to a record: in the rule files;
 * (d) alert names unique; recording-rule names unique;
 * (e) no annotation value templates or names a tenant/recipient identifier.
 */
export function checkAlertRules(input: AlertRulesInput): GuardViolation[] {
  const { alerts, recordingRules } = parseRuleFiles(input.ruleFiles);
  const manifestNames = new Set(input.manifestNames.map((m) => m.name));
  const histogramBaseNames = new Set(
    input.manifestNames.filter((m) => m.type === 'histogram').map((m) => m.name),
  );
  const recordingRuleNames = new Set(recordingRules.map((r) => r.name));
  const anchors = runbookAnchors(input.runbookText);

  const alertExprSources: ExprSource[] = alerts.map((alert) => ({
    expr: alert.expr,
    sourceFile: alert.sourceFile,
    label: `alert ${alert.name}`,
  }));
  const recordingExprSources: ExprSource[] = recordingRules.map((rule) => ({
    expr: rule.expr,
    sourceFile: rule.sourceFile,
    label: `recording rule ${rule.name}`,
  }));
  const testExprSources = parseTestFileExprSources(input.testFileText);
  const allExprSources = [...alertExprSources, ...recordingExprSources, ...testExprSources];

  return [
    ...checkSeverities(alerts),
    ...checkRunbookAnchors(alerts, anchors),
    ...checkMetricNamesKnown(allExprSources, manifestNames, histogramBaseNames),
    ...checkRecordingRefsKnown(allExprSources, recordingRuleNames),
    ...checkUniqueNames(alerts, recordingRules),
    ...checkAnnotationsHonest(alerts),
  ];
}
