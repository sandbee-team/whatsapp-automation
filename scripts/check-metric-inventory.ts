import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult } from './guards/scan-config.js';
import { METRIC_INVENTORY } from '@wp/domain';
import {
  checkMetricInventory,
  scanMetricRegistrations,
  scanDynamicMetricNameViolations,
} from './guards/metric-inventory-lib.js';
import type { MetricRegistration, RegistrationSourceFile } from './guards/metric-inventory-lib.js';

/**
 * check-metric-inventory.ts (P25 observability-and-runbook, unit U1a) - the
 * static CI guard proving `packages/domain/src/obs/metric-inventory*.ts`
 * (the ONE canonical metric inventory) and every real `wp_*` metric
 * registration in the shipped tree agree, in both directions: a registration
 * with no inventory entry fails the build, and an inventory entry with no
 * registration fails the build too (core invariant 7: tests/guards are
 * evidence, not aspiration - a stale inventory is worse than none).
 *
 * The pure scan/check core (`scanMetricRegistrations`, `checkMetricInventory`
 * and the seven violation clauses they implement) lives in
 * `guards/metric-inventory-lib.ts` - split out purely to keep both files
 * under the `max-lines: 300` cap (same idiom as
 * `check-health-writers.ts`/`guards/health-writers-lib.ts`). Re-exported here
 * so callers (including this file's own tests) need only one import path.
 *
 * `readInstanceLabelledGauges` reads `@wp/server-kit`'s `metric-policy.ts`
 * SOURCE TEXT rather than importing the package - its barrel parses `WP_*`
 * env vars at import time, which a `scripts/` CLI process never sets.
 */
export { checkMetricInventory, scanMetricRegistrations, scanDynamicMetricNameViolations };
export type { MetricRegistration };

export const METRIC_INVENTORY_GLOBS = [
  'app/backend/src/**/*.ts',
  // P28 U4: admin-backend registers its own `wp_admin_*` series on its own
  // registry, so its call sites must be scanned too - otherwise a metric
  // registered there would never be diffed against the inventory.
  'admin/backend/src/**/*.ts',
  'packages/*/src/**/*.ts',
];

const INSTANCE_LABELLED_GAUGES_ARRAY_PATTERN =
  /INSTANCE_LABELLED_GAUGES:\s*readonly\s+string\[\]\s*=\s*\[([\s\S]*?)\]/;

/** Reads `@wp/server-kit`'s metric-policy.ts SOURCE TEXT (never imports the package - its barrel parses WP_* env at import time). */
export function readInstanceLabelledGauges(): string[] {
  const filePath = path.join(REPO_ROOT, 'packages/server-kit/src/obs/metric-policy.ts');
  const content = readFileSync(filePath, 'utf8');
  const arrayMatch = INSTANCE_LABELLED_GAUGES_ARRAY_PATTERN.exec(content);
  if (!arrayMatch) {
    throw new Error(
      'check-metric-inventory: could not find INSTANCE_LABELLED_GAUGES literal in metric-policy.ts',
    );
  }
  const body = arrayMatch[1] ?? '';
  const entries: string[] = [];
  const entryPattern = /'([^']*)'/g;
  let entryMatch: RegExpExecArray | null;
  while ((entryMatch = entryPattern.exec(body))) {
    entries.push(entryMatch[1] ?? '');
  }
  if (entries.length < 1) {
    throw new Error(
      'check-metric-inventory: INSTANCE_LABELLED_GAUGES parsed to zero entries - parser is broken',
    );
  }
  return entries;
}

function readSourceFiles(): RegistrationSourceFile[] {
  return resolveFiles(METRIC_INVENTORY_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

export interface MetricInventoryGuardResult extends GuardResult {
  registrationsScanned: number;
}

export function runCheckMetricInventory(): MetricInventoryGuardResult {
  const files = readSourceFiles();
  const registrations = scanMetricRegistrations(files);
  const instanceLabelledGauges = readInstanceLabelledGauges();
  const violations = checkMetricInventory(registrations, METRIC_INVENTORY, instanceLabelledGauges);
  violations.push(...scanDynamicMetricNameViolations(files));

  if (files.length === 0 || registrations.length === 0) {
    violations.push({
      file: 'scripts/check-metric-inventory.ts',
      message:
        'check-metric-inventory: guard matched zero files or zero registrations - a guard matching nothing is not a guard',
    });
  }

  return { violations, filesScanned: files.length, registrationsScanned: registrations.length };
}

function main(): void {
  const result = runCheckMetricInventory();
  const summary = `${String(result.filesScanned)} files scanned, ${String(result.registrationsScanned)} registrations`;

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(
        `check-metric-inventory: ${violation.file}:${String(violation.line ?? '?')} - ${violation.message}`,
      );
    }
    console.log(
      `check-metric-inventory: ${summary}, ${String(result.violations.length)} violation(s)`,
    );
    process.exit(1);
  }

  console.log(`check-metric-inventory: ${summary}, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
