import { parse as parseYaml } from 'yaml';

/**
 * dashboards-lib.ts (P25 U6) - pure core for check-dashboards.ts (max-lines
 * split, per check-health-writers.ts idiom). Clauses: (a) `wp_` metrics
 * exist in the manifest (histogram suffixes normalise to base name); (b)
 * `wp:` recording-rule refs resolve against rule files' `record:` entries
 * (missing rules dir -> any ref is a violation); (c) invariant 4 tenant
 * isolation - `by/without (client_id|instance_id)` is a violation unless
 * every metric used is instance-labelled; a legendFormat templating either
 * is ALWAYS a violation, allow-listed metric or not; (d) datasource uid is
 * prometheus|loki (row panels walked too); (e) uid/title/panel-id/
 * description hygiene; (f) invalid JSON names the file, not a crash.
 */

export interface GuardViolation {
  file: string;
  line?: number;
  message: string;
}

export interface DashboardFile {
  path: string;
  json: string;
}

interface GrafanaTarget {
  expr?: unknown;
  legendFormat?: unknown;
}

interface GrafanaPanel {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  description?: unknown;
  datasource?: { uid?: unknown } | null;
  targets?: GrafanaTarget[];
  panels?: GrafanaPanel[];
}

interface GrafanaDashboard {
  uid?: unknown;
  title?: unknown;
  panels?: GrafanaPanel[];
}

export interface CheckDashboardsInput {
  dashboards: DashboardFile[];
  manifest: { metrics: { name: string; type: string }[] };
  recordingRuleNames: Set<string>;
  instanceLabelledGauges: string[];
}

const METRIC_NAME_PATTERN = /\bwp_[a-z0-9_]+/g;
const RECORDING_RULE_PATTERN = /\bwp:[a-z0-9_:]+/g;
const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'];
const ALLOWED_DATASOURCE_UIDS = new Set(['prometheus', 'loki']);
const AGGREGATION_CLAUSE_PATTERN = /\b(?:by|without)\s*\(([^)]*)\)/g;
const TENANT_LABELS = ['client_id', 'instance_id'];

/** Parses every `record: wp:...` entry out of a `*.rules.yml` file's YAML text. */
export function parseRecordingRuleNames(ruleFileContents: string[]): Set<string> {
  const names = new Set<string>();
  for (const content of ruleFileContents) {
    const doc: unknown = parseYaml(content);
    for (const name of extractRecordNames(doc)) {
      names.add(name);
    }
  }
  return names;
}

function extractRecordNames(doc: unknown): string[] {
  if (doc === null || typeof doc !== 'object') return [];
  const groups = (doc as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return [];
  const names: string[] = [];
  for (const group of groups) {
    const rules = (group as { rules?: unknown })?.rules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      const record = (rule as { record?: unknown })?.record;
      if (typeof record === 'string') names.push(record);
    }
  }
  return names;
}

function metricBaseName(name: string, manifest: CheckDashboardsInput['manifest']): string {
  for (const suffix of HISTOGRAM_SUFFIXES) {
    if (name.endsWith(suffix)) {
      const base = name.slice(0, -suffix.length);
      const entry = manifest.metrics.find((m) => m.name === base);
      if (entry && entry.type === 'histogram') return base;
    }
  }
  return name;
}

function checkMetricNames(
  expr: string,
  file: string,
  panelId: unknown,
  manifest: CheckDashboardsInput['manifest'],
): GuardViolation[] {
  const known = new Set(manifest.metrics.map((m) => m.name));
  return (expr.match(METRIC_NAME_PATTERN) ?? [])
    .filter((raw) => !known.has(metricBaseName(raw, manifest)))
    .map((raw) => ({
      file,
      message: `panel ${String(panelId)}: unknown metric "${raw}" - not in metrics.generated.json`,
    }));
}

function checkRecordingRules(
  expr: string,
  file: string,
  panelId: unknown,
  recordingRuleNames: Set<string>,
): GuardViolation[] {
  return (expr.match(RECORDING_RULE_PATTERN) ?? [])
    .filter((raw) => !recordingRuleNames.has(raw))
    .map((raw) => ({
      file,
      message: `panel ${String(panelId)}: unknown recording rule "${raw}" - not defined in any *.rules.yml`,
    }));
}

function exprMetricNames(expr: string): string[] {
  return expr.match(METRIC_NAME_PATTERN) ?? [];
}

function tenantViolation(
  file: string,
  panelId: unknown,
  tenantLabel: string,
  via: string,
): GuardViolation {
  return {
    file,
    message: `panel ${String(panelId)}: ${via} names "${tenantLabel}" (core invariant 4: tenant isolation) - only instance-labelled gauges may use it`,
  };
}

/** legendFormat runs UNCONDITIONALLY - only the aggregation clause is exempt for an allow-listed instance gauge (Finding 4 fix). */
function checkTenantIsolation(
  expr: string,
  legendFormat: string | undefined,
  file: string,
  panelId: unknown,
  instanceLabelledGauges: string[],
): GuardViolation[] {
  const metricsUsed = exprMetricNames(expr);
  const allAllowlisted =
    metricsUsed.length > 0 && metricsUsed.every((m) => instanceLabelledGauges.includes(m));
  const violations: GuardViolation[] = [];

  if (!allAllowlisted) {
    for (const match of expr.matchAll(AGGREGATION_CLAUSE_PATTERN)) {
      const labels = (match[1] ?? '').split(',').map((s) => s.trim());
      for (const tenantLabel of TENANT_LABELS) {
        if (labels.includes(tenantLabel)) {
          violations.push(tenantViolation(file, panelId, tenantLabel, 'aggregation clause'));
        }
      }
    }
  }
  for (const tenantLabel of TENANT_LABELS) {
    const templated =
      legendFormat?.includes(`{{${tenantLabel}}}`) ||
      legendFormat?.includes(`{{ ${tenantLabel} }}`);
    if (templated) violations.push(tenantViolation(file, panelId, tenantLabel, 'legendFormat'));
  }
  return violations;
}

function checkDatasource(
  datasource: GrafanaPanel['datasource'],
  file: string,
  panelId: unknown,
): GuardViolation[] {
  if (!datasource) return [];
  const uid = datasource.uid;
  if (typeof uid !== 'string' || !ALLOWED_DATASOURCE_UIDS.has(uid)) {
    return [
      {
        file,
        message: `panel ${String(panelId)}: datasource.uid "${String(uid)}" is not a provisioned datasource (prometheus|loki)`,
      },
    ];
  }
  return [];
}

function walkPanels(
  panels: GrafanaPanel[],
  file: string,
  ctx: Omit<CheckDashboardsInput, 'dashboards'>,
  seenIds: Set<unknown>,
): { violations: GuardViolation[]; panelCount: number } {
  const violations: GuardViolation[] = [];
  let panelCount = 0;

  for (const panel of panels) {
    panelCount += 1;

    if (seenIds.has(panel.id)) {
      violations.push({ file, message: `duplicate panel id "${String(panel.id)}" in this file` });
    }
    seenIds.add(panel.id);

    if (typeof panel.description !== 'string' || panel.description.trim() === '') {
      violations.push({
        file,
        message: `panel ${String(panel.id)}: missing non-empty "description" (what the number means + runbook anchor)`,
      });
    }

    violations.push(...checkDatasource(panel.datasource, file, panel.id));

    for (const target of panel.targets ?? []) {
      const expr = typeof target.expr === 'string' ? target.expr : '';
      const legendFormat =
        typeof target.legendFormat === 'string' ? target.legendFormat : undefined;
      if (expr) {
        violations.push(...checkMetricNames(expr, file, panel.id, ctx.manifest));
        violations.push(...checkRecordingRules(expr, file, panel.id, ctx.recordingRuleNames));
      }
      violations.push(
        ...checkTenantIsolation(expr, legendFormat, file, panel.id, ctx.instanceLabelledGauges),
      );
    }

    if (Array.isArray(panel.panels) && panel.panels.length > 0) {
      const nested = walkPanels(panel.panels, file, ctx, seenIds);
      violations.push(...nested.violations);
      panelCount += nested.panelCount;
    }
  }

  return { violations, panelCount };
}

/** Pure core - no filesystem access. */
export function checkDashboards(input: CheckDashboardsInput): {
  violations: GuardViolation[];
  panelCount: number;
} {
  const violations: GuardViolation[] = [];
  const seenUids = new Map<string, string>();
  let panelCount = 0;

  if (input.dashboards.length === 0) {
    violations.push({ file: '<none>', message: 'zero dashboard files - guard matches nothing' });
    return { violations, panelCount };
  }

  for (const { path: file, json } of input.dashboards) {
    let dashboard: GrafanaDashboard;
    try {
      dashboard = JSON.parse(json) as GrafanaDashboard;
    } catch {
      violations.push({ file, message: 'invalid JSON - failed to parse' });
      continue;
    }

    if (typeof dashboard.title !== 'string' || dashboard.title.trim() === '') {
      violations.push({ file, message: 'missing non-empty "title"' });
    }

    const uid = typeof dashboard.uid === 'string' ? dashboard.uid : undefined;
    if (!uid) {
      violations.push({ file, message: 'missing "uid"' });
    } else if (seenUids.has(uid)) {
      violations.push({
        file,
        message: `duplicate uid "${uid}" also used by ${seenUids.get(uid) ?? '?'}`,
      });
    } else {
      seenUids.set(uid, file);
    }

    const { violations: panelViolations, panelCount: filePanelCount } = walkPanels(
      dashboard.panels ?? [],
      file,
      {
        manifest: input.manifest,
        recordingRuleNames: input.recordingRuleNames,
        instanceLabelledGauges: input.instanceLabelledGauges,
      },
      new Set<unknown>(),
    );
    violations.push(...panelViolations);
    panelCount += filePanelCount;
  }

  return { violations, panelCount };
}
