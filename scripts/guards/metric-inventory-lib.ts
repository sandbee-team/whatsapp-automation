import type { MetricInventoryEntry, MetricType } from '@wp/domain';
import type { GuardViolation } from './scan-config.js';

/**
 * metric-inventory-lib.ts (P25 unit U1a) - pure scan/check core for
 * check-metric-inventory.ts, split out purely to keep both files under the
 * `max-lines: 300` cap (same split idiom as health-writers-lib.ts /
 * check-health-writers.ts). No filesystem access anywhere in this file.
 */

export interface MetricRegistration {
  name: string;
  type: MetricType;
  labels: string[];
  module: string;
  line: number;
}

export interface RegistrationSourceFile {
  path: string;
  content: string;
}

const TEST_FILE_PATTERN = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.tsx?$/;
const TEST_SUPPORT_PATTERN = /(^|\/)(__test-support__|__fixtures__)\//;
const REGISTRATION_CALL_PATTERN = /\b(counter|gauge|histogram)\(\s*'(wp_[a-z0-9_]+)'/g;
/**
 * Same three registry methods as REGISTRATION_CALL_PATTERN, but matching an
 * actual METHOD CALL (`.counter(`/`.gauge(`/`.histogram(`, e.g.
 * `registry.counter(...)`) whose first argument is NOT a plain
 * single-quoted string literal - a template literal, a bare
 * identifier/variable, a double-quoted string, etc.
 * REGISTRATION_CALL_PATTERN simply does not match these calls at all - so,
 * unguarded, a `wp_`-prefixed metric registered via
 * `registry.counter(\`wp_${x}\`, ...)` would be silently invisible to this
 * whole guard (neither flagged as unknown NOR checked against the
 * inventory). This pattern exists to make that case a violation instead of
 * a silent skip.
 *
 * The leading `\.` (a real method-call dot) deliberately excludes the
 * FACTORY FUNCTION DEFINITIONS themselves (`function counter(name: string,
 * ...)` in `@wp/server-kit`'s own `metrics.ts`) - those declare the API,
 * they do not call it with a metric name. `scanDynamicMetricNameViolations`
 * below additionally excludes a captured argument that is exactly `...`
 * (an ellipsis - i.e. this pattern text appearing inside a PROSE doc
 * comment like "the `registry.counter(...)` calls above", never a real
 * call) or that looks like a TS parameter declaration (`name: string`) -
 * both forms appear verbatim in this tree's own doc comments and must never
 * be misread as a dynamically-named registration.
 */
const DYNAMIC_REGISTRATION_CALL_PATTERN = /\.(counter|gauge|histogram)\(\s*([^'\s][^,)]*)/g;
const ELLIPSIS_PROSE_PATTERN = /^\.{3}$/;
const TS_PARAM_DECLARATION_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*\w/;

/** Index just after the matching closing `)` for the `(` at openParenIndex, respecting nested parens and skipping over string literals. */
function findMatchingClose(text: string, openParenIndex: number): number {
  let depth = 0;
  for (let i = openParenIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

/** First `[...]` array literal of single-quoted strings within `argsText`. */
function extractLabelArray(argsText: string): string[] {
  const arrayMatch = /\[\s*((?:'[^']*'\s*,?\s*)*)\]/.exec(argsText);
  if (!arrayMatch) return [];
  const body = arrayMatch[1] ?? '';
  const labels: string[] = [];
  const labelPattern = /'([^']*)'/g;
  let labelMatch: RegExpExecArray | null;
  while ((labelMatch = labelPattern.exec(body))) {
    labels.push(labelMatch[1] ?? '');
  }
  return labels;
}

/** Matches single-line AND multi-line `registry.counter(/gauge(/histogram(` calls; test/support files exempt. */
export function scanMetricRegistrations(files: RegistrationSourceFile[]): MetricRegistration[] {
  const registrations: MetricRegistration[] = [];

  for (const file of files) {
    if (TEST_FILE_PATTERN.test(file.path) || TEST_SUPPORT_PATTERN.test(file.path)) continue;

    REGISTRATION_CALL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REGISTRATION_CALL_PATTERN.exec(file.content))) {
      const rawType = match[1];
      const name = match[2];
      if (rawType === undefined || name === undefined) continue;
      const type = rawType as MetricType;
      const openParenIndex = match.index + rawType.length;
      const closeParenIndex = findMatchingClose(file.content, openParenIndex);
      const argsText = file.content.slice(openParenIndex + 1, closeParenIndex);
      const labels = extractLabelArray(argsText);
      const line = file.content.slice(0, match.index).split('\n').length;

      registrations.push({ name, type, labels, module: file.path, line });
    }
  }

  return registrations;
}

/**
 * Scans for a `counter(`/`gauge(`/`histogram(` call whose first argument is
 * NOT a plain single-quoted string literal - a template literal
 * (`` `wp_${x}` ``) or a bare variable/identifier. REGISTRATION_CALL_PATTERN
 * never matches these at all, so without this separate scan a dynamically
 * named `wp_` metric would pass this whole guard with zero violations -
 * neither flagged as unknown nor checked against the inventory. Every match
 * here is unconditionally a violation: this workspace's convention is a
 * literal metric name always, so any dynamic first argument to one of these
 * three registry methods is itself the violation, independent of what the
 * inventory does or does not contain.
 */
export function scanDynamicMetricNameViolations(files: RegistrationSourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    if (TEST_FILE_PATTERN.test(file.path) || TEST_SUPPORT_PATTERN.test(file.path)) continue;

    DYNAMIC_REGISTRATION_CALL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DYNAMIC_REGISTRATION_CALL_PATTERN.exec(file.content))) {
      const type = match[1];
      const firstArg = (match[2] ?? '').trim();
      if (type === undefined) continue;
      // A plain single-quoted literal is legitimate and already handled by
      // scanMetricRegistrations - only flag genuinely dynamic forms
      // (template literals, double-quoted strings, bare identifiers).
      if (/^'[^']*'$/.test(firstArg)) continue;
      // Prose-comment exclusions (see this pattern's own header comment):
      // an ellipsis ("registry.counter(...)" as doc-comment shorthand) or a
      // TS parameter declaration shape ("counter(name: string, ...)" in the
      // factory's own doc comment) is never a real dynamic registration.
      if (ELLIPSIS_PROSE_PATTERN.test(firstArg)) continue;
      if (TS_PARAM_DECLARATION_PATTERN.test(firstArg)) continue;

      const line = file.content.slice(0, match.index).split('\n').length;
      violations.push({
        file: file.path,
        line,
        message: `check-metric-inventory: "${type}(...)" registers a metric name that is not a plain string literal (dynamic metric name: "${firstArg}") - metric names must be literal, never computed`,
      });
    }
  }

  return violations;
}

function sameLabelSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((label, i) => label === sortedB[i]);
}

function violatesInstanceLabelPolicy(
  name: string,
  type: MetricType,
  labels: readonly string[],
  instanceLabelledGauges: readonly string[],
): boolean {
  const usesTenantScopedLabel = labels.includes('instance_id') || labels.includes('client_id');
  return usesTenantScopedLabel && (!instanceLabelledGauges.includes(name) || type !== 'gauge');
}

/** Seven violation clauses - see check-metric-inventory.ts's own header for the full list (a)-(g). */
export function checkMetricInventory(
  registrations: readonly MetricRegistration[],
  inventory: readonly MetricInventoryEntry[],
  instanceLabelledGauges: readonly string[],
): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const inventoryByName = new Map(inventory.map((entry) => [entry.name, entry]));
  const registrationsByName = new Map<string, MetricRegistration[]>();

  for (const registration of registrations) {
    const existing = registrationsByName.get(registration.name);
    if (existing) existing.push(registration);
    else registrationsByName.set(registration.name, [registration]);
  }

  for (const [name, regs] of registrationsByName) {
    const inventoryEntry = inventoryByName.get(name);
    if (!inventoryEntry) {
      for (const reg of regs) {
        violations.push({
          file: reg.module,
          line: reg.line,
          message: `check-metric-inventory: "${name}" is registered but absent from METRIC_INVENTORY`,
        });
      }
      continue;
    }

    const modules = new Set(regs.map((reg) => reg.module));
    if (modules.size > 1) {
      violations.push({
        file: inventoryEntry.module,
        message: `check-metric-inventory: "${name}" is registered from more than one module: ${[...modules].sort().join(', ')}`,
      });
    }

    for (const reg of regs) {
      if (reg.type !== inventoryEntry.type) {
        violations.push({
          file: reg.module,
          line: reg.line,
          message: `check-metric-inventory: "${name}" registration type "${reg.type}" disagrees with inventory type "${inventoryEntry.type}"`,
        });
      }
      if (!sameLabelSet(reg.labels, inventoryEntry.labels)) {
        violations.push({
          file: reg.module,
          line: reg.line,
          message: `check-metric-inventory: "${name}" registration labels [${reg.labels.join(', ')}] disagree with inventory labels [${inventoryEntry.labels.join(', ')}]`,
        });
      }
      if (reg.module !== inventoryEntry.module) {
        violations.push({
          file: reg.module,
          line: reg.line,
          message: `check-metric-inventory: "${name}" registered in "${reg.module}" but inventory declares module "${inventoryEntry.module}"`,
        });
      }
    }
  }

  for (const entry of inventory) {
    if (!registrationsByName.has(entry.name)) {
      violations.push({
        file: entry.module,
        message: `check-metric-inventory: "${entry.name}" is in METRIC_INVENTORY but has no registration`,
      });
    }
    if (violatesInstanceLabelPolicy(entry.name, entry.type, entry.labels, instanceLabelledGauges)) {
      violations.push({
        file: entry.module,
        message: `check-metric-inventory: "${entry.name}" uses instance_id/client_id but is not one of the INSTANCE_LABELLED_GAUGES (or is not a gauge)`,
      });
    }
  }
  for (const [name, regs] of registrationsByName) {
    for (const reg of regs) {
      if (violatesInstanceLabelPolicy(name, reg.type, reg.labels, instanceLabelledGauges)) {
        violations.push({
          file: reg.module,
          line: reg.line,
          message: `check-metric-inventory: "${name}" registration uses instance_id/client_id but is not one of the INSTANCE_LABELLED_GAUGES (or is not a gauge)`,
        });
      }
    }
  }

  return violations;
}
