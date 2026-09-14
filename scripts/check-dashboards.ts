import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult } from './guards/scan-config.js';
import {
  checkDashboards,
  parseRecordingRuleNames,
  type DashboardFile,
} from './guards/dashboards-lib.js';
import { readInstanceLabelledGauges } from './check-metric-inventory.js';

/**
 * check-dashboards.ts (P25 observability-and-runbook, unit U6) - the guard
 * over the four provisioned Grafana dashboards
 * (`infra/observability/grafana/dashboards/*.json`). The pure clause set
 * lives in `guards/dashboards-lib.ts` (max-lines split, per
 * `check-health-writers.ts`'s idiom); this file only does I/O: read the
 * dashboard JSON files, the metrics manifest, and any `*.rules.yml`
 * recording-rule definitions, then call the pure core.
 */

export const DASHBOARD_GLOBS = ['infra/observability/grafana/dashboards/*.json'];
const RULES_GLOBS = ['infra/observability/prometheus/rules/*.rules.yml'];
const MANIFEST_PATH = path.join(REPO_ROOT, 'infra/observability/metrics.generated.json');

interface ManifestFile {
  metrics: { name: string; type: string }[];
}

function readManifest(): ManifestFile {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ManifestFile;
}

function readDashboardFiles(): DashboardFile[] {
  return resolveFiles(DASHBOARD_GLOBS).map((relativePath) => ({
    path: relativePath,
    json: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

function readRecordingRuleNames(): Set<string> {
  const ruleFiles = resolveFiles(RULES_GLOBS);
  const contents = ruleFiles.map((relativePath) =>
    readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  );
  return parseRecordingRuleNames(contents);
}

export interface DashboardGuardResult extends GuardResult {
  dashboardsScanned: number;
  panelCount: number;
}

export function runCheckDashboards(): DashboardGuardResult {
  const dashboards = readDashboardFiles();
  const manifest = readManifest();
  const recordingRuleNames = readRecordingRuleNames();
  const instanceLabelledGauges = readInstanceLabelledGauges();

  const { violations, panelCount } = checkDashboards({
    dashboards,
    manifest,
    recordingRuleNames,
    instanceLabelledGauges,
  });

  return {
    violations,
    filesScanned: dashboards.length,
    dashboardsScanned: dashboards.length,
    panelCount,
  };
}

function main(): void {
  const result = runCheckDashboards();
  const summary = `${String(result.dashboardsScanned)} dashboards, ${String(result.panelCount)} panels`;

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(`check-dashboards: ${violation.file} - ${violation.message}`);
    }
    console.log(`check-dashboards: ${summary}, ${String(result.violations.length)} violation(s)`);
    process.exit(1);
  }

  console.log(`check-dashboards: ${summary}, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
