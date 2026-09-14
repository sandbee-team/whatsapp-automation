import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BANNED_CLAIMS,
  SAFE_MODE_DISCLAIMER,
  BROADCAST_DISCLOSURE,
  GROUP_RISK_DISCLOSURE,
} from '@wp/domain';
import { REPO_ROOT, SCAN_GLOBS, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';
import { scanPublicCapacityClaims, readMeasuredN } from './guards/copy-public-capacity-lib.js';

/**
 * check-copy.ts (P00 step 9, core invariant 6: honest product, no
 * restriction-avoidance promises) - the copy guard. Five clauses:
 *
 * (a) banned claims - a case-insensitive substring match of any phrase in
 *     `BANNED_CLAIMS` (imported from `@wp/domain`, never hand-copied here).
 *     Both haystack and needles are normalized first (smart quotes/dashes ->
 *     ASCII, horizontal whitespace collapsed) so a curly-quote/em-dash/NBSP
 *     variant cannot dodge the match - see `normalizeCopyText`.
 * (b) a surface string naming the pacing feature (capitalized two-word
 *     product name) must also ship `SAFE_MODE_DISCLAIMER` verbatim in the
 *     same file.
 * (c) a surface string naming the fan-out send feature (capitalized product
 *     name, word-boundary) must also ship `BROADCAST_DISCLOSURE` verbatim in
 *     the same file. Lowercase generic uses of the same English word (e.g. a
 *     comment about "broadcast-style fan-out") are NOT the product name and
 *     must not trigger this clause - hence the case-sensitive word-boundary
 *     match, proved clean by `__fixtures__/copy/lowercase-broadcast-ok.ts`.
 * (d) a surface string naming WhatsApp Groups (capitalized "Group"/"Groups",
 *     or the Hindi "समूह") must also ship `GROUP_RISK_DISCLOSURE` verbatim in
 *     the same file - SCOPED to copy surfaces only
 *     (`packages/i18n/src/catalogues/`, `packages/domain/src/copy/`,
 *     `website/`, `admin/`, `app/frontend/src/`), because the capitalised
 *     English word appears legitimately in backend/scripts comments unrelated
 *     to real user-facing copy (e.g. "Group by tenant"). Same case-sensitive
 *     word-boundary discipline as clause (c).
 * (e) a derived capacity/cost figure (session/account counts, per-unit
 *     dollar costs, memory figures, throughput, latency percentiles, box
 *     sizing) quoted on a PUBLIC surface (`website/`) - see
 *     `guards/copy-public-capacity-lib.ts`. Gate C is not closed, so the
 *     ONLY permitted capacity sentence on a public page is the exact ADR
 *     0018 §8 sentence built from the LIVE `Measured N` in
 *     `docs/capacity/fleet-capacity.md`, read at run time (never
 *     hardcoded) - a read failure fails closed (no sentence permitted at
 *     all).
 *
 * The product-name tokens below are built by concatenation, not as a
 * contiguous literal: a contiguous literal would make this guard's own
 * source "contain" the token it searches for, forcing this file to also
 * ship the matching disclosure/disclaimer just to pass its own clause
 * (b)/(c) - a self-referential trap, not a real exemption.
 */

const PACING_FEATURE_TOKEN = ['Safe', 'Mode'].join(' ');
const BROADCAST_FEATURE_TOKEN = ['Broad', 'cast'].join('');
const BROADCAST_FEATURE_PATTERN = new RegExp(`\\b${BROADCAST_FEATURE_TOKEN}\\b`);
const GROUP_FEATURE_TOKEN = ['Gro', 'up'].join('');
const GROUP_FEATURE_PATTERN = new RegExp(`\\b${GROUP_FEATURE_TOKEN}s?\\b|समूह`);

/** Clause (d) scope: copy surfaces only - a capitalized "Group" in a backend/scripts comment is not real user-facing copy. */
const GROUP_COPY_SURFACE_PREFIXES = [
  'packages/i18n/src/catalogues/',
  'packages/domain/src/copy/',
  'website/',
  'admin/',
  'app/frontend/src/',
];

function isGroupCopySurface(filePath: string): boolean {
  return GROUP_COPY_SURFACE_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

/** Text/copy-bearing extensions - the file universe this guard scans. */
const TEXT_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'mjs',
  'cjs',
  'md',
  'mdx',
  'json',
  'html',
  'yml',
  'yaml',
  'sql',
  'txt',
  'hbs',
  'csv',
];

/** The ADR 0014 shipped tree (`SCAN_GLOBS`), restricted to copy-bearing extensions. */
export const COPY_GLOBS = SCAN_GLOBS.map((root) => `${root}/*.{${TEXT_EXTENSIONS.join(',')}}`);

/**
 * ONE principled exemption, hard-coded here (not via the frozen
 * `CONTENT_EXCLUSIONS` lists): this file IS the ban list - it contains every
 * banned phrase by definition, so clause (a) alone is skipped for it. It is
 * NOT exempt from clauses (b)/(c).
 */
export const BANNED_CLAIMS_EXEMPT_FILES: readonly string[] = Object.freeze([
  'packages/domain/src/copy/banned-claims.ts',
]);

/**
 * Clause (d) pre-existing-file exemptions (P24 Unit U2): `notifications.ts`'s
 * `group_forbidden.title` and `hi.ts`'s `messages.compose.
 * recipientDescription` predate this clause and use "Group"/"समूह" generically,
 * not as a group-sending-risk mention - a narrow, two-entry exemption rather
 * than disabling clause (d) over a whole scope prefix.
 */
export const GROUP_DISCLOSURE_EXEMPT_FILES: readonly string[] = Object.freeze([
  'packages/domain/src/copy/notifications.ts',
  'packages/i18n/src/catalogues/hi.ts',
]);

export interface SourceFile {
  path: string;
  content: string;
}

function lineOfIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

const SMART_SINGLE_QUOTE = /[‘’]/g;
const SMART_DOUBLE_QUOTE = /[“”]/g;
const SMART_DASH = /[–—]/g;
/** Horizontal whitespace only (space, tab, NBSP) - newlines are untouched. */
const REPEATED_HORIZONTAL_WHITESPACE = /[ \t\u00A0]+/g;

/**
 * MAJOR 6: normalizes smart quotes/dashes/whitespace so clause (a) (banned
 * claims) cannot be dodged by a curly-quote or en/em-dash variant of a
 * banned phrase. Newlines are deliberately left untouched - callers split
 * on `\n` first and rely on line count for violation reporting.
 */
function normalizeCopyText(text: string): string {
  return text
    .replace(SMART_SINGLE_QUOTE, "'")
    .replace(SMART_DOUBLE_QUOTE, '"')
    .replace(SMART_DASH, '-')
    .replace(REPEATED_HORIZONTAL_WHITESPACE, ' ');
}

function scanBannedClaims(file: SourceFile, claims: readonly string[]): GuardViolation[] {
  if (BANNED_CLAIMS_EXEMPT_FILES.includes(file.path)) {
    return [];
  }

  const normalizedClaims = claims.map((claim) => ({
    original: claim,
    normalized: normalizeCopyText(claim).toLowerCase(),
  }));

  const violations: GuardViolation[] = [];
  const lines = file.content.split('\n');
  lines.forEach((line, index) => {
    const normalizedLine = normalizeCopyText(line).toLowerCase();
    for (const { original, normalized } of normalizedClaims) {
      if (normalizedLine.includes(normalized)) {
        violations.push({
          file: file.path,
          line: index + 1,
          message: `banned claim "${original}" - invariant 6 (honest product, no restriction-avoidance promises)`,
        });
      }
    }
  });
  return violations;
}

function scanPacingFeatureCoPresence(file: SourceFile): GuardViolation[] {
  const tokenIndex = file.content.indexOf(PACING_FEATURE_TOKEN);
  if (tokenIndex === -1) return [];
  if (file.content.includes(SAFE_MODE_DISCLAIMER)) return [];

  return [
    {
      file: file.path,
      line: lineOfIndex(file.content, tokenIndex),
      message: `"${PACING_FEATURE_TOKEN}" mentioned without the required disclaimer text in the same file`,
    },
  ];
}

function scanBroadcastFeatureCoPresence(file: SourceFile): GuardViolation[] {
  const match = BROADCAST_FEATURE_PATTERN.exec(file.content);
  if (!match) return [];
  if (file.content.includes(BROADCAST_DISCLOSURE)) return [];

  return [
    {
      file: file.path,
      line: lineOfIndex(file.content, match.index),
      message: `"${BROADCAST_FEATURE_TOKEN}" mentioned without the required disclosure text in the same file`,
    },
  ];
}

function scanGroupFeatureCoPresence(file: SourceFile): GuardViolation[] {
  if (!isGroupCopySurface(file.path)) return [];
  if (GROUP_DISCLOSURE_EXEMPT_FILES.includes(file.path)) return [];

  const match = GROUP_FEATURE_PATTERN.exec(file.content);
  if (!match) return [];
  if (file.content.includes(GROUP_RISK_DISCLOSURE)) return [];

  return [
    {
      file: file.path,
      line: lineOfIndex(file.content, match.index),
      message: `"${GROUP_FEATURE_TOKEN}" mentioned without the required disclosure text in the same file`,
    },
  ];
}

export interface ScanCopyOptions {
  /** The live Gate C `Measured N` (e.g. "1,000"), or undefined to fail closed. */
  measuredN?: string;
}

/**
 * Pure core - no filesystem access. `claims` is normally `BANNED_CLAIMS`
 * (passed in, never hardcoded here) so tests can exercise clause (a) with
 * the real list without touching disk. `options.measuredN` is optional so
 * every existing two-argument caller keeps compiling unchanged.
 */
export function scanCopy(
  files: SourceFile[],
  claims: readonly string[],
  options?: ScanCopyOptions,
): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const file of files) {
    violations.push(...scanBannedClaims(file, claims));
    violations.push(...scanPacingFeatureCoPresence(file));
    violations.push(...scanBroadcastFeatureCoPresence(file));
    violations.push(...scanGroupFeatureCoPresence(file));
    violations.push(...scanPublicCapacityClaims(file, options?.measuredN));
  }
  return violations;
}

function readSourceFiles(): SourceFile[] {
  return resolveFiles(COPY_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

/**
 * Reads the live Gate C `Measured N` from the fleet-capacity doc. ANY read
 * error (missing file, bad permissions) resolves to `undefined`, which is
 * fail-closed: `scanPublicCapacityClaims` then permits NO capacity sentence
 * at all on a public surface, rather than trusting a stale/absent number.
 */
function readLiveMeasuredN(): string | undefined {
  try {
    const docText = readFileSync(path.join(REPO_ROOT, 'docs/capacity/fleet-capacity.md'), 'utf8');
    return readMeasuredN(docText);
  } catch {
    return undefined;
  }
}

export function runCheckCopy(): GuardResult {
  const files = readSourceFiles();
  const measuredN = readLiveMeasuredN();
  return { violations: scanCopy(files, BANNED_CLAIMS, { measuredN }), filesScanned: files.length };
}

function main(): void {
  const files = readSourceFiles();
  const measuredN = readLiveMeasuredN();
  const violations = scanCopy(files, BANNED_CLAIMS, { measuredN });

  if (violations.length > 0) {
    for (const violation of violations) {
      const location =
        violation.line === undefined
          ? violation.file
          : `${violation.file}:${String(violation.line)}`;
      console.error(`check-copy: ${location} - ${violation.message}`);
    }
    process.exit(1);
  }

  console.log(`check-copy: ${String(files.length)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
