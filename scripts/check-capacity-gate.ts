import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';
import {
  scanFleetCapacityDoc,
  scanTenThousandClaims,
  FLEET_CAPACITY_DOC_PATH,
  GATE_B_PENDING_BANNER,
  GATE_B_CLOSED_BANNER_PREFIX,
  CAPACITY_DOC_GLOBS,
  TEN_THOUSAND_CLAIM_PATTERN,
  MEASURED_TO_N_SENTENCE,
} from './guards/capacity-gate-b-lib.js';

export {
  scanFleetCapacityDoc,
  scanTenThousandClaims,
  FLEET_CAPACITY_DOC_PATH,
  GATE_B_PENDING_BANNER,
  GATE_B_CLOSED_BANNER_PREFIX,
  CAPACITY_DOC_GLOBS,
  TEN_THOUSAND_CLAIM_PATTERN,
  MEASURED_TO_N_SENTENCE,
};

/**
 * check-capacity-gate.ts (P10 Unit U7, step 8) - the capacity-publication
 * gate. Modeled directly on `check-copy.ts`'s banned-string scan idiom (a
 * pure `scanCapacityGate` over already-read text, no filesystem access in
 * the core function).
 *
 * Three clauses:
 *
 * (a) `docs/capacity/session-cost.md` must carry the banner
 *     (`CAPACITY_GATE_BANNER`, verbatim) AND a sample-size marker (an `N=`
 *     token, matched loosely as "N (sample size) =" or "sample size" so the
 *     placeholder skeleton passes and a stripped doc fails red).
 * (b) no published capacity figure (`BANNED_CAPACITY_FIGURES`) may appear in
 *     the tenant-facing trees `app/frontend`, `website/`,
 *     `packages/domain/src/copy` (ADR 0016, ADR 0018 §8).
 * (c) the guard's own glob set must match a non-zero number of real repo
 *     files (the meta-assertion - a guard matching nothing is not a guard).
 *
 * The banned figures are a REPRESENTATIVE set of the derived/bracket
 * numbers this doc will eventually carry once U4/P10a fill in real
 * measurements - not the doc's own placeholder tokens (`<FILL AFTER U4
 * RUN>` etc., which are meant to be absent from tenant copy anyway and
 * carry no numeric information to leak).
 */

/** Verbatim banner this session's task text mandates (SOCKET-RESIDENT-PRE-HANDSHAKE, ADR 0032). */
export const CAPACITY_GATE_BANNER =
  'SOCKET-RESIDENT-PRE-HANDSHAKE (component A, ADR 0032) · SOCKET-ONLY (component B deferred to P10a — no real Signal/group state measured) · EXTRAPOLATED (injected rows, P10a) · Gate A OPEN (closes at P10a) · Gate B (P26) still open — no number here may be quoted to a customer (ADR 0016, ADR 0018 §8)';

/** Loose sample-size marker: "N (sample size) =" / "N=" / "sample size" (case-insensitive). */
const SAMPLE_SIZE_PATTERN = /\bN\s*(?:\(sample size\))?\s*=|sample size/i;

export const SESSION_COST_DOC_PATH = 'docs/capacity/session-cost.md';

/**
 * Representative bracket/derived figures that must never leak to a
 * tenant-facing surface, exact tokens (case-sensitive, whole-token) so they
 * cannot false-positive on unrelated legit strings elsewhere in the repo:
 * each token pairs a number with its unit/subject, so a bare "18" or "135"
 * elsewhere (e.g. a port number, an unrelated count) never matches.
 */
export const BANNED_CAPACITY_FIGURES: readonly string[] = Object.freeze([
  '18 MB',
  '35 MB',
  '135 sessions',
  '2000 sessions/box',
  // WARNING 9 (FIX-P10-A): the P10 component-A measured figures, banned the
  // same way the pre-P10 brackets above are - no measured/derived number may
  // be quoted to a customer until both gates close (ADR 0016, ADR 0018 §8).
  '0.227 MB',
  '305 MB',
  // P26 Unit U8: the derived load-model tokens the new fleet-capacity doc
  // carries (ADR 0018 §7). The MEASURED Gate-B tokens (the real numbers this
  // phase's runs produce) do not exist yet - the main session appends them
  // at fill time, alongside the derived tokens below.
  '600 sends/day',
  // P26 fill-time (2026-09-07): the MEASURED Gate-B tokens - internal evidence only until Gate B/C
  // close (ADR 0016, ADR 0018 §8); each maps to a row in docs/capacity/fleet-capacity.md.
  '84.27 statements/send',
  '1,342 bytes/send',
  '0.350 MB/s',
  '29,936 ms',
  '4,377 ms',
  '467.7 MiB',
  'reserve() p99 = 35 ms',
  '12 statements/send',
  '3.2 KB/send',
  '25 ms p99',
  '45 s takeover',
]);

/** The three tenant-facing trees a published figure must never reach (ADR 0016, ADR 0018 §8). */
export const CAPACITY_GATE_TENANT_GLOBS = [
  'app/frontend/**/*.{ts,tsx,js,jsx,md,mdx,json,html}',
  'website/**/*.{ts,tsx,js,jsx,md,mdx,json,html}',
  'packages/domain/src/copy/**/*.{ts,tsx,js,jsx,md,mdx,json}',
];

/** The doc itself + the tenant-facing trees - this is what the registry entry's `globs` covers. */
export const CAPACITY_GATE_GLOBS = [
  SESSION_COST_DOC_PATH,
  FLEET_CAPACITY_DOC_PATH,
  ...CAPACITY_GATE_TENANT_GLOBS,
  ...CAPACITY_DOC_GLOBS,
];

export interface SourceFile {
  path: string;
  content: string;
}

function scanDocGate(docPath: string, docContent: string): GuardViolation[] {
  const violations: GuardViolation[] = [];

  if (!docContent.includes(CAPACITY_GATE_BANNER)) {
    violations.push({
      file: docPath,
      message: `capacity gate: banner missing or stripped - the published capacity doc must carry the exact banner line (${CAPACITY_GATE_BANNER})`,
    });
  }

  if (!SAMPLE_SIZE_PATTERN.test(docContent)) {
    violations.push({
      file: docPath,
      message:
        'capacity gate: sample size marker missing - the published capacity doc must state N (sample size), even as a placeholder',
    });
  }

  return violations;
}

function scanTenantFigureLeak(file: SourceFile): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const lines = file.content.split('\n');
  lines.forEach((line, index) => {
    for (const figure of BANNED_CAPACITY_FIGURES) {
      if (line.includes(figure)) {
        violations.push({
          file: file.path,
          line: index + 1,
          message: `capacity gate: published capacity figure "${figure}" leaked into tenant-facing copy (ADR 0016, ADR 0018 §8) - no measured/derived number may be quoted to a customer`,
        });
      }
    }
  });
  return violations;
}

/**
 * Pure core - no filesystem access. `tenantFiles` is normally every file
 * resolved from `CAPACITY_GATE_TENANT_GLOBS`; `docPath`/`docContent` is
 * normally `SESSION_COST_DOC_PATH`'s real content, passed in so tests can
 * exercise clause (a) with fixture text without touching disk. `fleetDoc`
 * and `capacityDocs` are optional (P26 Unit U8, clauses d/e) so the pre-P26
 * call sites and tests keep compiling unchanged.
 */
export function scanCapacityGate(input: {
  docPath: string;
  docContent: string;
  tenantFiles: SourceFile[];
  fleetDoc?: SourceFile;
  capacityDocs?: SourceFile[];
}): GuardViolation[] {
  const violations: GuardViolation[] = [];
  violations.push(...scanDocGate(input.docPath, input.docContent));
  for (const file of input.tenantFiles) {
    violations.push(...scanTenantFigureLeak(file));
  }
  if (input.fleetDoc) {
    violations.push(...scanFleetCapacityDoc(input.fleetDoc.path, input.fleetDoc.content));
  }
  if (input.capacityDocs) {
    violations.push(...scanTenThousandClaims(input.capacityDocs));
  }
  return violations;
}

function readTenantFiles(): SourceFile[] {
  return resolveFiles(CAPACITY_GATE_TENANT_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

function readCapacityDocs(): SourceFile[] {
  return resolveFiles(CAPACITY_DOC_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

/** A missing fleet-capacity.md is itself a violation - the gate must never pass on an absent doc. */
function readFleetDoc(): SourceFile {
  const fullPath = path.join(REPO_ROOT, FLEET_CAPACITY_DOC_PATH);
  let content: string;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch {
    content = '';
  }
  return { path: FLEET_CAPACITY_DOC_PATH, content };
}

export function runCheckCapacityGate(): GuardResult {
  const docContent = readFileSync(path.join(REPO_ROOT, SESSION_COST_DOC_PATH), 'utf8');
  const tenantFiles = readTenantFiles();
  const fleetDoc = readFleetDoc();
  const capacityDocs = readCapacityDocs();

  const violations = scanCapacityGate({
    docPath: SESSION_COST_DOC_PATH,
    docContent,
    tenantFiles,
    fleetDoc,
    capacityDocs,
  });

  if (fleetDoc.content === '') {
    violations.push({
      file: FLEET_CAPACITY_DOC_PATH,
      message: 'capacity gate: fleet-capacity.md is missing from disk - Gate B doc must exist',
    });
  }

  return { violations, filesScanned: 1 + tenantFiles.length + 1 + capacityDocs.length };
}

function main(): void {
  const result = runCheckCapacityGate();

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      const location =
        violation.line === undefined
          ? violation.file
          : `${violation.file}:${String(violation.line)}`;
      console.error(`check-capacity-gate: ${location} - ${violation.message}`);
    }
    process.exit(1);
  }

  console.log(
    `check-capacity-gate: ${String(result.filesScanned ?? 0)} file(s) scanned, 0 violations`,
  );
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
